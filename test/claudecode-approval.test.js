const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { CyberbossApp } = require("../src/core/app");

// The /status fixtures are duck-typed objects, not real CyberbossApp instances.
// Chain them to the real prototype so helper methods the command calls (e.g. the
// shared window-override resolution ladder) run their production implementation
// instead of being re-stubbed per fixture — a re-stub would let the fixture agree
// with itself while the shipped ladder drifts.
function withAppPrototype(appLike) {
  return Object.setPrototypeOf(appLike, CyberbossApp.prototype);
}
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events");
const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { SessionSlotStore } = require("../src/adapters/runtime/claudecode/session-slot");
const {
  Route2GateState,
  decideRoute2Gate,
  runOptionalRoute2Tool,
} = require("../src/adapters/runtime/claudecode/route2-gate");
const { Route1DispatchIpcClient } = require("../src/orchestration/route1-dispatch");
const { resolveWindowOverride } = require("../src/adapters/runtime/claudecode/window-override");

// Thread-bearing runtime events resolve a reply target before delivery
// (src/core/app.js:2642-2648), so appLike fixtures must provide the real
// StreamDelivery surface even when the test has no reply target.
function resolveNoReplyTargetForRuntimeEvent() {
  return null;
}

test("claudecode approval events extract command tokens from exec_command input", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-1",
    toolName: "exec_command",
    input: {
      cmd: "cyberboss reminder write --delay 30m --text 'Reminder text'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["cyberboss", "reminder", "write"]);
});

test("claudecode approval events prefer prefix_rule when present", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-2",
    toolName: "exec_command",
    input: {
      cmd: "npm run timeline:build -- --locale en",
      prefix_rule: ["npm", "run", "timeline:build"],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["npm", "run", "timeline:build"]);
});

test("claudecode approval events canonicalize diary commands for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-diary",
    toolName: "exec_command",
    input: {
      cmd: "/Users/tingyiwen/Dev/cyberboss/bin/cyberboss diary write --date 2026-04-17 --title '4.17' --text 'hello'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["cyberboss", "diary", "write"]);
});

test("claudecode approval events canonicalize view_image tool approvals", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-img",
    toolName: "view_image",
    input: {
      path: "/tmp/example.png",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["view_image"]);
});

test("claudecode approval events canonicalize MCP tool approvals for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-mcp-timeline",
    toolName: "mcp__cyberboss_tools__cyberboss_timeline_write",
    input: {
      date: "2026-04-21",
      events: [],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["mcp_tool", "cyberboss_tools", "cyberboss_timeline_write"]);
  assert.match(event.payload.command, /^cyberboss_timeline_write\b/);
});

test("claudecode approval events canonicalize Read image approvals for stable matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-image",
    toolName: "Read",
    input: {
      file_path: "/Users/tingyiwen/.cyberboss/inbox/2026-04-17/attachment-5.jpg",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["read_image"]);
  assert.equal(event.payload.filePath, "/Users/tingyiwen/.cyberboss/inbox/2026-04-17/attachment-5.jpg");
});

test("claudecode approval events keep non-image Read approvals as file reads", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-text",
    toolName: "Read",
    input: {
      file_path: "/Users/tingyiwen/.cyberboss/inbox/2026-04-17/note.txt",
    },
  });

  assert.deepEqual(event.payload.commandTokens, []);
  assert.equal(event.payload.filePath, "/Users/tingyiwen/.cyberboss/inbox/2026-04-17/note.txt");
});

test("claudecode approval events capture Write file paths for state-dir auto approve", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-write",
    toolName: "Write",
    input: {
      file_path: "/Users/tingyiwen/.cyberboss/notes/today.md",
      content: "hello",
    },
  });

  assert.equal(event.payload.filePath, "/Users/tingyiwen/.cyberboss/notes/today.md");
  assert.deepEqual(event.payload.filePaths, ["/Users/tingyiwen/.cyberboss/notes/today.md"]);
});

test("claudecode adapter exposes image file read capability only for known image-capable models", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-vision-"));
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir: tempDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
  });
  const configured = createClaudeCodeRuntimeAdapter({
    stateDir: tempDir,
    sessionsFile: path.join(tempDir, "configured-sessions.json"),
    claudeModel: "sonnet",
  });

  assert.deepEqual(adapter.getTurnCapabilities({ model: "" }), {
    nativeImageInput: false,
    toolImageRead: false,
  });
  assert.deepEqual(adapter.getTurnCapabilities({ model: "claude-sonnet" }), {
    nativeImageInput: false,
    toolImageRead: true,
  });
  assert.deepEqual(adapter.getTurnCapabilities({ model: "deepseek-chat" }), {
    nativeImageInput: false,
    toolImageRead: false,
  });
  // Precedence fix (fable item 5): an explicit per-turn model now wins over the
  // deployment default. configuredModel is a *fallback*, not an override -- so a
  // passed model drives capabilities, and only an empty passed model falls back
  // to configuredModel.
  assert.deepEqual(configured.getTurnCapabilities({ model: "deepseek-chat" }), {
    nativeImageInput: false,
    toolImageRead: false,
  });
  assert.deepEqual(configured.getTurnCapabilities({ model: "" }), {
    nativeImageInput: false,
    toolImageRead: true,
  });
});

test("claudecode adapter describe exposes model provider and the chat model catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-describe-"));
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir: tempDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeModel: "claude-fable-5",
  });
  const described = adapter.describe();
  assert.equal(described.id, "claudecode");
  assert.equal(described.model, "claude-fable-5");
  // Fixes /status "provider: (default)" -- describe now carries a real provider.
  assert.equal(described.modelProvider, "anthropic");
  // Seeds the /model chat menu and its accepted aliases.
  assert.deepEqual(described.models, [
    { model: "claude-fable-5", aliases: ["fable"] },
    { model: "claude-opus-5", aliases: ["opus"] },
    { model: "claude-sonnet-5", aliases: ["sonnet"] },
    { model: "claude-haiku-4-5-20251001", aliases: ["haiku", "claude-haiku-4-5"] },
    { model: "claude-opus-4-8", aliases: ["opus-4.8"] },
    { model: "claude-opus-4-7", aliases: ["opus-4.7"] },
    { model: "claude-opus-4-6", aliases: ["opus-4.6"] },
    { model: "claude-sonnet-4-6", aliases: ["sonnet-4.6"] },
  ]);
});

