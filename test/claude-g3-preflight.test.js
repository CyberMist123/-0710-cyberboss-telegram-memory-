"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildSessionSlotKey } = require("../src/adapters/runtime/claudecode/session-slot");
const {
  buildProfileLaunch,
  fingerprintG3ProfileIdentity,
  fingerprintLaunchProfile,
  g3ContractDefaults,
  resolveG3PreflightEnabled,
  resolveG3ProfileContractEnabled,
  stableStringify,
  validateLaunchProfile,
} = require("../src/adapters/runtime/claudecode/launch-profile");
const {
  ClaudeCodeProcessClient,
  assertNoLaunchDrift,
  buildArgs,
  resolveEffectivePermissionMode,
} = require("../src/adapters/runtime/claudecode/process-client");
const {
  buildInstructionRefreshText,
  buildOpeningTurnText,
  loadInstructionFile,
} = require("../src/adapters/runtime/shared-instructions");
const {
  clearCliProbeCache,
  runDefaultAuthProbe,
  runG3LaunchPreflight,
} = require("../src/adapters/runtime/claudecode/g3-preflight");
const { resolveWindowOverride } = require("../src/adapters/runtime/claudecode/window-override");
const { canonicalWorkspaceKey } = require("../src/core/workspace-lock");
const { readConfig } = require("../src/core/config");
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
    harnessMode: fable ? "chat-subscription" : "engineering",
    settingSources: fable ? ["user"] : ["user", "project", "local"],
    skillsMode: fable ? "disabled" : "enabled",
    settings: [settings],
    personaSource,
    ...(fable ? { builtInTools: ["Read", "WebFetch"], escalatedBuiltInTools: ["default"] } : {}),
    strictMcpConfig: true,
    permissionMode: fable ? "chat-native-bypass" : "work-engineering-full",
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
      assert.throws(
        () => g3ContractDefaults("unknown-profile"),
        (error) => error.code === "g3_profile_identity_unknown",
      );
      const fableInput = managedProfile(root, "fable-chat");
      fs.writeFileSync(fableInput.personaSource, "\r\n  FABLE_ROLE_SENTINEL  \n", "utf8");
      const fable = validateLaunchProfile(fableInput, { baseDir: root });
      const work = validateLaunchProfile(managedProfile(root, "work-engineering"), { baseDir: root });
      const fableLaunch = buildProfileLaunch({ profile: fable, baseEnv: {}, baseCwd: root, baseDir: root });
      const workLaunch = buildProfileLaunch({ profile: work, baseEnv: {}, baseCwd: root, baseDir: root });
      // The chat harness authenticates with the subscription login in its own
      // config root, so it must NOT pass --bare (under which the CLI reads
      // neither OAuth nor the keychain) while still delivering the persona as
      // the system prompt.
      assert.equal(fableLaunch.args.includes("--bare"), false);
      assert.deepEqual(fableLaunch.args.slice(0, 4), ["--disable-slash-commands", "--setting-sources", "user", "--system-prompt"]);
      assert.equal(fableLaunch.args[fableLaunch.args.indexOf("--system-prompt") + 1], "FABLE_ROLE_SENTINEL");
      assert.deepEqual(
        fableLaunch.args.slice(fableLaunch.args.indexOf("--tools"), fableLaunch.args.indexOf("--tools") + 2),
        ["--tools", "Read,WebFetch"],
      );
      assert.equal(fableLaunch.telemetry.tool_face, "default");
      assert.equal(fableLaunch.telemetry.built_in_tool_count, 2);
      assert.equal(fableLaunch.permissionMode, "bypassPermissions");
      assert.equal(workLaunch.args.includes("--bare"), false);
      assert.equal(workLaunch.args.includes("--disable-slash-commands"), false);
      assert.equal(workLaunch.args.includes("--system-prompt"), false);
      assert.equal(workLaunch.permissionMode, "inherit");
      assert.equal(loadInstructionFile(fable.personaSource).includes("WORK_ENGINEERING_SENTINEL"), false);
      assert.equal(loadInstructionFile(work.personaSource).includes("WORK_ENGINEERING_SENTINEL"), true);
      assert.equal(fableLaunch.telemetry.persona_prompt_chars, "FABLE_ROLE_SENTINEL".length);
      assert.equal(fableLaunch.telemetry.instruction_source, "persona_system_prompt");
      assert.equal(workLaunch.telemetry.persona_prompt_chars, 0);
      assert.equal(workLaunch.telemetry.instruction_source, "role_card");
      assert.equal(JSON.stringify(fableLaunch.telemetry).includes("FABLE_ROLE_SENTINEL"), false);

      const base = fingerprintG3ProfileIdentity(fable);
      const variants = [
        { ...fable, cwd: work.cwd },
        { ...fable, configRoot: work.configRoot },
        { ...fable, permissionMode: "rotated-permission-identity" },
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

      const digest = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
      const expectedIdentity = {
        schemaVersion: fable.schemaVersion,
        profileId: fable.profileId,
        cwd: fable.cwd,
        configRoot: fable.configRoot,
        harnessMode: fable.harnessMode,
        settingSources: fable.settingSources,
        skillsMode: fable.skillsMode,
        settings: fable.settings.map(digest),
        persona: digest(fable.personaSource),
        mcpServerCeiling: "chat-ceiling@2",
        toolsetCeiling: "chat-ceiling@1",
        permissionMode: fable.permissionMode,
        envPolicy: "chat-minimal",
      };
      assert.equal(
        fingerprintG3ProfileIdentity(fable),
        crypto.createHash("sha256").update(stableStringify(expectedIdentity), "utf8").digest("hex"),
        "G3 identity retains the pre-cleanup derived values byte-for-byte",
      );
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("fable-chat resolves its native bypass permission through the process client", () => {
  const root = tempRoot();
  try {
    withManagedProfileGate(() => {
      const launch = buildProfileLaunch({ profile: managedProfile(root, "fable-chat"), baseEnv: {}, baseCwd: root, baseDir: root });
      const effective = resolveEffectivePermissionMode(launch.permissionMode, "default");
      const args = buildArgs({ permissionMode: effective, disableVerbose: true, extraArgs: [], mcpConfigPaths: [], emitEffort: false });
      assert.equal(effective, "bypassPermissions");
      assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), [
        "--permission-mode", "bypassPermissions",
      ]);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed persona is the sole bounded system-prompt source and fails closed at launch", () => {
  const root = tempRoot();
  try {
    withManagedProfileGate(() => {
      for (const field of ["systemPrompt", "outputStyle"]) {
        assert.throws(
          () => validateLaunchProfile({ ...managedProfile(root, "fable-chat"), [field]: "duplicate" }, { baseDir: root }),
          (error) => error.code === "g3_persona_owns_system_prompt",
        );
      }

      const staleFields = [
        "residentToolSchemas", "mcpServerCeiling", "toolsetCeiling", "envPolicy", "defaultToolset", "defaultMcpServerSet",
      ];
      for (const field of staleFields) {
        assert.throws(
          () => validateLaunchProfile({
            ...managedProfile(root, "fable-chat"),
            [field]: field === "residentToolSchemas" ? [] : "stale",
          }, { baseDir: root }),
          (error) => error.code === "unknown_field",
        );
      }
      assert.throws(
        () => validateLaunchProfile({ ...managedProfile(root, "fable-chat"), permissionMode: "profile-local-least-privilege" }, { baseDir: root }),
        (error) => error.code === "invalid_enum",
      );

      const blank = managedProfile(root, "fable-chat");
      fs.writeFileSync(blank.personaSource, " \r\n\t", "utf8");
      assert.throws(
        () => buildProfileLaunch({ profile: blank, baseEnv: {}, baseCwd: root, baseDir: root }),
        (error) => error.code === "persona_prompt_empty",
      );

      const oversized = managedProfile(root, "fable-chat");
      fs.writeFileSync(oversized.personaSource, "x".repeat(24577), "utf8");
      assert.throws(
        () => buildProfileLaunch({ profile: oversized, baseEnv: {}, baseCwd: root, baseDir: root }),
        (error) => error.code === "persona_prompt_too_long",
      );

      const removed = validateLaunchProfile(managedProfile(root, "fable-chat"), { baseDir: root });
      fs.unlinkSync(removed.personaSource);
      assert.throws(
        () => buildProfileLaunch({ profile: removed, baseEnv: {}, baseCwd: root, baseDir: root }),
        (error) => error.code === "persona_source_unreadable",
      );
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("bare opening and refresh keep hard context while suppressing role and ambient instructions", () => {
  const root = tempRoot();
  try {
    const ambientInstructions = path.join(root, "ambient-instructions.md");
    fs.writeFileSync(ambientInstructions, "AMBIENT_WECHAT_SENTINEL", "utf8");
    const config = { channel: "telegram", weixinInstructionsFile: ambientInstructions };
    const currentState = { text: "CURRENT_STATE_SENTINEL", hash: "b".repeat(64), chars: 22 };
    const opening = buildOpeningTurnText(config, "USER_MESSAGE_SENTINEL", {
      personaInSystemPrompt: true,
      reentry: { text: "REENTRY_SENTINEL", hash: "a".repeat(64), chars: 16 },
      currentState,
    });
    assert.equal(opening.includes("PROFILE ROLE"), false);
    assert.equal(opening.includes("SESSION INSTRUCTIONS"), false);
    assert.equal(opening.includes("AMBIENT_WECHAT_SENTINEL"), false);
    assert.equal(opening.includes("REENTRY_SENTINEL"), true);
    assert.equal(opening.includes("CURRENT_STATE_SENTINEL"), true);
    assert.equal(opening.endsWith("Current user message:\nUSER_MESSAGE_SENTINEL"), true);

    const workOpening = buildOpeningTurnText(config, "WORK_USER_SENTINEL", {
      roleCard: "WORK_ROLE_SENTINEL",
    });
    assert.equal(workOpening.includes("PROFILE ROLE"), true);
    assert.equal(workOpening.includes("WORK_ROLE_SENTINEL"), true);
    assert.equal(workOpening.includes("AMBIENT_WECHAT_SENTINEL"), false);

    const refresh = buildInstructionRefreshText(config, { personaInSystemPrompt: true, currentState });
    assert.equal(refresh.includes("AMBIENT_WECHAT_SENTINEL"), false);
    assert.equal(refresh.includes("CURRENT_STATE_SENTINEL"), true);
    assert.equal(refresh.includes("Reply in one short Chinese sentence"), true);
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
      assert.equal(managed.telemetry.permission_mode, "chat-native-bypass");
      let caught;
      try {
        createTelegramProfileRouter({
          profilesJson: JSON.stringify({ "fable-chat": { ...rawManaged, envPolicy: "planted-private-profile-value" } }),
          baseDir: root,
        });
      } catch (error) { caught = error; }
      assert.equal(caught?.code, "unknown_field");
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
    // Raw extraArgs are refused by the profile builder itself now that the gate
    // passes them through unchanged, so the flag-name blocklist that used to
    // guess which ones mattered is gone: *any* non-empty extraArgs is refused.
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root), extraArgs: ["--tools=none"] }), (e) => e.code === "conflicting_args");
    await assert.rejects(runG3LaunchPreflight({ ...common, profile: profile(root), extraArgs: ["--effort", "medium"] }), (e) => e.code === "conflicting_args");
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

test("A15 default auth probe reads only loggedIn and carries the profile-exact config root", () => {
  const root = tempRoot();
  const authEnvLog = path.join(root, "probe-env.txt");
  const configRoot = path.join(root, "isolated-config");
  try {
    const ok = runDefaultAuthProbe({
      command: process.execPath, commandPrefixArgs: [helper],
      env: { ...process.env, CB_FAKE_AUTH: "logged-in", CB_FAKE_AUTH_ENV_LOG: authEnvLog, CLAUDE_CONFIG_DIR: configRoot },
      cwd: root,
    });
    assert.deepEqual(ok, { ok: true });
    // proves the probe invoked the CLI against exactly the isolated config root
    assert.equal(fs.readFileSync(authEnvLog, "utf8"), configRoot);
    // every not-signed-in shape (false / nonzero exit / unparseable) is ok:false
    for (const mode of ["logged-out", "nonzero", "garbage"]) {
      const bad = runDefaultAuthProbe({
        command: process.execPath, commandPrefixArgs: [helper],
        env: { ...process.env, CB_FAKE_AUTH: mode, CLAUDE_CONFIG_DIR: configRoot }, cwd: root,
      });
      assert.deepEqual(bad, { ok: false }, `mode ${mode}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A15 default probe is wired through the profiled launch path and passes when signed in", async () => {
  const root = tempRoot();
  try {
    clearCliProbeCache();
    // No authProbe injected: this is the exact production assembly that shipped
    // with config.claudeG3AuthProbe undefined and fail-closed on every launch.
    const result = await runG3LaunchPreflight({
      profile: profile(root), baseEnv: flagEnv({ PATH: process.env.PATH }),
      baseCwd: root, baseDir: root, expectedLockPath: root,
      command: process.execPath, commandPrefixArgs: [helper],
    });
    assert.equal(canonicalWorkspaceKey(result.launch.cwd), canonicalWorkspaceKey(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A15 default probe through the profiled launch path fails closed when the config root is not signed in", async () => {
  const base = tempRoot();
  const root = path.join(base, "loggedout-config");
  fs.mkdirSync(root, { recursive: true });
  try {
    clearCliProbeCache();
    await assert.rejects(runG3LaunchPreflight({
      profile: profile(root), baseEnv: flagEnv({ PATH: process.env.PATH }),
      baseCwd: root, baseDir: root, expectedLockPath: root,
      command: process.execPath, commandPrefixArgs: [helper],
    }), (error) => error.code === "auth_probe_failed");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("A15 runtime adapter assembly uses the default probe when none is configured", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  fs.mkdirSync(workspace); fs.mkdirSync(state);
  const log = path.join(root, "launches.jsonl");
  fs.writeFileSync(log, "");
  const saved = { ...process.env };
  process.env.CB_FAKE_LAUNCH_LOG = log;
  process.env.CB_FAKE_COUNTER = path.join(root, "counter");
  process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = "true";
  clearCliProbeCache();
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir: state, sessionsFile: path.join(root, "sessions.json"),
    claudeSessionSlotsFile: path.join(state, "slots.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [path.join(__dirname, "helpers", "fake-claude-cli.js")],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: root,
    // NOTE: no claudeG3AuthProbe -> the in-file default must carry the launch
  });
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 700, messageThreadId: 7 });
  try {
    await adapter.sendTurn({
      bindingKey: "binding", senderId: "700", workspaceRoot: workspace, lane, text: "hi",
      launchProfile: profile(workspace),
    });
    const entries = adapter.__internals.processRegistry.listEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].client.usable, true);
  } finally {
    await adapter.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T12 launch identity: the gate verifies the launch that is actually spawned.
//
// Every test below assembles the adapter in production shape -- a managed
// fable-chat profile whose `cwd` is NOT the configured agentCwd, a route-scoped
// MCP config, both deployment approvals on -- because that is precisely the
// combination the old preflight never saw (it hard-coded `extraArgs: []` and
// left four more inputs at their defaults).
// ---------------------------------------------------------------------------

function identityFixture() {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(workspace); fs.mkdirSync(state); fs.mkdirSync(memoryDir);
  const log = path.join(root, "launches.jsonl");
  fs.writeFileSync(log, "");
  return { root, workspace, state, memoryDir, log };
}

// Passed as prefix args rather than env: a profiled launch hands the child only
// the G3 host allowlist, so CB_FAKE_LAUNCH_LOG would never reach it.
function identityPrefixArgs(fixture) {
  return [
    path.join(__dirname, "helpers", "fake-claude-cli.js"),
    "--cb-launch-log", fixture.log,
    "--cb-counter", path.join(fixture.root, "counter"),
  ];
}

function startIdentityAdapter(fixture, { adapterOptions = {}, env = {} } = {}) {
  const saved = { ...process.env };
  process.env.CB_FAKE_LAUNCH_LOG = fixture.log;
  process.env.CB_FAKE_COUNTER = path.join(fixture.root, "counter");
  process.env.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED = "true";
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearCliProbeCache();
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir: fixture.state,
    sessionsFile: path.join(fixture.root, "sessions.json"),
    claudeSessionSlotsFile: path.join(fixture.state, "slots.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: identityPrefixArgs(fixture),
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: fixture.root,
    // The production defect in miniature: the deployment's agent cwd is the
    // memory directory, while the profile pins its own isolated workspace.
    agentCwd: fixture.memoryDir,
    claudeAllowCloudCredentialInheritance: true,
    claudeAllowAuthBackendOverride: true,
    claudeG3AuthProbe: async () => ({ ok: true }),
    ...adapterOptions,
  });
  const stop = async () => {
    await adapter.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  };
  return { adapter, stop };
}

function readLaunchLog(fixture) {
  return fs.readFileSync(fixture.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const identityLane = buildTelegramRouteLane({ accountId: "telegram", chatId: 900, messageThreadId: 3 });

test("T12 A1/A4/A6 the spawned child is byte-for-byte the launch the gate verified", async () => {
  const fixture = identityFixture();
  const { adapter, stop } = startIdentityAdapter(fixture);
  try {
    const profileInput = managedProfile(fixture.root, "fable-chat");
    await adapter.sendTurn({
      bindingKey: "binding", senderId: "900", workspaceRoot: fixture.workspace,
      lane: identityLane, launchProfile: profileInput, text: "hi",
    });
    const [entry] = adapter.__internals.processRegistry.listEntries();
    const verified = entry.client.g3Preflight.launch;

    // 1. the client spawned the gate's object, not one of its own
    assert.equal(entry.client.launchFingerprint, verified.launchFingerprint);

    const launches = readLaunchLog(fixture);
    assert.equal(launches.length, 1);
    const [launched] = launches;

    // 2. argv: the profile's verified args are the tail of what the child saw,
    //    and nothing else in argv duplicates them
    assert.deepEqual(launched.argv.slice(-verified.args.length), [...verified.args]);
    assert.equal(launched.argv.filter((arg) => arg === "--mcp-config").length,
      verified.args.filter((arg) => arg === "--mcp-config").length);
    assert.equal(launched.argv.filter((arg) => arg === "--system-prompt").length, 1);

    // 3. the route-scoped MCP config went through the gate (it used to be
    //    generated after the gate had already run)
    const mcpPath = verified.args[verified.args.indexOf("--mcp-config") + 1];
    assert.equal(mcpPath.includes(path.join("claude-mcp", "route-")), true);
    assert.equal(fs.existsSync(mcpPath), true);

    // 4. cwd and environment, observed from inside the child. The marker is a
    //    relative write by the child, so it can only appear under the directory
    //    the child was actually started in.
    assert.equal(fs.existsSync(path.join(verified.cwd, "cb-launch-cwd.marker")), true);
    const verifiedEnvKeys = Object.keys(verified.env).sort();
    for (const key of verifiedEnvKeys) {
      assert.equal(launched.envKeys.includes(key), true, `child is missing verified env key ${key}`);
    }
    // Everything the child has beyond the verified environment is injected by
    // libuv, which adds a fixed list of Windows variables to every child it
    // spawns (uv win/process.c `required_vars`) regardless of the env passed.
    // They are outside this runtime's control and carry no credential material;
    // the assertion pins the set so a genuine leak cannot hide among them.
    const libuvWindowsVars = new Set([
      "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE",
      "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
    ]);
    assert.deepEqual(
      launched.envKeys.filter((key) => !verifiedEnvKeys.includes(key) && !libuvWindowsVars.has(key)),
      [],
    );
  } finally { await stop(); }
});

test("T12 A2 raw extraArgs fail closed in the gate and spawn nothing", async () => {
  const fixture = identityFixture();
  const { adapter, stop } = startIdentityAdapter(fixture, {
    // Exactly the production value that reached spawn time as `conflicting_args`
    adapterOptions: { claudeExtraArgs: ["--effort", "medium"] },
  });
  try {
    await assert.rejects(adapter.sendTurn({
      bindingKey: "binding", senderId: "900", workspaceRoot: fixture.workspace,
      lane: identityLane, launchProfile: managedProfile(fixture.root, "fable-chat"), text: "hi",
    }), (error) => error.code === "conflicting_args");
    assert.deepEqual(readLaunchLog(fixture), []);
    assert.equal(adapter.__internals.processRegistry.listEntries().length, 0);
  } finally { await stop(); }
});

test("T12 A3 the lock domain follows the profile cwd instead of the deployment default", async () => {
  const fixture = identityFixture();
  const { adapter, stop } = startIdentityAdapter(fixture);
  try {
    const profileInput = managedProfile(fixture.root, "fable-chat");
    const route = adapter.__internals.resolveRouteContext({
      bindingKey: "binding", workspaceRoot: fixture.workspace, lane: identityLane,
      launchProfile: profileInput, senderId: "900",
    });
    assert.notEqual(canonicalWorkspaceKey(fixture.memoryDir), canonicalWorkspaceKey(profileInput.cwd));
    // The workspace lock and the process key are both taken on route.agentCwd
    // (beginTurnHold / computeProcessKey), so binding it to the profile cwd is
    // what puts the lock on the directory the child actually runs in.
    assert.equal(canonicalWorkspaceKey(route.agentCwd), canonicalWorkspaceKey(profileInput.cwd));

    await adapter.sendTurn({
      bindingKey: "binding", senderId: "900", workspaceRoot: fixture.workspace,
      lane: identityLane, launchProfile: profileInput, text: "hi",
    });
    const [entry] = adapter.__internals.processRegistry.listEntries();
    assert.equal(canonicalWorkspaceKey(entry.client.g3Preflight.launch.cwd), canonicalWorkspaceKey(route.agentCwd));
    // The child's own relative write proves where it ran: under the profile
    // cwd, not under the deployment's memory directory.
    assert.equal(fs.existsSync(path.join(route.agentCwd, "cb-launch-cwd.marker")), true);
    assert.equal(fs.existsSync(path.join(fixture.memoryDir, "cb-launch-cwd.marker")), false);
  } finally { await stop(); }
});

test("T12 A5 a window override reaches the gate and the child identically", async () => {
  const fixture = identityFixture();
  const { adapter, stop } = startIdentityAdapter(fixture, {
    env: { CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "true" },
  });
  try {
    await adapter.sendTurn({
      bindingKey: "binding", senderId: "900", workspaceRoot: fixture.workspace,
      lane: identityLane, launchProfile: managedProfile(fixture.root, "fable-chat"),
      model: "claude-model-two", effort: "high", text: "hi",
    });
    const [entry] = adapter.__internals.processRegistry.listEntries();
    const verified = entry.client.g3Preflight.launch;
    assert.equal(verified.args[verified.args.indexOf("--model") + 1], "claude-model-two");
    assert.equal(verified.args[verified.args.indexOf("--effort") + 1], "high");
    const [launched] = readLaunchLog(fixture);
    assert.deepEqual(launched.argv.slice(-verified.args.length), [...verified.args]);
  } finally { await stop(); }
});

test("T12 A7 a launch that drifts from the verified one fails closed instead of spawning", async () => {
  const fixture = identityFixture();
  const { adapter, stop } = startIdentityAdapter(fixture);
  try {
    const profileInput = managedProfile(fixture.root, "fable-chat");
    const baseEnv = { ...process.env };
    const verified = await runG3LaunchPreflight({
      profile: profileInput, baseEnv, baseCwd: profileInput.cwd, baseDir: fixture.root,
      expectedLockPath: profileInput.cwd, baseMcpConfigPaths: [],
      command: process.execPath, commandPrefixArgs: identityPrefixArgs(fixture),
      authProbe: async () => ({ ok: true }),
    });
    // The client is handed a *different* MCP config set than the gate saw --
    // the exact shape of the pre-fix code, where the route-scoped config was
    // generated only after the gate had run.
    const drifted = new ClaudeCodeProcessClient({
      command: process.execPath,
      commandPrefixArgs: identityPrefixArgs(fixture),
      cwd: profileInput.cwd,
      env: baseEnv,
      launchProfile: profileInput,
      launchProfileBaseDir: fixture.root,
      mcpConfigPaths: [path.join(fixture.state, "unverified-mcp.json")],
      g3Preflight: verified,
    });
    await assert.rejects(() => drifted.connect(), (error) => error.code === "launch_drift");
    assert.equal(drifted.child, null);
    assert.deepEqual(readLaunchLog(fixture), []);

    // and the belt itself, in isolation: equal launches pass, any difference
    // in fingerprint, cwd or argv is refused.
    assert.equal(assertNoLaunchDrift(verified.launch, verified.launch), verified.launch);
    for (const mutation of [
      { launchFingerprint: "rotated" },
      { cwd: path.join(fixture.root, "elsewhere") },
      { args: [...verified.launch.args, "--extra"] },
    ]) {
      assert.throws(
        () => assertNoLaunchDrift(verified.launch, { ...verified.launch, ...mutation }),
        (error) => error.code === "launch_drift",
      );
    }
    assert.throws(() => assertNoLaunchDrift(verified.launch, null), (error) => error.code === "launch_drift");
  } finally { await stop(); }
});

test("T12 A8 the chat profile authenticates by subscription: no --bare, persona and tool face intact", () => {
  const root = tempRoot();
  try {
    withManagedProfileGate(() => {
      const profileInput = managedProfile(root, "fable-chat");
      const launch = buildProfileLaunch({ profile: profileInput, baseEnv: {}, baseCwd: root, baseDir: root });
      assert.equal(launch.args.includes("--bare"), false);
      assert.equal(launch.args.includes("--system-prompt"), true);
      assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "Read,WebFetch");

      // An active route2 lease raises the built-in face; that is a launch
      // change, so the fingerprint moves and the slot relaunches with it.
      const escalated = buildProfileLaunch({
        profile: profileInput, baseEnv: {}, baseCwd: root, baseDir: root,
        mutableOverride: {
          capabilityLease: { id: "lease-1", status: "active", expiresAt: 1, toolNames: [] },
          trace: { entries: [] },
        },
      });
      assert.equal(escalated.args[escalated.args.indexOf("--tools") + 1], "default");
      assert.equal(escalated.telemetry.tool_face, "escalated");
      assert.notEqual(escalated.launchFingerprint, launch.launchFingerprint);

      // A revoked lease is not an escalation.
      const revoked = buildProfileLaunch({
        profile: profileInput, baseEnv: {}, baseCwd: root, baseDir: root,
        mutableOverride: {
          capabilityLease: { id: "lease-1", status: "revoked", expiresAt: 1, toolNames: [] },
          trace: { entries: [] },
        },
      });
      assert.equal(revoked.args[revoked.args.indexOf("--tools") + 1], "Read,WebFetch");

      // The narrow face is the contract, so leaving it unstated fails closed
      // rather than handing the chat child the CLI's full built-in set.
      const { builtInTools, ...faceless } = managedProfile(root, "fable-chat");
      assert.equal(Array.isArray(builtInTools), true);
      assert.throws(
        () => validateLaunchProfile(faceless, { baseDir: root }),
        (error) => error.code === "g3_profile_field_required",
      );
      // and the harness mode is pinned by the contract, not free-form
      assert.throws(
        () => validateLaunchProfile({ ...managedProfile(root, "fable-chat"), harnessMode: "bare" }, { baseDir: root }),
        (error) => error.code === "g3_profile_contract_mismatch",
      );
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("T12 A9 launch profiles come from a file or from env, never both", () => {
  const root = tempRoot();
  const file = path.join(root, "launch-profiles.json");
  const saved = { ...process.env };
  try {
    const document = JSON.stringify({ "fable-chat": { profileId: "fable-chat" } });
    fs.writeFileSync(file, `﻿${document}`, "utf8");
    process.env.CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE = file;
    delete process.env.CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON;
    // The BOM an editor leaves behind is stripped: the router's JSON parse would
    // otherwise reject a file the operator can see is valid.
    assert.equal(readConfig().claudeLaunchProfilesJson, document);

    process.env.CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON = document;
    assert.throws(() => readConfig(), /cannot both be set/);

    delete process.env.CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON;
    fs.writeFileSync(file, "   \n", "utf8");
    assert.throws(() => readConfig(), /is empty/);

    fs.rmSync(file);
    assert.throws(() => readConfig(), /does not exist or is not readable/);

    process.env.CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE = root;
    assert.throws(() => readConfig(), /must point at a file/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("Route 3 keeps the CLI harness and appends the persona; Route 2 still replaces it", () => {
  // Route 2 widens the tool face but leaves her persona as the whole system
  // prompt -- cheap, and right for touching a file. Route 3 is for a real
  // project: the CLI's own coding harness stays, and the persona rides on top
  // of it. Same window, same session: the tier lives on the lease, not on the
  // profile fingerprint, so escalating must not rotate the session slot.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-route3-"));
  try {
    withManagedProfileGate(() => {
      const input = managedProfile(root, "fable-chat");
      input.escalatedHarness = true;
      const profile = validateLaunchProfile(input, { baseDir: root });
      const leaseEnv = { CYBERBOSS_ROUTE2_GATE_ENABLED: "1", CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "1" };
      const lease = (harness) => resolveWindowOverride({
        capabilityLease: {
          id: "lease-route3", status: "active", harness, expiresAt: 4_102_444_800_000,
          toolNames: [], sessionSlotKey: "slot", windowId: "window",
        },
      }, { profile, env: leaseEnv });

      const wide = buildProfileLaunch({ profile, mutableOverride: lease(false), baseEnv: {}, baseCwd: root, baseDir: root });
      assert.equal(wide.args.includes("--system-prompt"), true, "route2 keeps persona as the whole system prompt");
      assert.equal(wide.args.includes("--append-system-prompt"), false);

      const withHarness = buildProfileLaunch({ profile, mutableOverride: lease(true), baseEnv: {}, baseCwd: root, baseDir: root });
      assert.equal(withHarness.args.includes("--append-system-prompt"), true, "route3 appends onto the default harness");
      assert.equal(withHarness.args.includes("--system-prompt"), false, "the default harness must not be replaced");
      assert.equal(
        withHarness.args[withHarness.args.indexOf("--append-system-prompt") + 1],
        "FABLE_ROLE_SENTINEL",
      );
      // Both tiers get the wide tool face; only the system layer differs.
      for (const launch of [wide, withHarness]) {
        assert.deepEqual(
          launch.args.slice(launch.args.indexOf("--tools"), launch.args.indexOf("--tools") + 2),
          ["--tools", "default"],
        );
      }
      // Identity is unchanged by the tier, so the session slot cannot rotate.
      assert.equal(
        fingerprintLaunchProfile(profile, { baseDir: root }),
        fingerprintLaunchProfile(validateLaunchProfile(managedProfile(root, "fable-chat"), { baseDir: root }), { baseDir: root }),
      );

      // A profile that never declared it cannot be talked into it by a lease.
      const undeclared = validateLaunchProfile(managedProfile(root, "fable-chat"), { baseDir: root });
      const refused = buildProfileLaunch({ profile: undeclared, mutableOverride: lease(true), baseEnv: {}, baseCwd: root, baseDir: root });
      assert.equal(refused.args.includes("--append-system-prompt"), false);
      assert.equal(refused.args.includes("--system-prompt"), true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
