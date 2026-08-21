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
  createClaudeCodeRuntimeAdapter,
} = require("../src/adapters/runtime/claudecode");
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
const { buildTelegramRouteLane } = require("../src/core/route-lane");
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
    harnessMode: "chat-subscription",
    settingSources: ["user"],
    skillsMode: "disabled",
    settings: [settings],
    personaSource,
    builtInTools: ["Read", "WebFetch"],
    escalatedBuiltInTools: ["default"],
    strictMcpConfig: true,
    permissionMode: "chat-native-bypass",
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
      const baseline = resolveWindowOverride({}, { profile, env: ENABLED });
      assert.deepEqual(
        baseline.trace.entries.filter((entry) => ["effective_toolset", "effective_mcp_set"].includes(entry.kind))
          .map((entry) => [entry.kind, entry.effective_value, entry.source]),
        [
          ["effective_toolset", "chat-core@1", "profile_default"],
          ["effective_mcp_set", "chat-base@1", "profile_default"],
        ],
      );
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

test("runtime params rebuild model and effort after the session slot is cleared", async () => {
  const root = tempRoot();
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(root, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
  });
  const bindingKey = "default:telegram:500";
  const senderId = "500";
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 500 });

  try {
    await withEnv(ENABLED, async () => {
      const applied = adapter.setWindowOverride({
        bindingKey,
        workspaceRoot,
        lane,
        senderId,
        patch: {
          model: "claude-opus-5",
          modelSource: "command",
          modelScope: "window",
          effort: "high",
          effortSource: "command",
          effortScope: "window",
        },
      });
      const sessionStore = adapter.getSessionStore();
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: "claude-opus-5",
        effort: "high",
      });
      assert.equal(applied.applied, true);
      assert.equal(
        adapter.__internals.sessionSlotStore.getWindowOverride(applied.sessionSlotKey).model,
        "claude-opus-5",
      );

      adapter.__internals.sessionSlotStore.clear(applied.sessionSlotKey);
      assert.equal(adapter.__internals.sessionSlotStore.getWindowOverride(applied.sessionSlotKey), null);

      const turnParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const recovered = adapter.__internals.resolveRouteContext({
        bindingKey,
        workspaceRoot,
        lane,
        senderId,
        model: turnParams.model,
        effort: turnParams.effort,
      });
      assert.equal(recovered.model, "claude-opus-5");
      assert.equal(recovered.effort, "high");
      assert.equal(recovered.mutableOverride.model, "claude-opus-5");
      assert.equal(recovered.mutableOverride.effort, "high");
    });
  } finally {
    await adapter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("T05 A6 / T08 A10 chat non-member loads schema, calls, and self-escalates with trace but no approval", async () => {
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
    const schema = await host.invokeTool("cyberboss_catalog", { handle: "tool/weather" });
    const result = await host.invokeTool("weather_raw", {});
    assert.equal(schema.data.entry.id, "weather");
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

test("T08 A1/A9/A11 lease override changes only mutable fingerprint and MCP config while --resume keeps window id", () => {
  const root = tempRoot();
  try {
    withEnv({
      CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "true",
      CYBERBOSS_ROUTE2_GATE_ENABLED: "true",
      CYBERBOSS_TOOL_CATALOG_ENABLED: "true",
    }, () => {
      const profile = managedProfile(root);
      const profileFingerprint = fingerprintG3ProfileIdentity(profile);
      const slotKey = buildSessionSlotKey({ workspaceRoot: profile.cwd, laneKey: "lane-lease", profileFingerprint });
      const store = new SessionSlotStore({ filePath: path.join(root, "slots-lease.json") });
      store.setThreadId(slotKey, SESSION_ID);
      const leaseInput = {
        effectiveToolset: "full",
        toolsetSource: "self_escalation",
        effectiveMcpSet: ["cyberboss_tools"],
        harnessOverlay: [{ label: "route2-fixture", text: "Use the bounded fixture capability." }],
        capabilityLease: {
          id: "lease-route2-fake",
          status: "active",
          expiresAt: Date.now() + 60_000,
          toolNames: ["cyberboss_time"],
          sessionSlotKey: slotKey,
          windowId: SESSION_ID,
        },
      };
      const active = resolveWindowOverride(leaseInput, { profile, env: process.env });
      const revoked = resolveWindowOverride({
        capabilityLease: { ...leaseInput.capabilityLease, status: "revoked" },
      }, { profile, env: process.env });
      assert.notEqual(active.fingerprint, revoked.fingerprint);
      assert.equal(fingerprintG3ProfileIdentity(profile), profileFingerprint, "launch/profile fingerprint is untouched");
      assert.equal(buildSessionSlotKey({ workspaceRoot: profile.cwd, laneKey: "lane-lease", profileFingerprint }), slotKey);
      assert.equal(store.getThreadId(slotKey), SESSION_ID);
      const transport = buildArgs({
        permissionMode: "default", disableVerbose: true, extraArgs: [], mcpConfigPaths: [],
        resumeSessionId: store.getThreadId(slotKey), profileManaged: true,
      });
      assert.equal(transport[transport.indexOf("--resume") + 1], SESSION_ID);

      const cyberbossHome = path.join(root, "home");
      fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
      fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "", "utf8");
      const routeConfig = ensureRouteScopedMcpConfig({
        workspaceRoot: profile.cwd,
        cyberbossHome,
        routeToken: "a".repeat(64),
        configDir: path.join(root, "route-config-lease"),
        launchProfile: profile,
        mutableOverride: active,
      });
      const mcpArgs = routeConfig.config.mcpServers.cyberboss_tools.args;
      assert.equal(mcpArgs.includes("--route2-lease"), true, "listChanged:false takeover is carried by relaunched MCP config");
      assert.deepEqual(Object.keys(routeConfig.config.mcpServers), ["cyberboss_tools"]);

      const persona = "<role_card>PERSONA_FIXTURE</role_card>";
      const memory = "<memory_context>MEMORY_FIXTURE</memory_context>";
      const baseline = `${persona}\n${memory}\nhello`;
      const overlaid = applyHarnessOverlay(baseline, active);
      assert.equal(overlaid.endsWith(baseline), true);
      assert.equal(overlaid.match(/PERSONA_FIXTURE/g).length, 1);
      assert.equal(overlaid.match(/MEMORY_FIXTURE/g).length, 1);
      assert.equal(active.trace.overlay_labels[0], "route2-fixture");
      assert.equal(active.trace.entries.find((entry) => entry.kind === "capability_lease").source, "self_escalation");
      assert.equal(applyHarnessOverlay(baseline, revoked), baseline, "revocation restores the non-persona overlay");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T05 A6 / T08 A11 chat route config has no hard ceiling and MCP overrides cannot exceed the profile ceiling", () => {
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
    // ts 必须两侧显式钉死：sanitizeTraceEntry 在 entry.ts 缺失时现取系统时钟
    // （src/core/context-trace.js 的 `normalizeText(entry.ts) || new Date().toISOString()`），
    // 两次调用只要跨过一个毫秒刻度就必然不等。本断言要证的是「开关关闭时 trace 结构
    // 逐字一致」，与时间戳无关——不钉死它等于顺带断言了一件设计上就为假的事。
    const FIXED_TS = "2026-01-01T00:00:00.000Z";
    const baselineTrace = sanitizeTraceEntry({ ts: FIXED_TS, threadId: "thread", turnId: "turn" });
    const disabledTrace = sanitizeTraceEntry({ ts: FIXED_TS, threadId: "thread", turnId: "turn", window_override: disabled?.trace });
    assert.deepEqual(disabledTrace, baselineTrace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T08 A14 Route 2 flag off ignores a stored lease tombstone byte-for-byte in mutable launch state", () => {
  const profile = { defaultToolset: "chat-core@1", defaultMcpServerSet: "chat-base@1" };
  const env = { CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "true" };
  const baseline = resolveWindowOverride({}, { profile, env });
  const disabled = resolveWindowOverride({
    capabilityLease: {
      id: "lease-disabled-fake",
      status: "revoked",
      expiresAt: 1,
      toolNames: ["cyberboss_time"],
      sessionSlotKey: "slot-disabled-fake",
      windowId: SESSION_ID,
    },
  }, { profile, env });
  assert.equal(disabled.fingerprint, baseline.fingerprint);
  assert.deepEqual(disabled.trace, baseline.trace);
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


// model/effort are a GLOBAL, per-workspace preference (the binding store), not a
// per-window/per-fingerprint one: setting /model or /effort in one chat window
// is inherited by the others and survives a persona edit that rotates the slot
// key. These guard that contract so a future refactor cannot silently re-couple
// the choice to the profile fingerprint (which would make it snap back to the
// profile default every time the system prompt is edited).
const G3_ENABLED = {
  ...ENABLED,
  CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED: "1",
  CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED: "1",
};

test("global model/effort survive a persona edit that rotates the slot key", async () => {
  const root = tempRoot();
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const profile = managedProfile(root);
  const workspaceRoot = profile.cwd;
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(root, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
  });
  const bindingKey = "default:telegram:800";
  const senderId = "800";
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 800 });
  try {
    await withEnv(G3_ENABLED, async () => {
      const store = adapter.getSessionStore();
      // /model + /effort (command mirrors: window override + global binding store)
      adapter.setWindowOverride({
        bindingKey, workspaceRoot, lane, launchProfile: profile, senderId,
        patch: { model: "claude-opus-5", modelSource: "command", modelScope: "window", effort: "high", effortSource: "command", effortScope: "window" },
      });
      store.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { model: "claude-opus-5", effort: "high" });

      // Owner edits the system prompt -> persona digest changes -> slot rotates.
      fs.writeFileSync(profile.personaSource, "PERSONA_EDITED", "utf8");

      const tp = store.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const after = adapter.__internals.resolveRouteContext({
        bindingKey, workspaceRoot, lane, launchProfile: profile, senderId, model: tp.model, effort: tp.effort,
      });
      assert.equal(after.effort, "high", "effort must survive a persona edit");
      assert.equal(after.model, "claude-opus-5", "model must survive a persona edit");
    });
  } finally {
    await adapter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh chat window inherits the global model/effort set in another window", async () => {
  const root = tempRoot();
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const profile = managedProfile(root);
  const workspaceRoot = profile.cwd;
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(root, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
  });
  const bindingKey = "default:telegram:700";
  const senderId = "700";
  const laneA = buildTelegramRouteLane({ accountId: "telegram", chatId: 700, messageThreadId: 1 });
  const laneB = buildTelegramRouteLane({ accountId: "telegram", chatId: 700, messageThreadId: 2 });
  try {
    await withEnv(G3_ENABLED, async () => {
      const store = adapter.getSessionStore();
      adapter.setWindowOverride({ bindingKey, workspaceRoot, lane: laneA, launchProfile: profile, senderId, patch: { effort: "high", effortSource: "command", effortScope: "window" } });
      store.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { effort: "high" });

      // window B has never run /effort -> it inherits the global choice.
      const tp = store.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const ctxB = adapter.__internals.resolveRouteContext({
        bindingKey, workspaceRoot, lane: laneB, launchProfile: profile, senderId, effort: tp.effort,
      });
      assert.equal(ctxB.effort, "high", "a fresh window inherits the global effort");
    });
  } finally {
    await adapter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