test("claudecode adapter hydrates model from Claude project transcript", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-project-model-"));
  const stateDir = path.join(tempDir, "state");
  const claudeConfigDir = path.join(tempDir, "claude");
  const workspaceRoot = path.join(tempDir, "workspace root");
  const sessionId = "77777777-7777-4777-8777-777777777777";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const projectDir = path.join(claudeConfigDir, "projects", workspaceRoot.replace(/[\\/:\s]+/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "assistant", message: { model: "deepseek-v4-flash" } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" } }),
  ].join("\n"));
  const sessionsFile = path.join(tempDir, "sessions.json");
  new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" })
    .setThreadIdForWorkspace("binding-1", workspaceRoot, sessionId);

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile,
    claudeConfigDir,
  });

  assert.deepEqual(adapter.getSessionStore().getRuntimeParamsForWorkspace("binding-1", workspaceRoot), {
    model: "claude-sonnet-4-6",
    modelProvider: "",
  });
});

test("claudecode adapter initialize creates shared-open IPC endpoint and token", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-ipc-"));
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
  });

  try {
    const runtimeState = await adapter.initialize();
    const endpointFile = path.join(stateDir, "claudecode-runtime.json");
    const tokenFile = path.join(stateDir, "claudecode-runtime.token");
    const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
    assert.equal(runtimeState.ipcSocketPath, path.join(stateDir, "claudecode-runtime.sock"));
    assert.equal(fs.existsSync(endpointFile), true);
    assert.equal(fs.existsSync(tokenFile), true);
    assert.equal(endpoint.transport, "tcp");
    assert.equal(endpoint.host, "127.0.0.1");
    assert.equal(typeof endpoint.port, "number");
    assert.ok(endpoint.port > 0);
  } finally {
    await adapter.close();
  }
});

test("claudecode adapter remembers model observed in stream messages", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-stream-model-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const commandFile = path.join(tempDir, "fake-claude.js");
  const sessionId = "88888888-8888-4888-8888-888888888888";
  fs.writeFileSync(commandFile, [
    "#!/usr/bin/env node",
    "process.stdin.on(\"data\", () => {",
    `  console.log(JSON.stringify({ type: "system", session_id: ${JSON.stringify(sessionId)} }));`,
    "  console.log(JSON.stringify({ type: \"assistant\", message: { model: \"claude-sonnet-4-6\", content: [{ type: \"text\", text: \"done\" }] } }));",
    `  console.log(JSON.stringify({ type: "result", session_id: ${JSON.stringify(sessionId)}, result: "done" }));`,
    "  process.exit(0);",
    "});",
  ].join("\n"));
  fs.chmodSync(commandFile, 0o755);

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    // The production client supports an executable plus prefix arguments
    // (src/adapters/runtime/claudecode/process-client.js:185-190). A .js file
    // is not itself executable on Windows, so run the fake CLI through Node.
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [commandFile],
    claudeDisableVerbose: true,
  });

  try {
    await adapter.sendTurn({
      bindingKey: "binding-1",
      workspaceRoot,
      text: "hello",
    });
    const sessionsText = await waitForFileText(path.join(tempDir, "sessions.json"), /claude-sonnet-4-6/);
    assert.match(sessionsText, /claude-sonnet-4-6/);
    assert.deepEqual(adapter.getSessionStore().getRuntimeParamsForWorkspace("binding-1", workspaceRoot), {
      model: "claude-sonnet-4-6",
      modelProvider: "",
    });
  } finally {
    await adapter.close();
  }
});

test("claudecode assistant events map usage into context snapshots", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent(
    {
      type: "context.updated",
      sessionId: "thread-1",
    },
    {
      message: {
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 12150,
          cache_read_input_tokens: 13535,
          output_tokens: 1509,
        },
      },
    },
  );

  assert.equal(event.type, "runtime.context.updated");
  assert.equal(event.payload.runtimeId, "claudecode");
  assert.equal(event.payload.threadId, "thread-1");
  assert.equal(event.payload.currentTokens, 27201);
});

test("claudecode adapter dispatches turns only after a real session id is available", async () => {
  const tempDir = fs.mkdtempSync(path.join("/tmp", "cb-claude-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const captureFile = path.join(tempDir, "stdin.log");
  const commandFile = path.join(tempDir, "fake-claude.js");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  fs.writeFileSync(commandFile, [
    "#!/usr/bin/env node",
    `const fs = require("node:fs");`,
    "process.stdin.on(\"data\", (chunk) => {",
    `  fs.appendFileSync(${JSON.stringify(captureFile)}, chunk);`,
    `  console.log(JSON.stringify({ type: "system", session_id: ${JSON.stringify(sessionId)} }));`,
    "  process.exit(0);",
    "});",
  ].join("\n"));
  fs.chmodSync(commandFile, 0o755);

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [commandFile],
    claudePermissionMode: "default",
    claudeDisableVerbose: true,
    claudeExtraArgs: [],
  });

  try {
    const turn = await adapter.sendTurn({
      bindingKey: "binding-1",
      workspaceRoot,
      text: "hello",
      metadata: {
        senderId: "user-1",
      },
      model: "claude-sonnet",
    });

    assert.equal(turn.threadId, sessionId);
    assert.match(turn.turnId, /^turn-\d+$/);
    assert.equal(adapter.getSessionStore().getThreadIdForWorkspace("binding-1", workspaceRoot), sessionId);
    assert.deepEqual(adapter.getSessionStore().getRuntimeParamsForWorkspace("binding-1", workspaceRoot), {
      model: "claude-sonnet",
      modelProvider: "",
    });
    assert.doesNotMatch(turn.threadId, /^pending-/);
    assert.match(await waitForFileText(captureFile, /hello/), /hello/);
  } finally {
    await adapter.close();
  }
});

test("claudecode process client treats assistant text as non-deliverable until the result event", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/workspace",
    env: {},
  });
  client.pendingTurnId = "turn-tool";
  client.sessionId = "thread-tool";
  client.activeThreadId = "thread-tool";
  const messages = [];
  client.onMessage((event, raw) => {
    messages.push({ event, raw });
  });

  client.handleAssistant({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "我先查一下。" },
        { type: "tool_use", name: "mcp__cyberboss_tools__cyberboss_timeline_read", input: { date: "2026-05-19" } },
      ],
    },
  });
  client.handleResult({
    type: "result",
    session_id: "thread-tool",
    result: "查完了，这是工具后的最终结果。",
  });

  assert.deepEqual(messages.map((entry) => entry.event.type), [
    "assistant.text",
    "tool.use",
    "turn.completed",
  ]);
  assert.equal(mapClaudeCodeMessageToRuntimeEvent(messages[0].event, messages[0].raw), null);
  const completed = mapClaudeCodeMessageToRuntimeEvent(messages[2].event, messages[2].raw);
  assert.equal(completed.type, "runtime.turn.completed");
  assert.equal(completed.payload.threadId, "thread-tool");
  assert.equal(completed.payload.turnId, "turn-tool");
  assert.equal(completed.payload.text, "查完了，这是工具后的最终结果。");
});

