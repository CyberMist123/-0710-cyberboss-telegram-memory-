const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildInstructionRefreshText, buildOpeningTurnText } = require("../src/adapters/runtime/shared-instructions");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { ContextTraceRecorder } = require("../src/core/context-trace");
const { loadCurrentState } = require("../src/core/current-state");
const {
  finalizeOpeningContext,
  prepareOpeningContext,
  prepareOrdinaryContext,
  prepareRefreshContext,
} = require("../src/core/hard-context");
const { countNonWhitespace, loadReentry } = require("../src/core/reentry-loader");
const { validateStartupPreflight } = require("../src/core/startup-preflight");
const { CyberbossApp } = require("../src/core/app");

test("reentry is injected once per persisted thread without template rewriting", () => {
  const root = fixtureRoot();
  const reentryFile = path.join(root, "continuity", "reentry.md");
  const promptFile = path.join(root, "prompt.md");
  const sessionsFile = path.join(root, "state", "sessions.json");
  fs.mkdirSync(path.dirname(reentryFile), { recursive: true });
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(promptFile, "你面对的是{{USER_NAME}}，她会被 persona 模板替换。", "utf8");
  const body = "她说过：先留在这里。\n";
  fs.writeFileSync(reentryFile, body, "utf8");
  const config = {
    reentryFile,
    desireStateFile: path.join(root, "missing-desire.json"),
    weixinInstructionsFile: promptFile,
    userName: "Fixture",
    userGender: "male",
    channel: "telegram",
  };
  let store = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });
  const context = prepareOpeningContext({ config, sessionStore: store, threadId: "thread-1", reason: "new_thread" });
  const rendered = buildOpeningTurnText(config, "现在说什么？", context);
  assert.match(rendered, /<<<CB_CTX:REENTRY v1 hash=[a-f0-9]{64} chars=10>>>/);
  assert.match(rendered, /她说过：先留在这里。/);
  assert.ok(rendered.indexOf("TELEGRAM SESSION INSTRUCTIONS") < rendered.indexOf("<<<CB_CTX:REENTRY"));
  assert.ok(rendered.indexOf("<<<END_CB_CTX>>>") < rendered.indexOf("Current user message:"));
  assert.equal(context.reentry.text, body);
  finalizeOpeningContext(context, { sessionStore: store, threadId: "thread-1", outboundText: rendered });

  store = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });
  const second = prepareOpeningContext({ config, sessionStore: store, threadId: "thread-1", reason: "new_thread" });
  assert.equal(second.reentry, null);
  assert.deepEqual(second.skipped.find((item) => item.type === "reentry"), {
    type: "reentry",
    reason: "already_injected",
  });
});

test("missing empty and over-budget reentry fail open without truncation", () => {
  const root = fixtureRoot();
  const filePath = path.join(root, "reentry.md");
  assert.equal(loadReentry({ filePath }).skipped, "missing");
  fs.writeFileSync(filePath, " \n\t", "utf8");
  assert.equal(loadReentry({ filePath }).skipped, "missing");
  const body = "她".repeat(301);
  fs.writeFileSync(filePath, body, "utf8");
  const result = loadReentry({ filePath });
  assert.equal(result.skipped, "over_budget");
  assert.equal(result.chars, 301);
  assert.equal(result.text, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8"), body);
});

test("reentry hash matches the original injected file bytes", () => {
  const root = fixtureRoot();
  const filePath = path.join(root, "reentry.md");
  const bytes = Buffer.from("原文保留她与结尾换行\n", "utf8");
  fs.writeFileSync(filePath, bytes);
  const result = loadReentry({ filePath });
  assert.equal(result.text, bytes.toString("utf8"));
  assert.equal(result.hash, crypto.createHash("sha256").update(bytes).digest("hex"));
});

test("reentry metadata is a fresh injection view and expiry hooks respect the injected clock", () => {
  const root = fixtureRoot();
  const continuityDir = path.join(root, "continuity");
  const filePath = path.join(continuityDir, "reentry.md");
  const episodesFile = path.join(continuityDir, "episodes.jsonl");
  fs.mkdirSync(continuityDir, { recursive: true });
  const original = [
    "今天仍有效 <!-- until: 2026-07-20 -->",
    "昨天失效 <!-- until: 2026-07-19 -->",
    "没有期限",
  ].join("\n");
  fs.writeFileSync(filePath, original, "utf8");
  fs.writeFileSync(episodesFile, [
    JSON.stringify({ id: "ep-2", time: "2026-07-14T09:00:00+08:00" }),
    "{broken",
    JSON.stringify({ id: "ep-1", created_at: "2026-06-30" }),
  ].join("\n"), "utf8");

  const result = loadReentry({ filePath, episodesFile, now: new Date("2026-07-20T10:00:00+10:00") });
  assert.match(result.text, /^今天仍有效\s*\n没有期限/mu);
  assert.doesNotMatch(result.text, /until:|昨天失效/u);
  assert.match(result.text, /episodes 共 2 条，最早至 2026-06，细节你现在读不到/u);
  assert.equal(result.chars, countNonWhitespace("今天仍有效\n没有期限"));
  assert.equal(fs.readFileSync(filePath, "utf8"), original);

  const gated = prepareOpeningContext({
    config: { reentryFile: filePath, continuityDir, desireStateFile: path.join(root, "missing.json"), stateDir: path.join(root, "state") },
    sessionStore: { getReentryInjection: () => null }, threadId: "thread-meta",
  });
  assert.match(gated.reentry.text, /episodes 共 2 条/u);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "context-gates.json"), JSON.stringify({ reentry: false }), "utf8");
  const off = prepareOpeningContext({
    config: { reentryFile: filePath, continuityDir, desireStateFile: path.join(root, "missing.json"), stateDir },
    sessionStore: { getReentryInjection: () => null }, threadId: "thread-off",
  });
  assert.equal(off.reentry, null);
  assert.deepEqual(off.skipped.find((item) => item.type === "reentry"), { type: "reentry", reason: "gated_off" });
});

