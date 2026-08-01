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
const { countNonWhitespace, loadReentry, reentrySnapshotFileFor } = require("../src/core/reentry-loader");
const { validateStartupPreflight } = require("../src/core/startup-preflight");
const { CyberbossApp } = require("../src/core/app");
const { Route2GateState } = require("../src/adapters/runtime/claudecode/route2-gate");
const { SessionSlotStore } = require("../src/adapters/runtime/claudecode/session-slot");

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
    configured: "on",
    effective: "none",
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

// issue #76 目标 2 的验收：超预算不再等于开场交接为零。
// 生产事实（2026-07-30）：memory/reentry.md 954 非空白字 / 预算 300，
// err.log 连续记 `reentry skipped reason=over_budget`，开场人格交接信实际是空的。
test("over-budget reentry degrades to the last known good copy and never rewrites canon", () => {
  const root = fixtureRoot();
  const continuityDir = path.join(root, "continuity");
  const filePath = path.join(continuityDir, "reentry.md");
  const snapshotFile = reentrySnapshotFileFor(continuityDir);
  fs.mkdirSync(continuityDir, { recursive: true });

  const good = "我昨晚停在她那句「先不管了」上。";
  fs.writeFileSync(filePath, good, "utf8");
  const current = loadReentry({ filePath, snapshotFile });
  assert.equal(current.text, good);
  assert.equal(current.effective, "current");
  assert.equal(current.degraded_reason, undefined);
  assert.equal(fs.existsSync(snapshotFile), true);

  // 超预算：换用上一份预算内正文，当前文件一个字节都不许被动。
  const overBudget = "她".repeat(954);
  fs.writeFileSync(filePath, overBudget, "utf8");
  const degraded = loadReentry({ filePath, snapshotFile });
  assert.equal(degraded.text, good);
  assert.equal(degraded.effective, "fallback");
  assert.equal(degraded.degraded_reason, "over_budget");
  assert.equal(degraded.current_chars, 954);
  assert.equal(degraded.chars, countNonWhitespace(good));
  assert.equal(fs.readFileSync(filePath, "utf8"), overBudget);
  // 降级不得把副本更新成超预算正文，否则下一轮就没有可用副本了。
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).body, good);

  // 完全没有可用正文时仍 fail-open 返回空（不变量 5），而不是抛错或截断。
  fs.rmSync(snapshotFile);
  const none = loadReentry({ filePath, snapshotFile });
  assert.equal(none.text, undefined);
  assert.equal(none.skipped, "over_budget");
  assert.equal(none.effective, "none");
  assert.equal(none.chars, 954);
  assert.equal(fs.readFileSync(filePath, "utf8"), overBudget);
});

test("last known good copy is re-validated and never resurrects a deliberate reset", () => {
  const root = fixtureRoot();
  const continuityDir = path.join(root, "continuity");
  const filePath = path.join(continuityDir, "reentry.md");
  const snapshotFile = reentrySnapshotFileFor(continuityDir);
  fs.mkdirSync(continuityDir, { recursive: true });
  fs.writeFileSync(filePath, "还在预算内的一句。", "utf8");
  loadReentry({ filePath, snapshotFile });
  assert.equal(fs.existsSync(snapshotFile), true);

  // 主体 AI 清空 reentry.md 是一个有权限的决定：missing / expired 不许用副本盖回去。
  fs.writeFileSync(filePath, "   \n", "utf8");
  assert.equal(loadReentry({ filePath, snapshotFile }).skipped, "missing");
  assert.equal(loadReentry({ filePath, snapshotFile }).text, undefined);

  // 副本自己也要过预算与期限钩子：落盘值不被当成可信输入。
  fs.writeFileSync(filePath, "她".repeat(400), "utf8");
  fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, hash: "x", body: "她".repeat(400) }), "utf8");
  assert.equal(loadReentry({ filePath, snapshotFile }).skipped, "over_budget");
  fs.writeFileSync(snapshotFile, JSON.stringify({
    version: 1, hash: "x", body: "只剩过期钩子 <!-- until: 2026-07-19 -->",
  }), "utf8");
  assert.equal(
    loadReentry({ filePath, snapshotFile, now: new Date("2026-07-30T10:00:00+08:00") }).skipped,
    "over_budget",
  );
  fs.writeFileSync(snapshotFile, "{ not json", "utf8");
  assert.equal(loadReentry({ filePath, snapshotFile }).skipped, "over_budget");
});