test("T07 A1/A2 counts each real tool.use once and never counts approvals", () => {
  const previous = process.env.CYBERBOSS_ROUTE2_GATE_ENABLED;
  process.env.CYBERBOSS_ROUTE2_GATE_ENABLED = "true";
  const slotStore = new SessionSlotStore();
  const tracker = new Route2GateState({ sessionSlotStore: slotStore });
  const catalog = [{ id: "fake_read", estimated_schema_chars: 100, max_result_bytes: 64, authorized: true }];
  tracker.begin({ sessionSlotKey: "slot-fake", windowId: "window-fake", taskId: "task-fake", plan: { catalog, toolNames: ["fake_read"], expectedContextTokens: 100 } });
  try {
    const client = new ClaudeCodeProcessClient({ command: "claude", cwd: "/workspace", env: {} });
    client.pendingTurnId = "turn-fake";
    client.sessionId = "window-fake";
    client.activeThreadId = "window-fake";
    const sourceEvents = [];
    client.onMessage((event, raw) => sourceEvents.push({ event, raw }));
    for (let index = 0; index < 3; index += 1) {
      client.handleAssistant({ message: { content: [{ type: "tool_use", name: "fake_read", input: { fixture: index } }] } });
    }
    const mappedTools = sourceEvents.map(({ event, raw }) => mapClaudeCodeMessageToRuntimeEvent(event, raw)).filter(Boolean);
    for (const event of mappedTools) tracker.observe({ ...event, payload: { ...event.payload, sessionSlotKey: "slot-fake" } });
    for (let index = 0; index < 5; index += 1) {
      const approval = mapClaudeCodeMessageToRuntimeEvent({ type: "approval.requested", sessionId: "window-fake", requestId: `approval-${index}`, toolName: "fake_read", input: {} });
      tracker.observe({ ...approval, payload: { ...approval.payload, sessionSlotKey: "slot-fake" } });
    }
    const cost = tracker.observe({ type: "runtime.turn.completed", payload: { threadId: "window-fake", turnId: "turn-fake", sessionSlotKey: "slot-fake" } });
    assert.equal(sourceEvents.length, 3);
    assert.equal(mappedTools.length, 3);
    assert.equal(cost.payload.actualToolUses, 3);
  } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_ROUTE2_GATE_ENABLED;
    else process.env.CYBERBOSS_ROUTE2_GATE_ENABLED = previous;
  }
});

test("T07 A3/A4/A5 gate stays inside soft A and routes hard B or unbounded results to Route 1", () => {
  const env = { CYBERBOSS_ROUTE2_GATE_ENABLED: "true" };
  const bounded = Array.from({ length: 4 }, (_, index) => ({ id: `fake_${index}`, estimated_schema_chars: 500, max_result_bytes: 1024, authorized: true }));
  const soft = decideRoute2Gate({ catalog: bounded, toolNames: bounded.map((entry) => entry.id), actualToolUses: 3, expectedContextTokens: 6000 }, { env });
  assert.equal(soft.route, "route2");
  assert.equal(soft.decision, "stay_route2");

  const hard = decideRoute2Gate({ catalog: bounded, toolNames: bounded.map((entry) => entry.id), expectedContextTokens: 8000 }, { env });
  assert.equal(hard.route, "route1");
  assert.equal(hard.decision, "route_to_route1");
  assert.ok(hard.status.length > 0 && hard.status.length < 40);
  assert.equal(hard.chat_capability, "unchanged");

  const unbounded = decideRoute2Gate({ catalog: [{ ...bounded[0], max_result_bytes: null }], toolNames: [bounded[0].id], expectedContextTokens: 10 }, { env });
  assert.equal(unbounded.route, "route1");
  assert.ok(unbounded.reasons.includes("unbounded_result"));
});

test("T07 A9 optional Route 2 failure remains fail-open to chat-core", async () => {
  const result = await runOptionalRoute2Tool({
    invoke: async () => { const error = new Error("fake optional failure"); error.code = "fake_failure"; throw error; },
    chatCore: async () => "chat-core still replied",
  });
  assert.equal(result.reply, "chat-core still replied");
  assert.equal(result.toolResult, null);
  assert.equal(result.toolError, "fake_failure");
});

test("T07 A10 Route 2 state is attached to the existing slot without changing window identity", () => {
  const store = new SessionSlotStore();
  store.setThreadId("slot-stable", "window-stable");
  store.setWindowOverride("slot-stable", { model: "fake-model" });
  const before = store.getThreadId("slot-stable");
  const state = new Route2GateState({ sessionSlotStore: store, env: { CYBERBOSS_ROUTE2_GATE_ENABLED: "true" } });
  state.begin({
    sessionSlotKey: "slot-stable",
    windowId: before,
    overrideFingerprint: "override-fingerprint-fake",
    taskId: "task-stable",
    plan: { catalog: [{ id: "fake_read", estimated_schema_chars: 10, max_result_bytes: 32 }], toolNames: ["fake_read"], expectedContextTokens: 10 },
  });
  assert.equal(store.getThreadId("slot-stable"), before);
  assert.deepEqual(store.getWindowOverride("slot-stable"), { model: "fake-model" });
  assert.equal(store.getRoute2Gate("slot-stable").overrideFingerprint, "override-fingerprint-fake");
});

test("T07 A11 feature flag off keeps the pre-T07 event and manifest behavior", () => {
  const previous = process.env.CYBERBOSS_ROUTE2_GATE_ENABLED;
  delete process.env.CYBERBOSS_ROUTE2_GATE_ENABLED;
  try {
    assert.equal(mapClaudeCodeMessageToRuntimeEvent({ type: "tool.use", toolName: "fake_read", sessionId: "fake", turnId: "fake" }), null);
    assert.equal(decideRoute2Gate({ catalog: [], toolNames: [] }), null);
  } finally {
    if (previous !== undefined) process.env.CYBERBOSS_ROUTE2_GATE_ENABLED = previous;
  }
});

function beginLeaseFixture({ now = () => 1_000, setTimer = () => ({ unref() {} }), clearTimer = () => {}, onRevoke = null } = {}) {
  const store = new SessionSlotStore();
  store.setThreadId("slot-lease-fake", "window-lease-fake");
  const state = new Route2GateState({
    sessionSlotStore: store,
    env: { CYBERBOSS_ROUTE2_GATE_ENABLED: "true" },
    now,
    setTimer,
    clearTimer,
    onRevoke,
  });
  state.begin({
    sessionSlotKey: "slot-lease-fake",
    windowId: "window-lease-fake",
    overrideFingerprint: "override-lease-fake",
    plan: { catalog: [{ id: "fake_read", estimated_schema_chars: 10, max_result_bytes: 32 }], toolNames: ["fake_read"] },
    lease: { id: "lease-fake", ttlMs: 100, toolNames: ["fake_read"] },
  });
  return { state, store };
}