test("current state is read-only, bounded, and appears only in opening or refresh", () => {
  const root = fixtureRoot();
  const desireStateFile = path.join(root, "desire-state.json");
  fs.writeFileSync(desireStateFile, JSON.stringify({
    intent: { drive_key: "reflection", want_action: "co_read", reason: "想安静看一会儿" },
  }), "utf8");
  const currentState = loadCurrentState({ filePath: desireStateFile });
  assert.ok(currentState.chars <= 100);
  const refresh = prepareRefreshContext({ config: { desireStateFile }, reason: "user_switch" });
  const refreshText = buildInstructionRefreshText({}, refresh);
  assert.match(refreshText, /CB_CTX:CURRENT_STATE/);
  assert.doesNotMatch(refreshText, /CB_CTX:REENTRY/);
  const ordinary = prepareOrdinaryContext("ordinary turn");
  assert.equal(ordinary.blocks.length, 0);
  assert.equal(fs.readFileSync(desireStateFile, "utf8").includes("reflection"), true);
});

test("current state summarizes the desire report shape without intent", () => {
  const root = fixtureRoot();
  const desireStateFile = path.join(root, "desire-state.json");
  fs.writeFileSync(desireStateFile, JSON.stringify({
    most_want: "想知道她现在在做什么，周日下午两点，她是不是还在睡、在赖床、还是已经起了在发呆",
    drives: [
      { key: "attachment", label: "依恋", score: 0.7, change: "steady" },
      { key: "duty", label: "责任", score: 0.5, change: "up" },
      { key: "curiosity", label: "好奇", score: 0.3, change: "down" },
    ],
  }), "utf8");
  const currentState = loadCurrentState({ filePath: desireStateFile });
  assert.equal(currentState.skipped, undefined);
  assert.ok(currentState.chars <= 100);
  assert.match(currentState.text, /^此刻:想知道她现在在做什么/u);
  assert.match(currentState.text, /依恋0\.7 责任0\.5↑/u);
  const overlong = { most_want: "她".repeat(200), drives: [] };
  fs.writeFileSync(desireStateFile, JSON.stringify(overlong), "utf8");
  const truncated = loadCurrentState({ filePath: desireStateFile });
  assert.equal(truncated.skipped, undefined);
  assert.ok(truncated.chars <= 100);
  assert.match(truncated.text, /…$/u);
});

test("manual current-state override is the exact bounded injected text", () => {
  const root = fixtureRoot();
  const desireStateFile = path.join(root, "desire-state.json");
  const overrideFilePath = path.join(root, "context-current-state.md");
  fs.writeFileSync(desireStateFile, JSON.stringify({ intent: { drive_key: "duty" } }), "utf8");
  fs.writeFileSync(overrideFilePath, "此刻我想先听她把话说完。", "utf8");
  const currentState = loadCurrentState({ filePath: desireStateFile, overrideFilePath });
  assert.equal(currentState.text, "此刻我想先听她把话说完。");
  assert.equal(currentState.source, "manual_override");
  fs.writeFileSync(overrideFilePath, "", "utf8");
  assert.match(loadCurrentState({ filePath: desireStateFile, overrideFilePath }).text, /姿态:duty/u);
});

