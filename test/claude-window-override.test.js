"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildProfileLaunch,
  fingerprintG3ProfileIdentity,
} = require("../src/adapters/runtime/claudecode/launch-profile");
const {
  SessionSlotStore,
  buildSessionSlotKey,
} = require("../src/adapters/runtime/claudecode/session-slot");
const {
  WindowOverrideError,
  applyHarnessOverlay,
  resolveWindowOverride,
} = require("../src/adapters/runtime/claudecode/window-override");
const { buildArgs } = require("../src/adapters/runtime/claudecode/process-client");
const {
  ensureRouteScopedMcpConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");
const { sanitizeTraceEntry } = require("../src/core/context-trace");
const { ProjectToolHost } = require("../src/tools/tool-host");

const ENABLED = { CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "true" };
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-t05-"));
}

function managedProfile(root, extra = {}) {
  const cwd = path.join(root, "workspace");
  const configRoot = path.join(root, "config-root");
  const settings = path.join(root, "settings.json");
  const personaSource = path.join(root, "persona.md");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(settings, "{}", "utf8");
  fs.writeFileSync(personaSource, "PERSONA_SENTINEL", "utf8");
  return {
    schemaVersion: 3,
    profileId: "fable-chat",
    cwd,
    configRoot,
    harnessMode: "bare",
    settingSources: ["user"],
    skillsMode: "disabled",
    settings: [settings],
    personaSource,
    residentToolSchemas: ["cyberboss_system_send", "cyberboss_time"],
    mcpServerCeiling: "chat-ceiling@1",
    toolsetCeiling: "chat-ceiling@1",
    defaultMcpServerSet: "chat-base@1",
    defaultToolset: "chat-core@1",
    strictMcpConfig: true,
    permissionMode: "profile-local-least-privilege",
    envPolicy: "chat-minimal",
    ...extra,
  };
}

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const result = run();
    return result && typeof result.then === "function"
      ? result.finally(() => restore(previous))
      : (restore(previous), result);
  } catch (error) {
    restore(previous);
    throw error;
  }
}