test("T08 A2 completed reports the turn's cost but the lease outlives the turn", () => {
  // Contract change (2026-08-06): a turn boundary is a cost checkpoint, not the
  // end of the lease. It used to be both, which made the wide face survive
  // exactly one reply -- and since revocation also closed the child,每一轮都要
  // 重新申请并重启一次进程。工作不在 turn 边界结束。
  const { state, store } = beginLeaseFixture();
  const cost = state.observe({ type: "runtime.turn.completed", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(cost.payload.outcome, "success");
  assert.equal(state.get("slot-lease-fake")?.lease?.id, "lease-fake", "lease must survive the turn");
  assert.equal(store.getRoute2Gate("slot-lease-fake")?.lease?.id, "lease-fake");
  // Per-turn counters restart so the next turn's cost is its own.
  assert.equal(state.get("slot-lease-fake").actualToolUses, 0);
});

test("T08 A3 failed also keeps the lease; only a strong interrupt surrenders it", () => {
  const { state, store } = beginLeaseFixture();
  state.observe({ type: "runtime.turn.failed", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(state.get("slot-lease-fake")?.lease?.id, "lease-fake");

  state.observe({ type: "runtime.strong_interrupt", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(state.get("slot-lease-fake"), null);
  assert.equal(store.getRoute2Gate("slot-lease-fake"), null);
});

test("T08 A3b she can hand the wide face back before the TTL runs out", () => {
  const { state, store } = beginLeaseFixture();
  const released = state.release("slot-lease-fake");
  assert.equal(released.revokeReason, "released");
  assert.equal(state.get("slot-lease-fake"), null);
  assert.equal(store.getRoute2Gate("slot-lease-fake"), null);
});

test("T08 A4 TTL expiry revokes the lease and clears persisted state", () => {
  let now = 1_000;
  let expire = null;
  const revoked = [];
  const { state, store } = beginLeaseFixture({
    now: () => now,
    setTimer: (fn) => { expire = fn; return { unref() {} }; },
    onRevoke: (entry) => revoked.push(entry),
  });
  now = 1_101;
  expire();
  assert.equal(state.get("slot-lease-fake"), null);
  assert.equal(store.getRoute2Gate("slot-lease-fake"), null);
  assert.equal(revoked[0].revokeReason, "ttl_expired");
});

test("T08 A5 a cancelled turn is still just a turn boundary; the lease holds", () => {
  const { state, store } = beginLeaseFixture();
  state.observe({ type: "runtime.turn.cancelled", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(store.getRoute2Gate("slot-lease-fake")?.lease?.id, "lease-fake");
});

test("T08 A6 strong-interrupt signal revokes the lease without implementing task interruption semantics", () => {
  const { state, store } = beginLeaseFixture();
  state.observe({ type: "runtime.strong_interrupt", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(store.getRoute2Gate("slot-lease-fake"), null);
});

test("T08 A7 a restart must NOT revoke: granting the wide face is itself a relaunch", () => {
  // If a restart surrendered the lease, the grant would revoke itself moments
  // after being issued -- the child is retired and relaunched precisely to pick
  // up the wider tool face.
  const { state, store } = beginLeaseFixture();
  state.observe({ type: "runtime.process.restarted", payload: { sessionSlotKey: "slot-lease-fake" } });
  assert.equal(store.getRoute2Gate("slot-lease-fake")?.lease?.id, "lease-fake");
});

test("T08 A1/A11 grant relaunches the mutable override and resumes the identical native window", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-route2-lease-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  const commandFile = path.join(tempDir, "fake-route2-claude.js");
  const launchLog = path.join(tempDir, "launch.log");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(commandFile, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "process.stdin.on('data', () => {",
    `  console.log(JSON.stringify({ type: 'system', session_id: ${JSON.stringify(sessionId)} }));`,
    `  console.log(JSON.stringify({ type: 'result', session_id: ${JSON.stringify(sessionId)}, result: 'fixture done' }));`,
    "});",
  ].join("\n"));
  const previous = {
    gate: process.env.CYBERBOSS_ROUTE2_GATE_ENABLED,
    override: process.env.CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED,
    catalog: process.env.CYBERBOSS_TOOL_CATALOG_ENABLED,
  };
  process.env.CYBERBOSS_ROUTE2_GATE_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED = "true";
  process.env.CYBERBOSS_TOOL_CATALOG_ENABLED = "true";
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [commandFile],
    claudeDisableVerbose: true,
  });
  try {
    const first = await adapter.sendTurn({ bindingKey: "binding-lease", workspaceRoot, text: "fixture opening" });
    assert.equal(first.threadId, sessionId);
    const grant = await adapter.grantRoute2Lease({
      bindingKey: "binding-lease",
      workspaceRoot,
      taskId: "task-lease-fake",
      ttlMs: 10_000,
      plan: {
        catalog: [{ id: "cyberboss_time", estimated_schema_chars: 10, max_result_bytes: 64, authorized: true }],
        toolNames: ["cyberboss_time"],
        expectedContextTokens: 100,
      },
      override: {
        effectiveToolset: "full",
        harnessOverlay: [{ label: "route2-grant-fake", text: "Use only the fixture operation." }],
      },
    });
    assert.equal(grant.granted, true);
    assert.equal(grant.windowIdBefore, sessionId);
    assert.equal(grant.windowIdAfter, sessionId);
    assert.ok(grant.overrideFingerprint);
    assert.equal(grant.lease.toolNames[0], "cyberboss_time");
    // The tool can only be called from inside a turn, so the relaunch waits for
    // the boundary. Relaunching inline killed the asking turn on the first real
    // grant: lease issued, reply lost to `Runtime process exited unexpectedly`.
    assert.equal(grant.deferred, true);
    // The next turn is the one that opens wide, resuming the identical window.
    const second = await adapter.sendTurn({ bindingKey: "binding-lease", workspaceRoot, text: "next turn" });
    assert.equal(second.threadId, sessionId, "still the same session after the escalation relaunch");
    const launches = (await waitForFileText(launchLog, /--resume/)).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(launches.length >= 2, true);
    assert.equal(launches.at(-1)[launches.at(-1).indexOf("--resume") + 1], sessionId);
  } finally {
    await adapter.close();
    for (const [key, value] of Object.entries({
      CYBERBOSS_ROUTE2_GATE_ENABLED: previous.gate,
      CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: previous.override,
      CYBERBOSS_TOOL_CATALOG_ENABLED: previous.catalog,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("claudecode runtime params are isolated from codex model selections", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `cyberboss-runtime-params-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });
  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });

  codexStore.setRuntimeParamsForWorkspace("binding-1", "/workspace", {
    model: "gpt-5.5",
    modelProvider: "openai",
  });

  assert.deepEqual(claudecodeStore.getRuntimeParamsForWorkspace("binding-1", "/workspace"), {
    model: "",
    modelProvider: "",
  });

  claudecodeStore.setRuntimeParamsForWorkspace("binding-1", "/workspace", {
    model: "deepseek-v4-pro",
  });

  assert.deepEqual(codexStore.getRuntimeParamsForWorkspace("binding-1", "/workspace"), {
    model: "gpt-5.5",
    modelProvider: "openai",
  });
  assert.deepEqual(claudecodeStore.getRuntimeParamsForWorkspace("binding-1", "/workspace"), {
    model: "deepseek-v4-pro",
    modelProvider: "",
  });
});

test("claudecode adapter does not pass a codex-selected model to Claude Code", async () => {
  const tempDir = fs.mkdtempSync(path.join("/tmp", "cb-claude-model-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionsFile = path.join(tempDir, "sessions.json");
  const argsFile = path.join(tempDir, "args.json");
  const commandFile = path.join(tempDir, "fake-claude.js");
  const sessionId = "22222222-2222-4222-8222-222222222222";
  new SessionStore({ filePath: sessionsFile, runtimeId: "codex" })
    .setRuntimeParamsForWorkspace("binding-1", workspaceRoot, {
      model: "gpt-5.5",
      modelProvider: "openai",
    });
  fs.writeFileSync(commandFile, [
    "#!/usr/bin/env node",
    `const fs = require("node:fs");`,
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    "process.stdin.on(\"data\", () => {",
    `  console.log(JSON.stringify({ type: "system", session_id: ${JSON.stringify(sessionId)} }));`,
    "  process.exit(0);",
    "});",
  ].join("\n"));
  fs.chmodSync(commandFile, 0o755);

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile,
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [commandFile],
    claudePermissionMode: "default",
    claudeDisableVerbose: true,
    claudeExtraArgs: [],
  });

  try {
    await adapter.sendTurn({
      bindingKey: "binding-1",
      workspaceRoot,
      text: "hello",
    });
    const args = JSON.parse(await waitForFileText(argsFile, /]/));
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("gpt-5.5"), false);
    assert.deepEqual(adapter.getSessionStore().getRuntimeParamsForWorkspace("binding-1", workspaceRoot), {
      model: "",
      modelProvider: "",
    });
  } finally {
    await adapter.close();
  }
});

test("claudecode process client rejects a different resumed session id", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/workspace",
    env: {},
  });
  client.pendingTurnId = "turn-resume";
  client.activeThreadId = "33333333-3333-4333-8333-333333333333";
  const events = [];
  client.onMessage((event) => {
    events.push(event);
  });

  client.handleLine(JSON.stringify({
    type: "system",
    session_id: "44444444-4444-4444-8444-444444444444",
  }));

  assert.deepEqual(events.map((event) => event.type), ["process.error"]);
  assert.equal(events[0].sessionId, "33333333-3333-4333-8333-333333333333");
  assert.match(events[0].error, /unexpected session id/);
  assert.equal(client.sessionId, "");
});

test("claudecode process client rejects a different session id before the next turn", () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/workspace",
    env: {},
  });
  client.resumeSessionId = "55555555-5555-4555-8555-555555555555";
  const events = [];
  client.onMessage((event) => {
    events.push(event);
  });

  client.handleLine(JSON.stringify({
    type: "system",
    session_id: "66666666-6666-4666-8666-666666666666",
  }));

  assert.deepEqual(events.map((event) => event.type), ["process.error"]);
  assert.equal(events[0].sessionId, "55555555-5555-4555-8555-555555555555");
  assert.equal(events[0].turnId, "");
  assert.equal(client.sessionId, "");
  assert.equal(client.resumeSessionId, "55555555-5555-4555-8555-555555555555");
});

test("handleRuntimeEvent prompts for project shell commands instead of auto-approving them", async () => {
  const prompts = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        throw new Error(`should not auto-approve ${JSON.stringify(payload)}`);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-3",
      commandTokens: ["cyberboss", "timeline", "write", "--date", "2026-04-17"],
    },
  });

  assert.equal(prompts.length, 1);
});

test("handleNewCommand asks runtime to start a fresh draft before clearing the saved thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      startFreshThreadDraft: async ({ workspaceRoot }) => {
        calls.push(["fresh", workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clear", bindingKey, workspaceRoot]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleNewCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["fresh", "/workspace"],
    ["clear", "binding-1", "/workspace"],
    ["send", "✅ Switched to a fresh thread draft\nworkspace: /workspace"],
  ]);
});

test("handleCompactCommand invokes runtime compaction for the current thread", async () => {
  const calls = [];
  const appLike = {
    pendingOperationByRunKey: new Map(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    streamDelivery: {
      queueReplyTargetForThread(threadId, payload) {
        calls.push(["queue", threadId, payload.userId, payload.contextToken, payload.provider]);
      },
    },
    runtimeAdapter: {
      async compactThread(payload) {
        calls.push(["compact", payload.threadId, payload.workspaceRoot, payload.model]);
        return { threadId: payload.threadId, turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-sonnet" };
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  });

  assert.deepEqual(calls, [
    ["queue", "thread-1", "user-1", "ctx-1", "weixin"],
    ["compact", "thread-1", "/workspace", "claude-sonnet"],
    ["send", "🗜️ Compact request sent\nthread: thread-1"],
  ]);
  assert.equal(appLike.pendingOperationByRunKey.get("thread-1:turn-1")?.kind, "compact");
});

test("handleCompactCommand reports when there is no active thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    "💡 There is no active thread yet. Send a normal message first.",
  ]);
});

test("handleStopCommand passes workspaceRoot through to runtime cancellation", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    threadStateStore: {
      getThreadState(threadId) {
        calls.push(["state", threadId]);
        return {
          threadId,
          turnId: "turn-1",
          status: "running",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(["cancel", payload.threadId, payload.turnId, payload.workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["state", "thread-1"],
    ["cancel", "thread-1", "turn-1", "/workspace"],
    ["send", "⏹️ Stop request sent\nthread: thread-1"],
  ]);
});

test("handleStopCommand allows stopping while waiting for approval", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    threadStateStore: {
      getThreadState() {
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "waiting_approval",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(payload);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.equal(calls[0].workspaceRoot, "/workspace");
  assert.equal(calls[1], "⏹️ Stop request sent\nthread: thread-1");
});

test("handleRuntimeEvent reports compact completion back to WeChat", async () => {
  const sent = [];
  const appLike = {
    pendingOperationByRunKey: new Map([
      ["thread-1:turn-1", {
        kind: "compact",
        userId: "user-1",
        contextToken: "ctx-1",
      }],
    ]),
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    desireUsageByRunKey: new Map(),
    async synchronizeRecallTrace() {},
    handleCompletedRuntimeTurn() {},
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    hasPendingInboundMessage() {
      return false;
    },
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });

  assert.deepEqual(sent, ["✅ Compact finished\nthread: thread-1"]);
  assert.equal(appLike.pendingOperationByRunKey.size, 0);
});
test("handleRuntimeEvent auto-approves built-in view_image approvals without prompting", async () => {
  const responses = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for view_image");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-img-2",
      commandTokens: ["view_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves project-native MCP tool approvals without prompting", async () => {
  const responses = [];
  const appLike = {
    config: { stateDir: path.join(os.tmpdir(), "cyberboss-approval-test") },
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for project-native MCP tools");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-project-tool",
      commandTokens: ["mcp_tool", "cyberboss_tools", "cyberboss_timeline_write"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-project-tool", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves inbox image reads for claudecode without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "cyberboss-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for inbox image read");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-2",
      filePath: path.join(stateDir, "inbox", "2026-04-17", "attachment.jpg"),
      commandTokens: ["read_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-read-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves any state-dir file operation without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "cyberboss-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for state-dir file operation");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-write-2",
      filePath: path.join(stateDir, "notes", "today.md"),
      filePaths: [path.join(stateDir, "notes", "today.md")],
      commandTokens: [],
      reason: "Tool: Write",
      command: "Write\nfile_path: \"/tmp/cyberboss-approval-test/notes/today.md\"",
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-write-2", decision: "accept" }]);
});

test("handleRuntimeEvent still prompts for non-inbox image reads", async () => {
  const responses = [];
  const prompts = [];
  const stateDir = path.join(os.tmpdir(), "cyberboss-approval-test");
  const appLike = {
    config: { stateDir },
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-3",
      filePath: "/Users/tingyiwen/Desktop/photo.jpg",
      commandTokens: ["read_image"],
      reason: "Tool: Read",
      command: "Read\nfile_path: \"/Users/tingyiwen/Desktop/photo.jpg\"",
    },
  });

  assert.deepEqual(responses, []);
  assert.equal(prompts.length, 1);
});

test("handleRuntimeEvent auto-approves allowlisted prefixes for claudecode approvals", async () => {
  const responses = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [["npm", "run", "timeline:build"]];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for allowlisted commands");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-4",
      commandTokens: ["npm", "run", "timeline:build", "--", "--locale", "en"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-4", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves allowlisted MCP tool approvals", async () => {
  const responses = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun: resolveNoReplyTargetForRuntimeEvent,
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalCommandAllowlistForWorkspace() {
            return [["mcp_tool", "cyberboss_tools", "cyberboss_timeline_write"]];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for allowlisted MCP tools");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-mcp-allow",
      commandTokens: ["mcp_tool", "cyberboss_tools", "cyberboss_timeline_write"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-mcp-allow", decision: "accept" }]);
});

test("handleSwitchCommand stores the verified claudecode thread returned by runtime", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async resumeThread({ threadId, workspaceRoot }) {
        calls.push(["resume", threadId, workspaceRoot]);
        return { threadId: "actual-thread" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-sonnet", modelProvider: "" };
          },
          setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["set", bindingKey, workspaceRoot, threadId]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleSwitchCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "target-thread",
  });

  assert.deepEqual(calls, [
    ["resume", "target-thread", "/workspace"],
    ["set", "binding-1", "/workspace", "actual-thread"],
    ["send", "✅ Thread switched\nworkspace: /workspace\nthread: actual-thread"],
  ]);
});

test("handleSwitchCommand reports refusal and does not claim success on a slot mismatch", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async resumeThread({ threadId, workspaceRoot }) {
        calls.push(["resume", threadId, workspaceRoot]);
        // Adapter refuses a caller-supplied id that is not this slot's stored session.
        return { threadId: "current-thread", resumed: false, empty: false, refused: "slot_mismatch" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-sonnet", modelProvider: "" };
          },
          setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["set", bindingKey, workspaceRoot, threadId]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await CyberbossApp.prototype.handleSwitchCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "target-thread",
  });

  // The stored thread must NOT change on refusal, and the reply must not claim success.
  assert.ok(!calls.some((entry) => entry[0] === "set"), "must not change the stored thread on refusal");
  const sends = calls.filter((entry) => entry[0] === "send").map((entry) => entry[1]);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /Switch refused/);
  assert.ok(!sends[0].includes("Thread switched"), "must not claim the switch succeeded");
});

test("session store does not reuse legacy thread ids across runtimes", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `cyberboss-session-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "codex-thread",
        },
      },
    },
  }, null, 2));

  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(claudecodeStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
});

test("codex session store reads runtime-scoped thread ids", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `cyberboss-codex-runtime-scoped-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "/workspace": "codex-thread",
          },
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "codex-thread");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), ["/workspace"]);
  assert.deepEqual(codexStore.findBindingForThreadId("codex-thread"), {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });
});

test("codex session store does not reuse legacy thread ids without runtime-scoped binding", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `cyberboss-codex-thread-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "legacy-codex-thread",
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), []);
  assert.equal(codexStore.findBindingForThreadId("legacy-codex-thread"), null);
});

test("handleStatusCommand asks to configure claudecode context window before showing context", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeModel: "claude-sonnet",
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "claudecode",
          currentTokens: 18000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW/);
});

test("handleStatusCommand shows approximate context details for claudecode when configured", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 64000,
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: approx 18k\/66k \| 73% left \| reserve 64k/);
});

