"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSessionSlotKey } = require("../src/adapters/runtime/claudecode/session-slot");
const {
  buildProfileLaunch,
  fingerprintG3ProfileIdentity,
  fingerprintLaunchProfile,
  resolveG3PreflightEnabled,
  resolveG3ProfileContractEnabled,
  validateLaunchProfile,
} = require("../src/adapters/runtime/claudecode/launch-profile");
const { buildArgs, resolveEffectivePermissionMode } = require("../src/adapters/runtime/claudecode/process-client");
const { buildOpeningTurnText, loadInstructionFile } = require("../src/adapters/runtime/shared-instructions");
const {
  clearCliProbeCache,
  runG3LaunchPreflight,
} = require("../src/adapters/runtime/claudecode/g3-preflight");
const { canonicalWorkspaceKey } = require("../src/core/workspace-lock");
const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const { createTelegramProfileRouter } = require("../src/adapters/runtime/claudecode/telegram-profile-router");
const { buildTelegramRouteLane } = require("../src/core/route-lane");

const helper = path.join(__dirname, "helpers", "fake-claude-g3-help-cli.js");
const flagEnv = (extra = {}) => ({ ...process.env, CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED: "true", ...extra });

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-g3-"));
}

function profile(root, extra = {}) {
  return { profileId: "private-profile", cwd: root, configRoot: root, strictMcpConfig: true, ...extra };
}

function managedProfile(root, id) {
  const fable = id === "fable-chat";
  const cwd = path.join(root, fable ? "fable-workspace" : "engineering-workspace");
  const configRoot = path.join(root, fable ? "fable-config" : "engineering-config");
  const settings = path.join(root, fable ? "fable.settings.json" : "work.settings.json");
  const personaSource = path.join(root, fable ? "fable.role.md" : "work.role.md");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ fixture: id }), "utf8");
  fs.writeFileSync(personaSource, fable ? "FABLE_ROLE_SENTINEL" : "WORK_ENGINEERING_SENTINEL", "utf8");
  return {
    schemaVersion: 3,
    profileId: id,
    cwd,
    configRoot,
    harnessMode: fable ? "bare" : "engineering",
    settingSources: fable ? ["user"] : ["user", "project", "local"],
    skillsMode: fable ? "disabled" : "enabled",
    settings: [settings],
    personaSource,
    residentToolSchemas: fable ? ["cyberboss_system_send", "cyberboss_time"] : ["engineering-tools"],
    mcpServerCeiling: fable ? "chat-ceiling@1" : "work-ceiling@1",
    toolsetCeiling: fable ? "chat-ceiling@1" : "work-ceiling@1",
    defaultMcpServerSet: fable ? "chat-base@1" : "work-base@1",
    defaultToolset: fable ? "chat-core@1" : "work-full@1",
    strictMcpConfig: true,
    permissionMode: fable ? "profile-local-least-privilege" : "work-engineering-full",
    envPolicy: fable ? "chat-minimal" : "work-engineering",
  };
}

function withManagedProfileGate(run) {
  const previous = process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED;
  const previousPreflight = process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
  process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = "true";
  try { return run(); } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED;
    else process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED = previous;
    if (previousPreflight === undefined) delete process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
    else process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = previousPreflight;
  }
}