test("session store persists the hard-context fingerprint per runtime and workspace", () => {
  const root = fixtureRoot();
  const sessionsFile = path.join(root, "state", "sessions.json");
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  let store = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  store.setContextFingerprintForWorkspace("binding", "/workspace", "fingerprint-a");
  store = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  assert.equal(store.getContextFingerprintForWorkspace("binding", "/workspace"), "fingerprint-a");
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });
  assert.equal(codexStore.getContextFingerprintForWorkspace("binding", "/workspace"), "");
});

test("context trace records evidence only and defaults old archives to hidden", async () => {
  const root = fixtureRoot();
  const filePath = path.join(root, "trace", "context_trace.jsonl");
  const recorder = new ContextTraceRecorder({ filePath });
  await recorder.record({
    threadId: "secret-thread-id",
    turnId: "turn-1",
    opening: true,
    blocks: [{ type: "reentry", loaded: true, reason: "thread_recreated", chars: 12, hash: "abc", src_mtime: "now" }],
    skipped: [],
    total_chars: 42,
    userText: "private user body",
    replyText: "private reply body",
    memoryBody: "private memory body",
  });
  await recorder.flush();
  const raw = fs.readFileSync(filePath, "utf8");
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.thread.length, 8);
  assert.notEqual(entry.thread, "secret-thread-id");
  assert.equal(entry.blocks[0].reason, "thread_recreated");
  for (const type of ["episodes", "timeline", "portrait", "self_note", "rereadings"]) {
    assert.ok(entry.skipped.some((item) => item.type === type && item.reason === "default_hidden"));
  }
  assert.doesNotMatch(raw, /private user body|private reply body|private memory body|secret-thread-id/);
});

test("phase 2 preflight requires an external continuity dir and all legacy gates off", () => {
  const root = fixtureRoot();
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const configDir = path.join(root, "config");
  const continuityDir = path.join(root, "continuity");
  const promptFile = path.join(root, "prompt.md");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(configDir);
  fs.writeFileSync(promptFile, "persona", "utf8");
  const base = { stateDir, workspaceRoot, configDir, continuityDir, promptFile, channel: "weixin" };
  assert.doesNotThrow(() => validateStartupPreflight(base));
  assert.doesNotThrow(() => validateStartupPreflight({ ...base, continuityDir: path.join(workspaceRoot, "continuity") }));
  assert.throws(() => validateStartupPreflight({ ...base, continuityDir: path.join(stateDir, "continuity") }), /outside CYBERBOSS_STATE_DIR/);
  assert.throws(() => validateStartupPreflight({ ...base, legacyMemoryRetrieval: true }), /CYBERBOSS_MEMORY_RETRIEVAL must remain off/);
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  assert.doesNotThrow(() => validateStartupPreflight({ ...base, continuityDir: memoryDir, memoryDir }));
  assert.throws(
    () => validateStartupPreflight({ ...base, continuityDir: memoryDir, memoryDir, legacyMemoryBackgroundWrite: true }),
    /CYBERBOSS_MEMORY_BACKGROUND_WRITE must remain off/,
  );
  assert.throws(
    () => validateStartupPreflight({ ...base, continuityDir: path.join(memoryDir, "nested"), memoryDir }),
    /outside CYBERBOSS_MEMORY_DIR/,
  );
});

test("builder source has no default-hidden archive read path", () => {
  const sources = [
    "../src/adapters/runtime/shared-instructions.js",
    "../src/core/hard-context.js",
    "../src/core/reentry-loader.js",
  ].map((relative) => fs.readFileSync(path.resolve(__dirname, relative), "utf8")).join("\n");
  for (const forbidden of ["relationship_timeline.md", "user_portrait.md", "ai_self_notes.md", "rereadings.md"]) {
    assert.doesNotMatch(sources, new RegExp(forbidden.replace(".", "\\.")));
  }
});