test("handleStatusCommand asks to reduce claudecode max output tokens when reserve exceeds window", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 140000,
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS/);
});

test("handleStatusCommand shows codex context details", async () => {
  const sent = [];
  const appLike = {
    config: {},
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "codex",
          currentTokens: 1234,
          contextWindow: 200000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: 1.2k\/200k \| 99% left/);
});

test("handleStatusCommand shows codex context as unavailable when no context data is available", async () => {
  const sent = [];
  const appLike = {
    config: {},
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: unavailable/);
});

// 2026-08-06 Owner report: /status kept printing the profile's configured model
// (claude-fable-5) after /model had switched the live child to claude-opus-4-6.
// Root cause: /status read `describe().model` — always non-empty — instead of the
// window-override ladder /model itself uses. These pin the two to one ladder.
function buildStatusAppLike({ sent, describeModel, storedModel, storedEffort = "", windowOverride, status = "idle" }) {
  return {
    config: {},
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    resolveLaunchProfileForLane() {
      return { profileId: "fable-chat" };
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode", model: describeModel };
      },
      getWindowOverride() {
        return windowOverride;
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: storedModel, effort: storedEffort };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };
}

const STATUS_NORMALIZED = {
  workspaceId: "default",
  accountId: "account-1",
  senderId: "user-1",
  contextToken: "ctx-1",
};