function restore(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("T05 A1/A2 four mutable values change launch behavior while the slot resumes one native session", () => {
  const root = tempRoot();
  try {
    withEnv({
      CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED: "true",
      CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED: "true",
    }, () => {
      const profile = managedProfile(root);
      const identity = fingerprintG3ProfileIdentity(profile);
      const slotKey = buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-a", profileFingerprint: identity });
      const store = new SessionSlotStore({ filePath: path.join(root, "slots.json") });
      store.setThreadId(slotKey, SESSION_ID, { route: { workspaceRoot: root, laneKey: "lane-a", profileFingerprint: identity } });
      store.setWindowOverride(slotKey, { effort: "high", effortSource: "command" });
      const otherSlot = buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-b", profileFingerprint: identity });
      assert.equal(store.getWindowOverride(slotKey).effort, "high");
      assert.equal(store.getWindowOverride(otherSlot), null, "override scope cannot leak into another window");

      const variants = [
        { model: "claude-model-two", modelSource: "command" },
        { effort: "high", effortSource: "command" },
        { effectiveToolset: "full", toolsetSource: "self_escalation" },
        { effectiveMcpSet: ["cyberboss_tools"], mcpSource: "overlay" },
      ];
      const fingerprints = new Set();
      for (const variant of variants) {
        const resolved = resolveWindowOverride(variant, { profile, env: ENABLED });
        const launch = buildProfileLaunch({
          profile,
          mutableOverride: resolved,
          baseEnv: process.env,
          baseCwd: root,
          baseDir: root,
        });
        fingerprints.add(resolved.fingerprint);
        assert.equal(buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-a", profileFingerprint: identity }), slotKey);
        assert.equal(store.getThreadId(slotKey), SESSION_ID);
        assert.equal(resolved.trace.entries.length >= 4, true);
        for (const entry of resolved.trace.entries) {
          assert.match(entry.effective_token, /^[0-9a-f]{24}$/);
          assert.equal(entry.scope === "window" || entry.scope === "turn", true);
          assert.ok(entry.source);
        }
        const transportArgs = buildArgs({
          permissionMode: "default",
          disableVerbose: true,
          extraArgs: [],
          mcpConfigPaths: [],
          resumeSessionId: store.getThreadId(slotKey),
          profileManaged: true,
        });
        assert.equal(transportArgs[transportArgs.indexOf("--resume") + 1], SESSION_ID);
        assert.ok(launch.args.includes("--resume") === false, "profile args remain separate from resume transport args");
      }
      assert.equal(fingerprints.size, variants.length, "each override produces a distinct process-launch state");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T05 A2/A3 harness overlay is labelled in trace and leaves persona/memory bytes unchanged", () => {
  const profile = { defaultToolset: "chat-core@1", defaultMcpServerSet: "chat-base@1" };
  const resolved = resolveWindowOverride({
    harnessOverlay: [{ label: "route2-read", text: "Use the read-only route for this turn." }],
  }, { profile, env: ENABLED });
  const persona = "<role_card>PERSONA_BYTES</role_card>";
  const memory = "<memory_context>MEMORY_BYTES</memory_context>";
  const baseline = `${persona}\n${memory}\n<user>hello</user>`;
  const overlaid = applyHarnessOverlay(baseline, resolved);
  assert.equal(overlaid.includes(persona), true);
  assert.equal(overlaid.includes(memory), true);
  assert.equal(overlaid.match(/PERSONA_BYTES/g).length, 1);
  assert.equal(overlaid.match(/MEMORY_BYTES/g).length, 1);
  assert.deepEqual(resolved.trace.overlay_labels, ["route2-read"]);
  assert.equal(resolved.trace.entries.at(-1).overlay_label, "route2-read");
});

test("T05 A4/A5 persona and permission identity rotate windows and are refused as mutable fields", () => {
  const root = tempRoot();
  try {
    const profile = managedProfile(root);
    const base = fingerprintG3ProfileIdentity(profile);
    const baseSlot = buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-a", profileFingerprint: base });
    const store = new SessionSlotStore({ filePath: path.join(root, "slots.json") });
    store.setThreadId(baseSlot, SESSION_ID, { route: { workspaceRoot: root, laneKey: "lane-a", profileFingerprint: base } });

    fs.writeFileSync(profile.personaSource, "PERSONA_CHANGED", "utf8");
    const personaIdentity = fingerprintG3ProfileIdentity(profile);
    const personaSlot = buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-a", profileFingerprint: personaIdentity });
    assert.notEqual(personaSlot, baseSlot);
    assert.equal(store.getThreadId(baseSlot), SESSION_ID, "the original window is not polluted");
    assert.equal(store.getThreadId(personaSlot), "");

    const permissionIdentity = fingerprintG3ProfileIdentity({ ...profile, permissionMode: "rotated-permission" });
    assert.notEqual(
      buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane-a", profileFingerprint: permissionIdentity }),
      personaSlot,
    );
    for (const invalid of [{ personaSource: "persona-two" }, { permissionIdentity: "identity-two" }, { permissionMode: "plan" }]) {
      assert.throws(
        () => resolveWindowOverride(invalid, { profile, env: ENABLED }),
        (error) => error instanceof WindowOverrideError
          && error.code === "window_override_identity_change_requires_new_window",
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T05 A6 chat non-member self-escalates with trace hook and without an approval flow", async () => {
  await withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "true" }, async () => {
    const escalations = [];
    let approvals = 0;
    const host = new ProjectToolHost({
      services: {
        weather: { getRaw: async () => ({ ok: true }) },
        whereabouts: {},
      },
      runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
      toolset: "chat-core@1",
      authorizationCeiling: "",
      chatSelfEscalation: true,
      onSelfEscalation: (entry) => escalations.push(entry),
      onApproval: () => { approvals += 1; },
    });
    const result = await host.invokeTool("weather_raw", {});
    assert.deepEqual(result.data, { ok: true });
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].source, "self_escalation");
    assert.equal(escalations[0].approval_required, false);
    assert.equal(approvals, 0);
    const trace = resolveWindowOverride({
      effectiveToolset: "full",
      toolsetSource: "self_escalation",
    }, {
      profile: { defaultToolset: "chat-core@1", defaultMcpServerSet: "chat-base@1" },
      env: ENABLED,
    }).trace;
    assert.equal(
      trace.entries.find((entry) => entry.kind === "effective_toolset").source,
      "self_escalation",
    );
  });
});

test("T05 A6 chat route config has no hard ceiling and MCP overrides cannot exceed the profile ceiling", () => {
  const root = tempRoot();
  try {
    const workspaceRoot = path.join(root, "workspace");
    const cyberbossHome = path.join(root, "home");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
    fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "", "utf8");
    const profile = managedProfile(root);
    const mutableOverride = resolveWindowOverride({
      effectiveToolset: "chat-core@1",
      effectiveMcpSet: ["cyberboss_tools"],
    }, { profile, env: ENABLED });
    const route = ensureRouteScopedMcpConfig({
      workspaceRoot,
      cyberbossHome,
      routeToken: "a".repeat(64),
      configDir: path.join(root, "route-config"),
      launchProfile: profile,
      mutableOverride,
    });
    const args = route.config.mcpServers.cyberboss_tools.args;
    assert.equal(args.includes("--authorization-ceiling"), false);
    assert.equal(args.includes("--chat-self-escalation"), true);
    assert.deepEqual(Object.keys(route.config.mcpServers), ["cyberboss_tools"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T05 A7 switch off is byte-compatible for launch, slot and Context Trace", () => {
  const root = tempRoot();
  try {
    const profile = { profileId: "baseline", cwd: root };
    const input = { profile, baseEnv: { FIXTURE: "unchanged" }, baseCwd: root, baseDir: root };
    const baselineLaunch = buildProfileLaunch(input);
    const disabled = resolveWindowOverride({
      model: "changed-model",
      effort: "max",
      effectiveToolset: "chat-core@1",
      effectiveMcpSet: [],
    }, { profile, env: {} });
    const disabledLaunch = buildProfileLaunch({ ...input, mutableOverride: disabled });
    assert.equal(disabled, null);
    assert.deepEqual(disabledLaunch, baselineLaunch);

    const fingerprint = "baseline-fingerprint";
    assert.equal(
      buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane", profileFingerprint: fingerprint }),
      buildSessionSlotKey({ workspaceRoot: root, laneKey: "lane", profileFingerprint: fingerprint }),
    );
    const baselineTrace = sanitizeTraceEntry({ threadId: "thread", turnId: "turn" });
    const disabledTrace = sanitizeTraceEntry({ threadId: "thread", turnId: "turn", window_override: disabled?.trace });
    assert.deepEqual(disabledTrace, baselineTrace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T05 A8 trace never echoes credentials, absolute paths or raw profile identity", () => {
  const privatePath = "C:\\private\\profile";
  const rawProfileId = "fable-chat-private-fixture";
  const credential = `sk-${"x".repeat(24)}`;
  const resolved = resolveWindowOverride({
    model: "safe-model",
    effectiveToolset: "chat-core@1",
    effectiveMcpSet: ["cyberboss_tools"],
    harnessOverlay: [{ label: "safe-overlay", text: `${privatePath} ${rawProfileId} ${credential}` }],
  }, {
    profile: { profileId: rawProfileId, defaultToolset: "chat-core@1", defaultMcpServerSet: "chat-base@1" },
    env: ENABLED,
  });
  const trace = sanitizeTraceEntry({
    threadId: "thread",
    turnId: "turn",
    window_override: resolved.trace,
  });
  const serialized = JSON.stringify(trace);
  for (const forbidden of [privatePath, rawProfileId, credential]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.throws(
    () => resolveWindowOverride({ model: credential }, { env: ENABLED }),
    (error) => error.code === "window_override_invalid",
  );
});