test("T04 A1/A2 managed identities bind harness, role source, permission identity and ceilings into slots", () => {
  const root = tempRoot();
  try {
    withManagedProfileGate(() => {
      assert.equal(resolveG3ProfileContractEnabled(), true);
      const fable = validateLaunchProfile(managedProfile(root, "fable-chat"), { baseDir: root });
      const work = validateLaunchProfile(managedProfile(root, "work-engineering"), { baseDir: root });
      const fableLaunch = buildProfileLaunch({ profile: fable, baseEnv: {}, baseCwd: root, baseDir: root });
      const workLaunch = buildProfileLaunch({ profile: work, baseEnv: {}, baseCwd: root, baseDir: root });
      assert.deepEqual(fableLaunch.args.slice(0, 5), ["--bare", "--disable-slash-commands", "--setting-sources", "user", "--settings"]);
      assert.equal(workLaunch.args.includes("--bare"), false);
      assert.equal(workLaunch.args.includes("--disable-slash-commands"), false);
      assert.equal(loadInstructionFile(fable.personaSource).includes("WORK_ENGINEERING_SENTINEL"), false);
      assert.equal(loadInstructionFile(work.personaSource).includes("WORK_ENGINEERING_SENTINEL"), true);
      const opening = buildOpeningTurnText(
        { channel: "telegram", weixinInstructionsFile: work.personaSource },
        "hello",
        { roleCard: loadInstructionFile(fable.personaSource) },
      );
      assert.equal(opening.includes("FABLE_ROLE_SENTINEL"), true);
      assert.equal(opening.includes("WORK_ENGINEERING_SENTINEL"), false);

      const base = fingerprintG3ProfileIdentity(fable);
      const variants = [
        { ...fable, cwd: work.cwd },
        { ...fable, configRoot: work.configRoot },
        { ...fable, permissionMode: "rotated-permission-identity" },
        { ...fable, mcpServerCeiling: "rotated-mcp-ceiling" },
        { ...fable, toolsetCeiling: "rotated-tool-ceiling" },
      ];
      for (const variant of variants) {
        const changed = fingerprintG3ProfileIdentity(variant);
        assert.notEqual(changed, base);
        assert.notEqual(
          buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane", profileFingerprint: changed }),
          buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane", profileFingerprint: base }),
        );
      }
      fs.writeFileSync(fable.personaSource, "FABLE_ROLE_SENTINEL_CHANGED", "utf8");
      assert.notEqual(fingerprintG3ProfileIdentity(fable), base, "persona content change rotates identity");
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("T04 A6 global bypassPermissions cannot cross the fable permission identity", () => {
  const root = tempRoot();
  try {
    withManagedProfileGate(() => {
      const launch = buildProfileLaunch({ profile: managedProfile(root, "fable-chat"), baseEnv: {}, baseCwd: root, baseDir: root });
      const effective = resolveEffectivePermissionMode(launch.permissionMode, "bypassPermissions");
      const args = buildArgs({ permissionMode: effective, disableVerbose: true, extraArgs: [], mcpConfigPaths: [], emitEffort: false });
      assert.equal(effective, "default");
      assert.equal(args.includes("bypassPermissions"), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("T04 A7/A8 contract gate off is byte-compatible and launch trace is tokenized", () => {
  const root = tempRoot();
  try {
    assert.equal(resolveG3ProfileContractEnabled({}), false);
    const input = { profile: { profileId: "baseline", cwd: root }, baseEnv: { PATH: "fixture", CUSTOM: "unchanged" }, baseCwd: root, baseDir: root };
    const launch = buildProfileLaunch(input);
    assert.deepEqual({ args: launch.args, env: launch.env, cwd: launch.cwd }, { args: [], env: input.baseEnv, cwd: root });
    const previousContract = process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED;
    const previousPreflight = process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
    process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED = "true";
    delete process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
    try {
      assert.throws(
        () => validateLaunchProfile(managedProfile(root, "fable-chat"), { baseDir: root }),
        (error) => error.code === "g3_preflight_required",
      );
    } finally {
      if (previousContract === undefined) delete process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED;
      else process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED = previousContract;
      if (previousPreflight === undefined) delete process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
      else process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = previousPreflight;
    }
    withManagedProfileGate(() => {
      const rawManaged = managedProfile(root, "fable-chat");
      const managed = buildProfileLaunch({ profile: rawManaged, baseEnv: {}, baseCwd: root, baseDir: root });
      const trace = JSON.stringify(managed.telemetry);
      assert.equal(trace.includes(root), false);
      assert.equal(trace.includes("fable-chat"), false);
      assert.equal(trace.includes("FABLE_ROLE_SENTINEL"), false);
      assert.equal(managed.telemetry.profile_schema_version, 3);
      assert.equal(managed.telemetry.permission_mode, "profile-local-least-privilege");
      let caught;
      try {
        createTelegramProfileRouter({
          profilesJson: JSON.stringify({ "fable-chat": { ...rawManaged, envPolicy: "planted-private-profile-value" } }),
          baseDir: root,
        });
      } catch (error) { caught = error; }
      assert.equal(caught?.code, "invalid_enum");
      const failure = JSON.stringify({ message: caught?.message, code: caught?.code, details: caught?.details });
      assert.equal(failure.includes("fable-chat"), false);
      assert.equal(failure.includes(root), false);
      assert.equal(failure.includes("planted-private-profile-value"), false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A0/A16 gate defaults off and preserves baseline launch byte-for-byte", () => {
  const root = tempRoot();
  try {
    assert.equal(resolveG3PreflightEnabled({}), false);
    const input = { profile: { profileId: "p", cwd: root }, baseEnv: { PATH: "x", CUSTOM: "y" }, baseCwd: root, baseDir: root };
    const baseline = buildProfileLaunch(input);
    assert.deepEqual({ args: baseline.args, env: baseline.env, cwd: baseline.cwd },
      { args: [], env: input.baseEnv, cwd: root });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A1/A2 configRoot canonical identity controls fingerprint and slot", () => {
  const root = tempRoot();
  const other = tempRoot();
  const previous = process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
  process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = "true";
  try {
    const a = profile(root);
    const equivalent = profile(path.join(root, "."));
    const b = profile(other);
    const fa = fingerprintLaunchProfile(a, { baseDir: root });
    const fe = fingerprintLaunchProfile(equivalent, { baseDir: root });
    const fb = fingerprintLaunchProfile(b, { baseDir: root });
    assert.equal(fa, fe);
    assert.notEqual(fa, fb);
    const slot = (fingerprint) => buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane", profileFingerprint: fingerprint });
    assert.equal(slot(fa), slot(fe));
    assert.notEqual(slot(fa), slot(fb));
  } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
    else process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = previous;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
  }
});

test("A3/A5/A12/A13 allowlisted launch passes fake CLI and auth", async () => {
  const root = tempRoot();
  try {
    clearCliProbeCache();
    const result = await runG3LaunchPreflight({
      profile: profile(root), baseEnv: flagEnv({ PATH: process.env.PATH, AWS_SECRET_ACCESS_KEY: "fake-secret" }),
      baseCwd: root, baseDir: root, expectedLockPath: path.join(root, "."),
      command: process.execPath, commandPrefixArgs: [helper], authProbe: async () => ({ ok: true }),
    });
    assert.equal(canonicalWorkspaceKey(result.launch.cwd), canonicalWorkspaceKey(root));
    assert.equal(result.cli.missing_flags.length, 0);
    assert.equal(result.launch.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(result.launch.env.CLAUDE_CONFIG_DIR, canonicalWorkspaceKey(root));
    await assert.rejects(runG3LaunchPreflight({
      profile: profile(root), baseEnv: flagEnv(), baseCwd: root, baseDir: root,
      expectedLockPath: os.tmpdir(), command: process.execPath, commandPrefixArgs: [helper],
      authProbe: async () => ({ ok: true }),
    }), (error) => error.code === "cwd_lock_mismatch");
    assert.deepEqual(Object.keys(result.launch.telemetry).sort(), [
      "cli_help_hash", "cli_version", "config_root_token", "cwd_source", "env_policy",
      "native_session_present", "profile_schema_version", "profile_token", "session_slot_token", "strict_mcp",
    ].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A4 missing required flags fail closed with stable code", async () => {
  const root = tempRoot();
  try {
    for (const missing of ["--strict-mcp-config", "--bare", "--setting-sources"]) {
      clearCliProbeCache();
      await assert.rejects(runG3LaunchPreflight({
        profile: profile(root), baseEnv: flagEnv(), baseCwd: root,
        baseDir: root, expectedLockPath: root, command: process.execPath, commandPrefixArgs: [helper, `--missing=${missing}`],
        authProbe: async () => ({ ok: true }),
      }), (error) => error.code === "cli_required_flags_missing" && error.details.missing_flags.includes(missing));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A6/A7/A8/A9/A14 fail-closed codes", async () => {
  const root = tempRoot();
  try {
    const common = { baseEnv: flagEnv(), baseCwd: root, baseDir: root, expectedLockPath: root,
      command: process.execPath, commandPrefixArgs: [helper], authProbe: async () => ({ ok: true }) };
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root, { env: { UNKNOWN_ENV: "x" } }) }), (e) => e.code === "env_not_allowed");
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root, { env: { CLAUDE_CONFIG_DIR: "x" } }) }), (e) => e.code === "config_root_env_conflict");
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root, { configDir: root }) }), (e) => e.code === "config_root_conflict");
    clearCliProbeCache();
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root), authProbe: async () => ({ ok: false }) }), (e) => e.code === "auth_probe_failed");
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root), extraArgs: ["--tools=none"] }), (e) => e.code === "forbidden_raw_extra_args");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A11 failures do not disclose secret, path, or raw profile id", async () => {
  const root = tempRoot();
  // Deliberately NOT shaped like a real credential: the secret-audit CI gate
  // scans every reachable blob with no placeholder exemption, so an sk-style
  // fake would trip it forever once merged. The assertion only needs a unique
  // value to prove non-disclosure.
  const plantedValue = "planted-nondisclosure-canary-0000";
  try {
    let caught;
    try {
      await runG3LaunchPreflight({ profile: profile(root, { env: { UNKNOWN_ENV: plantedValue } }), baseEnv: flagEnv(), baseCwd: root, baseDir: root, expectedLockPath: root });
    } catch (error) { caught = error; }
    const text = JSON.stringify({ message: caught.message, code: caught.code, details: caught.details });
    assert.equal(text.includes(plantedValue), false);
    assert.equal(text.includes(root), false);
    assert.equal(text.includes("private-profile"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A10 failed target preflight leaves the live legacy process and session untouched", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  fs.mkdirSync(workspace); fs.mkdirSync(state);
  const log = path.join(root, "launches.jsonl");
  fs.writeFileSync(log, "");
  const saved = { ...process.env };
  process.env.CB_FAKE_LAUNCH_LOG = log;
  process.env.CB_FAKE_COUNTER = path.join(root, "counter");
  process.env.CB_FAKE_KEEP_ALIVE = "1";
  delete process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED;
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir: state, sessionsFile: path.join(root, "sessions.json"),
    claudeSessionSlotsFile: path.join(state, "slots.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [path.join(__dirname, "helpers", "fake-claude-cli.js")],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: root,
    claudeG3AuthProbe: async () => ({ ok: false }),
  });
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 500, messageThreadId: 10 });
  try {
    await adapter.sendTurn({ bindingKey: "binding", senderId: "500", workspaceRoot: workspace, lane, text: "old" });
    const beforeEntry = adapter.__internals.processRegistry.listEntries()[0];
    const beforeSession = beforeEntry.client.sessionId;
    const beforeChild = beforeEntry.client.child;
    const beforeLaunches = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
    process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = "true";
    clearCliProbeCache();
    await assert.rejects(adapter.sendTurn({
      bindingKey: "binding", senderId: "500", workspaceRoot: workspace, lane, text: "target",
      launchProfile: profile(workspace),
    }), (error) => error.code === "auth_probe_failed");
    const afterEntries = adapter.__internals.processRegistry.listEntries();
    assert.equal(afterEntries.length, 1);
    assert.equal(afterEntries[0].client.sessionId, beforeSession);
    assert.equal(afterEntries[0].client.child, beforeChild);
    assert.equal(beforeChild.exitCode, null);
    assert.equal(fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).length, beforeLaunches);
  } finally {
    await adapter.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