test("handleStatusCommand reports the window override model, not the profile default", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "claude-fable-5",
    windowOverride: { enabled: true, value: { model: "claude-opus-4-6" } },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /🤖 model: claude-opus-4-6/);
  assert.doesNotMatch(sent[0], /🤖 model: claude-fable-5/);
});

test("handleStatusCommand reads the override model out of the trace when value is absent", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    windowOverride: {
      enabled: true,
      value: {},
      trace: { entries: [{ kind: "model", effective_value: "claude-opus-4-6" }] },
    },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /🤖 model: claude-opus-4-6/);
});

test("handleStatusCommand falls back to the stored workspace model when no window override is active", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "claude-sonnet-5",
    windowOverride: { enabled: false },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /🤖 model: claude-sonnet-5/);
});

test("handleStatusCommand falls back to the runtime default only when nothing is stored", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    windowOverride: { enabled: false },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /🤖 model: claude-fable-5/);
});

// Owner 2026-08-07: /status should show effort too, and it must come off the same
// ladder as /effort — the whole point of this batch is that two commands reading
// the same thing by different routes is how they end up disagreeing.
test("handleStatusCommand reports the window override effort", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    storedEffort: "low",
    windowOverride: { enabled: true, value: { effort: "high" } },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /⚡ effort: high/);
});