test("user switch failure is explicit and never clears or recreates the requested thread", async () => {
  const sent = [];
  let cleared = 0;
  let refreshed = 0;
  const sessionStore = {
    buildBindingKey: () => "binding",
    getRuntimeParamsForWorkspace: () => ({ model: "", modelProvider: "" }),
    clearThreadIdForWorkspace: () => { cleared += 1; },
    setThreadIdForWorkspace: () => assert.fail("must not bind a failed switch"),
  };
  const app = {
    runtimeAdapter: {
      getSessionStore: () => sessionStore,
      resumeThread: async ({ resumeOrigin }) => {
        assert.equal(resumeOrigin, "user_switch");
        throw new Error("thread missing");
      },
      refreshThreadInstructions: async () => { refreshed += 1; },
    },
    resolveWorkspaceRoot: () => "workspace",
    channelAdapter: { sendText: async (payload) => sent.push(payload) },
  };
  await CyberbossApp.prototype.handleSwitchCommand.call(app, {
    workspaceId: "w", accountId: "a", senderId: "u", contextToken: "ctx",
  }, { args: "missing-thread" });
  assert.equal(cleared, 0);
  assert.equal(refreshed, 0);
  assert.match(sent[0].text, /Switch failed/);
});

test("codex opening path injects once and resume failure recreates with an explained trace reason", async () => {
  const root = fixtureRoot();
  const reentryFile = path.join(root, "continuity", "reentry.md");
  const promptFile = path.join(root, "prompt.md");
  const sessionsFile = path.join(root, "state", "sessions.json");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.dirname(reentryFile), { recursive: true });
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(reentryFile, "短交接", "utf8");
  fs.writeFileSync(promptFile, "persona", "utf8");

  const indexPath = path.resolve(__dirname, "../src/adapters/runtime/codex/index.js");
  const rpcPath = path.resolve(__dirname, "../src/adapters/runtime/codex/rpc-client.js");
  const mcpPath = path.resolve(__dirname, "../src/adapters/runtime/codex/mcp-config.js");
  const originals = new Map([[indexPath, require.cache[indexPath]], [rpcPath, require.cache[rpcPath]], [mcpPath, require.cache[mcpPath]]]);
  const calls = { sent: [], started: 0, resume: 0, failResume: false };
  class MockRpcClient {
    async connect() {}
    async initialize() {}
    isTransportReady() { return true; }
    async listModels() { return { result: { data: [] } }; }
    onMessage() { return () => {}; }
    async close() {}
    async startThread() {
      calls.started += 1;
      return { result: { thread: { id: `thread-${calls.started}` } } };
    }
    async resumeThread() {
      calls.resume += 1;
      if (calls.failResume) throw new Error("lost runtime thread");
      return { result: { thread: { id: "thread-1" } } };
    }
    async sendUserMessage(payload) {
      calls.sent.push(payload);
      return { result: { turn: { id: `turn-${calls.sent.length}` } } };
    }
  }
  delete require.cache[indexPath];
  require.cache[rpcPath] = { id: rpcPath, filename: rpcPath, loaded: true, exports: { CodexRpcClient: MockRpcClient } };
  require.cache[mcpPath] = { id: mcpPath, filename: mcpPath, loaded: true, exports: { resolveCodexProjectToolMcpServerConfig: () => null } };
  try {
    const { createCodexRuntimeAdapter } = require(indexPath);
    const adapter = createCodexRuntimeAdapter({
      sessionsFile,
      stateDir: path.dirname(sessionsFile),
      reentryFile,
      desireStateFile: path.join(root, "missing-desire.json"),
      weixinInstructionsFile: promptFile,
      channel: "telegram",
    });
    const first = await adapter.sendTurn({ bindingKey: "binding", workspaceRoot, text: "first" });
    assert.match(calls.sent[0].text, /CB_CTX:REENTRY/);
    assert.equal(first.continuity.opening, true);
    await adapter.sendTurn({ bindingKey: "binding", workspaceRoot, text: "second" });
    assert.doesNotMatch(calls.sent[1].text, /CB_CTX:REENTRY/);

    calls.failResume = true;
    const recreated = await adapter.sendTurn({ bindingKey: "binding", workspaceRoot, text: "after loss" });
    assert.equal(recreated.threadId, "thread-2");
    assert.match(calls.sent[2].text, /CB_CTX:REENTRY/);
    assert.equal(recreated.continuity.blocks.find((item) => item.type === "reentry").reason, "thread_recreated");
  } finally {
    delete require.cache[indexPath];
    for (const [key, value] of originals.entries()) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  }
});

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase2-"));
}