// issue #76 目标 4：门开着但内容进不去，trace 不得再显示成正常 loaded。
test("context trace separates the reentry gate from what actually got injected", async () => {
  const root = fixtureRoot();
  const continuityDir = path.join(root, "continuity");
  const filePath = path.join(continuityDir, "reentry.md");
  const snapshotFile = reentrySnapshotFileFor(continuityDir);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(continuityDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const config = {
    reentryFile: filePath,
    continuityDir,
    stateDir,
    desireStateFile: path.join(root, "missing-desire.json"),
  };
  const sessionStore = { getReentryInjection: () => null };

  fs.writeFileSync(filePath, "预算内的交接。", "utf8");
  const healthy = prepareOpeningContext({ config, sessionStore, threadId: "t1" });
  const healthyBlock = healthy.blocks.find((item) => item.type === "reentry");
  assert.equal(healthyBlock.configured, "on");
  assert.equal(healthyBlock.effective, "current");
  assert.equal(Object.prototype.hasOwnProperty.call(healthyBlock, "degraded_reason"), false);

  fs.writeFileSync(filePath, "她".repeat(954), "utf8");
  const degraded = prepareOpeningContext({ config, sessionStore, threadId: "t2" });
  const degradedBlock = degraded.blocks.find((item) => item.type === "reentry");
  assert.equal(degradedBlock.loaded, true);
  assert.equal(degradedBlock.configured, "on");
  assert.equal(degradedBlock.effective, "fallback");
  assert.equal(degradedBlock.degraded_reason, "over_budget");

  fs.rmSync(snapshotFile);
  const empty = prepareOpeningContext({ config, sessionStore, threadId: "t3" });
  assert.equal(empty.blocks.some((item) => item.type === "reentry"), false);
  assert.deepEqual(empty.skipped.find((item) => item.type === "reentry"), {
    type: "reentry",
    reason: "over_budget",
    configured: "on",
    effective: "none",
  });

  // 落盘的 trace 行必须保留这三个字段，否则可见性只存在于内存里。
  const tracePath = path.join(root, "trace", "context_trace.jsonl");
  const recorder = new ContextTraceRecorder({ filePath: tracePath });
  await recorder.record({ threadId: "t2", turnId: "turn-1", opening: true, ...degraded, total_chars: 20 });
  await recorder.record({ threadId: "t3", turnId: "turn-2", opening: true, ...empty, total_chars: 0 });
  await recorder.flush();
  const rows = fs.readFileSync(tracePath, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    rows[0].blocks.find((item) => item.type === "reentry").effective,
    "fallback",
  );
  assert.equal(rows[0].blocks.find((item) => item.type === "reentry").degraded_reason, "over_budget");
  assert.equal(rows[1].skipped.find((item) => item.type === "reentry").effective, "none");
  assert.equal(rows[1].skipped.find((item) => item.type === "reentry").configured, "on");
  // 其他块的行形状不变：新字段只出现在写入方明确给出的地方。
  assert.deepEqual(
    rows[0].skipped.find((item) => item.type === "episodes"),
    { type: "episodes", reason: "default_hidden" },
  );
});

// issue #76 目标 1 的边界：账本是第三档抽屉，永远不许穿在身上。
test("the details ledger is never read by any injected hard-context builder", () => {
  const root = fixtureRoot();
  const continuityDir = path.join(root, "continuity");
  const filePath = path.join(continuityDir, "reentry.md");
  fs.mkdirSync(continuityDir, { recursive: true });
  fs.writeFileSync(filePath, "只有交接进上下文。", "utf8");
  fs.writeFileSync(path.join(continuityDir, "details.jsonl"), `${JSON.stringify({
    detail_id: "detail-abc", ts: "2026-07-30T00:00:00.000Z", type: "details",
    body: "下周一体检要空腹", candidate_id: "cand-x", decision_id: "decision-x",
  })}\n`, "utf8");

  const context = prepareOpeningContext({
    config: {
      reentryFile: filePath,
      continuityDir,
      desireStateFile: path.join(root, "missing-desire.json"),
    },
    sessionStore: { getReentryInjection: () => null },
    threadId: "thread-details",
  });
  const rendered = buildOpeningTurnText({ channel: "telegram" }, "现在说什么？", context);
  assert.doesNotMatch(rendered, /下周一体检要空腹/u);
  assert.equal(context.blocks.some((item) => item.type === "details"), false);

  const sources = [
    "../src/adapters/runtime/shared-instructions.js",
    "../src/core/hard-context.js",
    "../src/core/reentry-loader.js",
  ].map((relative) => fs.readFileSync(path.resolve(__dirname, relative), "utf8")).join("\n");
  assert.doesNotMatch(sources, /details\.jsonl/u);
  assert.doesNotMatch(sources, /detail-ledger/u);
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
  assert.deepEqual(off.skipped.find((item) => item.type === "reentry"), {
    type: "reentry",
    reason: "gated_off",
    configured: "off",
    effective: "none",
  });
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

// G1 acceptance prerequisite: the per-turn trace row explains memory_context
// the same way it explains reentry and current_state -- loaded with evidence,
// or skipped with a reason. Without this the trace structurally cannot attest
// that memory context ran on a Telegram turn.
test("context trace explains memory_context as a loaded block or a reasoned skip", async () => {
  const rows = [];
  const appLike = {
    contextTraceRunState: new Map(),
    contextTraceRecorder: { record: (entry) => { rows.push(entry); return Promise.resolve(true); } },
  };
  const continuity = {
    opening: false,
    blocks: [],
    skipped: [{ type: "reentry", reason: "existing_thread" }],
    total_chars: 12,
  };

  CyberbossApp.prototype.recordContextTrace.call(
    appLike, "thread-1", "turn-1", continuity,
    { lines: ["她昨晚说今天要早起"], slots: [], mode: "targeted" },
  );
  const loadedBlock = rows[0].blocks.find((item) => item.type === "memory_context");
  assert.equal(loadedBlock.loaded, true);
  assert.equal(loadedBlock.reason, "targeted");
  assert.ok(loadedBlock.chars > 0);

  CyberbossApp.prototype.recordContextTrace.call(
    appLike, "thread-1", "turn-2", continuity,
    { lines: [], slots: [], mode: "gated_off" },
  );
  assert.ok(!rows[1].blocks.some((item) => item.type === "memory_context"));
  assert.deepEqual(
    rows[1].skipped.find((item) => item.type === "memory_context"),
    { type: "memory_context", reason: "gated_off" },
  );

  // A caller with no turn outcome (opening refresh) leaves the row shape alone.
  CyberbossApp.prototype.recordContextTrace.call(appLike, "thread-1", "turn-3", continuity);
  assert.ok(!rows[2].blocks.some((item) => item.type === "memory_context"));
  assert.ok(!rows[2].skipped.some((item) => item.type === "memory_context"));
  // The shared continuity object was never mutated across the three calls.
  assert.deepEqual(continuity.skipped, [{ type: "reentry", reason: "existing_thread" }]);
  assert.deepEqual(continuity.blocks, []);
});

test("T07 A7/A12 cost trace records bounded metrics and correlations without user or tool-result text", async () => {
  const root = fixtureRoot();
  const tracePath = path.join(root, "context_trace.jsonl");
  const recorder = new ContextTraceRecorder({ filePath: tracePath });
  const tracker = new Route2GateState({
    sessionSlotStore: new SessionSlotStore(),
    env: { CYBERBOSS_ROUTE2_GATE_ENABLED: "true" },
  });
  tracker.begin({
    sessionSlotKey: "slot-cost-fake",
    windowId: "window-cost-fake",
    overrideFingerprint: "override-cost-fake",
    taskId: "task-cost-fake",
    plan: {
      catalog: [{ id: "fake_read", estimated_schema_chars: 321, max_result_bytes: 1024, authorized: true }],
      toolNames: ["fake_read"],
      expectedContextTokens: 456,
    },
  });
  const base = { threadId: "window-cost-fake", turnId: "turn-cost-fake", sessionSlotKey: "slot-cost-fake" };
  tracker.observe({ type: "runtime.tool.use", payload: { ...base, toolName: "fake_read" } });
  tracker.observe({ type: "runtime.tool.result", payload: { ...base, returnBytes: 789, isError: false } });
  tracker.observe({ type: "runtime.context.updated", payload: { ...base, inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40 } });
  const costEvent = tracker.observe({ type: "runtime.turn.completed", payload: base });
  assert.equal(Object.hasOwn(costEvent.payload, "userText"), false);
  assert.equal(Object.hasOwn(costEvent.payload, "toolResult"), false);
  await CyberbossApp.prototype.handleRuntimeEvent.call({ contextTraceRecorder: recorder }, costEvent);
  await recorder.flush();

  const raw = fs.readFileSync(tracePath, "utf8");
  const row = JSON.parse(raw.trim());
  assert.equal(row.route2_cost.schema_chars, 321);
  assert.equal(row.route2_cost.expected_context_tokens, 456);
  assert.equal(row.route2_cost.actual_tool_uses, 1);
  assert.equal(row.route2_cost.return_bytes, 789);
  assert.deepEqual(row.route2_cost.usage, { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 });
  assert.equal(row.route2_cost.session_slot, "slot-cost-fake");
  assert.equal(row.route2_cost.task, "task-cost-fake");
  assert.equal(raw.includes("user fixture body"), false);
  assert.equal(raw.includes("tool result fixture body"), false);
  assert.equal(raw.includes("episodes.jsonl"), false);
  assert.equal(raw.includes("candidate"), false);
});

test("T08 A4/A12 an expired capability lease is a Route 1 routing decision with chat capability unchanged", () => {
  const decision = require("../src/adapters/runtime/claudecode/route2-gate").decideRoute2Gate({
    catalog: [{ id: "fake_read", estimated_schema_chars: 10, max_result_bytes: 64, authorized: true }],
    toolNames: ["fake_read"],
    leaseValid: false,
  }, { env: { CYBERBOSS_ROUTE2_GATE_ENABLED: "true" } });
  assert.equal(decision.route, "route1");
  assert.equal(decision.chat_capability, "unchanged");
  assert.deepEqual(decision.reasons, ["capability_lease_expired"]);
});