test("handleStatusCommand falls back to the stored effort when no window override is active", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    storedEffort: "low",
    windowOverride: { enabled: false },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /⚡ effort: low/);
});

test("handleStatusCommand never prints an empty effort", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    storedEffort: "",
    windowOverride: { enabled: false },
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /⚡ effort: (minimal|low|medium|high)/);
});

// Owner could not tell whether "idle" described the lane or described her.
test("handleStatusCommand glosses the thread status token in plain language", async () => {
  const cases = [
    ["idle", /📊 status: idle · 空闲，这条 lane 没有正在跑的回合/],
    ["running", /📊 status: running · 正在跑一个回合/],
    ["waiting_approval", /📊 status: waiting_approval · 卡在等你批准/],
    ["failed", /📊 status: failed · 上一个回合失败了/],
  ];
  for (const [status, expected] of cases) {
    const sent = [];
    const appLike = buildStatusAppLike({
      sent,
      describeModel: "claude-fable-5",
      storedModel: "",
      windowOverride: { enabled: false },
      status,
    });
    await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);
    assert.match(sent[0], expected);
  }
});

test("handleStatusCommand passes an unknown status token through rather than mislabelling it", async () => {
  const sent = [];
  const appLike = buildStatusAppLike({
    sent,
    describeModel: "claude-fable-5",
    storedModel: "",
    windowOverride: { enabled: false },
    status: "some_future_state",
  });

  await CyberbossApp.prototype.handleStatusCommand.call(withAppPrototype(appLike), STATUS_NORMALIZED);

  assert.match(sent[0], /📊 status: some_future_state$/m);
});

// ---------------------------------------------------------------------------
// runtime.process.launched notice (Owner 2026-08-07: "开新进程自动发status").
//
// Since D37 a child is swapped mid-conversation — escalation relaunches on the
// turn boundary, TTL recovery puts the narrow face back — and that used to be
// entirely invisible to her. The hard constraint is the audience: a Route 1
// worker also spawns a child, under a different launch profile, and that one is
// not her window. It must never announce itself into her chat.
// ---------------------------------------------------------------------------
function launchNoticeApp({ sent, chatProfileId, throwOnSend = false }) {
  return Object.setPrototypeOf({
    config: { channel: "telegram", telegramAllowedUserIds: ["owner-1"], workspaceRoot: "/workspace" },
    activeAccountId: "account-1",
    runtimeAdapter: {
      getSessionStore: () => ({ buildBindingKey: () => "binding-1" }),
    },
    telegramProfileRouter: {
      select: () => (chatProfileId ? { status: "matched", profileId: chatProfileId } : { status: "unmapped" }),
    },
    channelAdapter: {
      getKnownContextTokens: () => ({ "owner-1": "ctx-owner" }),
      sendText: async (payload) => {
        if (throwOnSend) {
          throw new Error("telegram unreachable");
        }
        sent.push(payload);
      },
    },
  }, CyberbossApp.prototype);
}

const LAUNCH_PAYLOAD = {
  threadId: "sess-1",
  laneKey: "tg/fable-chat",
  profileId: "fable-chat",
  model: "claude-opus-4-6",
  effort: "high",
  resumed: true,
};

test("a new child on her own lane announces itself with what it came back as", async () => {
  const sent = [];
  await CyberbossApp.prototype.announceProcessLaunch.call(
    launchNoticeApp({ sent, chatProfileId: "fable-chat" }),
    LAUNCH_PAYLOAD,
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, "owner-1");
  assert.equal(sent[0].contextToken, "ctx-owner");
  assert.match(sent[0].text, /♻️ 新的子进程接管了这条 lane/);
  assert.match(sent[0].text, /🤖 model: claude-opus-4-6/);
  assert.match(sent[0].text, /⚡ effort: high/);
  assert.match(sent[0].text, /已 --resume 原会话/);
});

test("a brand new session says so instead of claiming the context survived", async () => {
  const sent = [];
  await CyberbossApp.prototype.announceProcessLaunch.call(
    launchNoticeApp({ sent, chatProfileId: "fable-chat" }),
    { ...LAUNCH_PAYLOAD, resumed: false },
  );

  assert.match(sent[0].text, /🧵 新会话/);
  assert.doesNotMatch(sent[0].text, /resume/);
});

test("a Route 1 worker's child never announces itself into her chat", async () => {
  const sent = [];
  await CyberbossApp.prototype.announceProcessLaunch.call(
    launchNoticeApp({ sent, chatProfileId: "fable-chat" }),
    { ...LAUNCH_PAYLOAD, profileId: "work-engineering" },
  );

  assert.equal(sent.length, 0, "the engineering worker is not her window");
});

test("the launch notice stays silent when the lane has no chat profile mapped", async () => {
  const sent = [];
  await CyberbossApp.prototype.announceProcessLaunch.call(
    launchNoticeApp({ sent, chatProfileId: "" }),
    LAUNCH_PAYLOAD,
  );

  assert.equal(sent.length, 0);
});

test("the launch notice stays silent on an incomplete payload", async () => {
  for (const payload of [
    { ...LAUNCH_PAYLOAD, laneKey: "" },
    { ...LAUNCH_PAYLOAD, threadId: "" },
    {},
    undefined,
  ]) {
    const sent = [];
    await CyberbossApp.prototype.announceProcessLaunch.call(
      launchNoticeApp({ sent, chatProfileId: "fable-chat" }),
      payload,
    );
    assert.equal(sent.length, 0);
  }
});

test("a failed launch notice never propagates into the lane", async () => {
  // Fail-open: a diagnostic courtesy must not become a way to break her chat.
  await CyberbossApp.prototype.announceProcessLaunch.call(
    launchNoticeApp({ sent: [], chatProfileId: "fable-chat", throwOnSend: true }),
    LAUNCH_PAYLOAD,
  );
});

async function waitForFileText(filePath, pattern, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8");
      if (!pattern || pattern.test(text)) {
        return text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

// 这个闸门是**省 token 的路由器，不是权限闸**（D13 / 不变量 3：chat 全权不减）。
// 它曾把"没点名任何 MCP 工具"的计划判成 no_tools 硬理由送去 Route 1 ——
// 而那恰好是最省的一种计划，也正是"她只想要宽工具面"的形状。以省 token 之名
// 削掉行动能力，方向是反的。
test("route2 gate routes by cost, never denies capability for naming no tools", () => {
  const on = { CYBERBOSS_ROUTE2_GATE_ENABLED: "1" };
  const decide = (plan) => decideRoute2Gate(plan, { env: on });

  // 空计划留在 chat：最省的计划不该被赶去 Route 1。
  assert.equal(decide({}).route, "route2");
  assert.deepEqual(decide({}).reasons, ["within_soft_limit"]);

  // 结构性硬理由一条不减 —— 这些是真的做不动或真的贵，不是权限判断。
  for (const hard of ["repositoryWork", "subagent", "parallel", "longLoop", "fullEngineeringHarness"]) {
    assert.equal(decide({ [hard]: true }).route, "route1", `${hard} must still route to route1`);
  }
  assert.equal(decide({ expectedContextTokens: 999999 }).route, "route1");
  assert.deepEqual(decide({ expectedContextTokens: 999999 }).reasons, ["context_hard_limit"]);

  // 点了名的工具仍须有服务端字节预算，否则结果无界。
  const unbounded = { catalog: [{ id: "x", authorized: true, max_result_bytes: null, estimated_schema_chars: 10 }], toolNames: ["x"] };
  assert.deepEqual(decide(unbounded).reasons, ["unbounded_result"]);

  // 开关关闭时整条判定不存在。
  assert.equal(decideRoute2Gate({}, { env: {} }), null);
});

test("T08 A12 route2_escalate 经真 IPC socket 到达门控（import 回归）", async () => {
  // 这条测试只为一件事存在。`route2.escalate` 的 IPC 处理器调用了一个从未 import
  // 进 index.js 的 `route2GateEnabled`，于是**每一次**升格请求都在门控那一行抛
  // ReferenceError —— 生产上 route2 升格从来没有成功过一次。适配器上的
  // `grantRoute2Lease` 单测（T08 A1/A11）照样全绿，因为它绕过了处理器直接调方法。
  // 缺的是从子进程那侧发一条真消息进来。所以这里必须走真 socket，不许走捷径。
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-route2-ipc-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  const commandFile = path.join(tempDir, "fake-route2-ipc-claude.js");
  const sessionId = "33333333-3333-4333-8333-333333333333";
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(commandFile, [
    "#!/usr/bin/env node",
    "process.stdin.on('data', () => {",
    `  console.log(JSON.stringify({ type: 'system', session_id: ${JSON.stringify(sessionId)} }));`,
    `  console.log(JSON.stringify({ type: 'result', session_id: ${JSON.stringify(sessionId)}, result: 'fixture done' }));`,
    "});",
  ].join("\n"));
  const previous = {
    gate: process.env.CYBERBOSS_ROUTE2_GATE_ENABLED,
    override: process.env.CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED,
  };
  process.env.CYBERBOSS_ROUTE2_GATE_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED = "true";
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [commandFile],
    claudeDisableVerbose: true,
  });
  try {
    await adapter.initialize();
    const first = await adapter.sendTurn({ bindingKey: "binding-ipc", workspaceRoot, text: "fixture opening" });
    assert.equal(first.threadId, sessionId);

    // The app layer owns the origin route, exactly as it does for Route 1: the
    // child knows its turn, not its lane. Without this registration the adapter
    // refuses (`route2_escalate_unwired`) rather than guessing a route.
    let seenContext = null;
    adapter.onRoute2EscalateRequest((args, context) => {
      seenContext = context;
      return adapter.grantRoute2Lease({
        bindingKey: "binding-ipc",
        workspaceRoot,
        taskId: args.taskId || "",
        tier: args.tier,
        ttlMs: args.ttlMs,
      });
    });

    // tool-host 就是这样调的：同一个客户端、同一条鉴权 socket。
    const client = new Route1DispatchIpcClient({ stateDir, timeoutMs: 15_000 });
    const result = await client.escalateRoute2(
      { reason: "regression: the handler must reach the gate", tier: "wide", ttlMs: 10_000 },
      { turnId: "turn-ipc-fixture", workspaceRoot },
    );
    assert.equal(seenContext?.turnId, "turn-ipc-fixture", "the origin turn id must survive the socket");

    assert.equal(result.granted, true, "空计划落在软限内，门控应当放行");
    assert.equal(result.windowIdBefore, sessionId);
    assert.equal(result.windowIdAfter, sessionId, "升格是同窗恢复，不换 session");
    assert.ok(result.lease?.id, "放行必须带一把 lease，否则回收无从谈起");
    assert.equal(result.decision.route, "route2");
    // Nothing was in flight here, so the wide face may open immediately.
    assert.equal(result.deferred, true, "升格永远落在任务边界，不在提出请求的那一轮生效");
  } finally {
    await adapter.close();
    for (const [key, value] of Object.entries({
      CYBERBOSS_ROUTE2_GATE_ENABLED: previous.gate,
      CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: previous.override,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("T08 A14 a revoked lease written back must never break the next read", () => {
  // 2026-08-06 真机：回收把 lease 写回持久化的 window override，而 normalizeLease
  // 早就把 sessionSlotKey/windowId 丢了，于是下一次读取 safeId 抛错，
  // `poll failed: capabilityLease.sessionSlotKey is not a safe identifier`
  // 连着打断轮询与启动恢复。两头都补：normalize 保留身份，读回已作废的 lease 直接丢弃。
  const env = { CYBERBOSS_ROUTE2_GATE_ENABLED: "1", CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "1" };
  const { state } = beginLeaseFixture({ now: () => 5_000 });
  const held = state.get("slot-lease-fake").lease;
  assert.equal(held.sessionSlotKey, "slot-lease-fake", "identity must survive normalization");
  assert.equal(held.status, "active");

  // The exact shape revocation persists.
  const revokedOverride = { capabilityLease: { ...held, status: "revoked" } };
  const resolved = resolveWindowOverride(revokedOverride, { env });
  assert.equal(resolved.capabilityLease, null, "a spent lease is dropped, not rethrown");

  // Even a lease persisted by the old, lossy shape must not throw on read.
  const legacy = { capabilityLease: { id: "route2-legacy", status: "revoked", expiresAt: 1, toolNames: [] } };
  assert.doesNotThrow(() => resolveWindowOverride(legacy, { env }));

  // An *active* lease with a missing identity is still a hard error: granting
  // must fail closed.
  assert.throws(
    () => resolveWindowOverride({ capabilityLease: { id: "x", status: "active", expiresAt: 9e12, toolNames: [] } }, { env }),
    /capabilityLease.sessionSlotKey/u,
  );
});
