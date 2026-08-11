"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveTranscriptPath,
  readLastSessionUsage,
  readSessionContextUsage,
} = require("../src/adapters/runtime/claudecode/session-transcript");
const { CyberbossApp } = require("../src/core/app");

function tempConfigRoot(projectDirs = ["proj-a"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-transcript-"));
  for (const dir of projectDirs) {
    fs.mkdirSync(path.join(root, "projects", dir), { recursive: true });
  }
  return root;
}

function writeTranscript(root, projectDir, sessionId, entries) {
  const file = path.join(root, "projects", projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

function assistantEntry(tokens, timestamp) {
  return {
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      usage: {
        input_tokens: tokens.input || 0,
        cache_creation_input_tokens: tokens.cacheCreation || 0,
        cache_read_input_tokens: tokens.cacheRead || 0,
        output_tokens: tokens.output || 0,
      },
    },
  };
}

test("resolveTranscriptPath finds the session file by id, whichever project dir holds it", () => {
  const root = tempConfigRoot(["proj-a", "proj-b"]);
  const expected = writeTranscript(root, "proj-b", "sess-1", [assistantEntry({ input: 5 }, "2026-08-07T00:00:00.000Z")]);

  assert.equal(resolveTranscriptPath({ configRoot: root, sessionId: "sess-1" }), expected);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveTranscriptPath fails open on a missing root, missing session, or blank input", () => {
  const root = tempConfigRoot();
  assert.equal(resolveTranscriptPath({ configRoot: path.join(root, "nope"), sessionId: "sess-1" }), "");
  assert.equal(resolveTranscriptPath({ configRoot: root, sessionId: "absent" }), "");
  assert.equal(resolveTranscriptPath({ configRoot: "", sessionId: "sess-1" }), "");
  assert.equal(resolveTranscriptPath({ configRoot: root, sessionId: "" }), "");
  assert.equal(resolveTranscriptPath({}), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("readLastSessionUsage returns the newest usage, summed the same way the event stream sums it", () => {
  const root = tempConfigRoot();
  const file = writeTranscript(root, "proj-a", "sess-1", [
    assistantEntry({ input: 1, cacheRead: 100 }, "2026-08-07T00:00:00.000Z"),
    { type: "user", message: { role: "user", content: "hi" } },
    assistantEntry({ input: 3, cacheCreation: 121, cacheRead: 80502, output: 13 }, "2026-08-07T00:19:09.345Z"),
  ]);

  const usage = readLastSessionUsage(file);

  assert.equal(usage.currentTokens, 3 + 121 + 80502 + 13);
  assert.equal(usage.at, Date.parse("2026-08-07T00:19:09.345Z"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("readLastSessionUsage skips entries that carry no usage rather than reporting zero", () => {
  const root = tempConfigRoot();
  const file = writeTranscript(root, "proj-a", "sess-1", [
    assistantEntry({ input: 7, cacheRead: 200 }, "2026-08-07T00:00:00.000Z"),
    { type: "queue-operation", op: "enqueue" },
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { role: "assistant" } },
  ]);

  assert.equal(readLastSessionUsage(file).currentTokens, 207);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readLastSessionUsage fails open on a missing file, an empty file, and unparseable lines", () => {
  const root = tempConfigRoot();
  assert.equal(readLastSessionUsage(path.join(root, "projects", "proj-a", "absent.jsonl")), null);
  assert.equal(readLastSessionUsage(""), null);

  const empty = path.join(root, "projects", "proj-a", "empty.jsonl");
  fs.writeFileSync(empty, "", "utf8");
  assert.equal(readLastSessionUsage(empty), null);

  const torn = path.join(root, "projects", "proj-a", "torn.jsonl");
  fs.writeFileSync(torn, "{not json\n{\"type\":\"assistant\"\n", "utf8");
  assert.equal(readLastSessionUsage(torn), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readLastSessionUsage discards the half-line a tail read slices open", () => {
  const root = tempConfigRoot();
  // Only the tail is read. The first line inside that window is very likely cut in
  // half, and parsing a fragment would be worse than losing one entry — so the
  // reader must drop it and still find the older intact entry behind it.
  const file = writeTranscript(root, "proj-a", "sess-1", [
    assistantEntry({ input: 11, cacheRead: 500 }, "2026-08-07T00:00:00.000Z"),
    assistantEntry({ input: 22, cacheRead: 900 }, "2026-08-07T00:01:00.000Z"),
  ]);
  const size = fs.statSync(file).size;
  const lastLineLength = JSON.stringify(assistantEntry({ input: 22, cacheRead: 900 }, "2026-08-07T00:01:00.000Z")).length;

  // A window that starts partway through the final line.
  const usage = readLastSessionUsage(file, { tailBytes: lastLineLength - 10 });
  assert.equal(usage, null, "a sliced final line must not be parsed into a number");

  // A window wide enough to reach the intact final line.
  assert.equal(readLastSessionUsage(file, { tailBytes: size }).currentTokens, 922);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readSessionContextUsage resolves the path and reads it in one call", () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 4, cacheRead: 60 }, "2026-08-07T00:00:00.000Z")]);

  assert.equal(readSessionContextUsage({ configRoot: root, sessionId: "sess-1" }).currentTokens, 64);
  assert.equal(readSessionContextUsage({ configRoot: root, sessionId: "absent" }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /status integration.
//
// Owner 2026-08-06: the context figure "只有发完一条消息才正确". Root cause was that
// /status read a volatile in-memory map fed only by assistant messages: empty
// after a bot restart (08-06 alone had 7 code deploys + 1 config restart), and
// pre-relaunch after an escalation. The transcript survives both.
// ---------------------------------------------------------------------------

function statusApp({ sent, configRoot, threadId, memoryContext }) {
  return Object.setPrototypeOf({
    config: { claudeContextWindow: 200000, claudeMaxOutputTokens: 0 },
    resolveWorkspaceRoot: () => "/workspace",
    resolveLaunchProfileForLane: () => ({ profileId: "fable-chat", configRoot }),
    runtimeAdapter: {
      describe: () => ({ id: "claudecode", model: "claude-fable-5" }),
      getWindowOverride: () => ({ enabled: false }),
      getSessionStore: () => ({
        buildBindingKey: () => "binding-1",
        getThreadIdForWorkspace: () => threadId,
        getRuntimeParamsForWorkspace: () => ({ model: "", effort: "" }),
      }),
    },
    threadStateStore: {
      getThreadState: () => (memoryContext ? { status: "idle", context: memoryContext } : null),
      getLatestContext: () => memoryContext || null,
    },
    channelAdapter: { sendText: async (payload) => { sent.push(payload.text); } },
  }, CyberbossApp.prototype);
}

const STATUS_MESSAGE = { workspaceId: "default", accountId: "a", senderId: "u", contextToken: "c" };

test("/status reports context after a restart wiped the in-memory reading", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 3, cacheRead: 80502 }, new Date().toISOString())]);
  const sent = [];

  // memoryContext null == the state right after the bot restarts. This used to
  // print "📦 context: unavailable".
  await CyberbossApp.prototype.handleStatusCommand.call(
    statusApp({ sent, configRoot: root, threadId: "sess-1", memoryContext: null }),
    STATUS_MESSAGE,
  );

  assert.match(sent[0], /📦 context: approx 80\.5k\/200k/);
  assert.doesNotMatch(sent[0], /context: unavailable/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/status prefers the transcript over a stale in-memory reading", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 90000 }, new Date().toISOString())]);
  const sent = [];

  await CyberbossApp.prototype.handleStatusCommand.call(
    statusApp({
      sent,
      configRoot: root,
      threadId: "sess-1",
      // What the pre-relaunch child last reported — the number Owner kept seeing.
      memoryContext: { runtimeId: "claudecode", currentTokens: 61400 },
    }),
    STATUS_MESSAGE,
  );

  assert.match(sent[0], /📦 context: approx 90k\/200k/);
  assert.doesNotMatch(sent[0], /61\.4k/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/status falls back to the in-memory reading when the transcript cannot be read", async () => {
  const root = tempConfigRoot();
  const sent = [];

  await CyberbossApp.prototype.handleStatusCommand.call(
    statusApp({
      sent,
      configRoot: root,
      threadId: "no-such-session",
      memoryContext: { runtimeId: "claudecode", currentTokens: 61400 },
    }),
    STATUS_MESSAGE,
  );

  assert.match(sent[0], /📦 context: approx 61\.4k\/200k/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/status keeps the context line to the figure itself, with no age stamp", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [
    assistantEntry({ input: 1000 }, new Date(Date.now() - 5 * 60 * 1000).toISOString()),
  ]);
  const sent = [];

  await CyberbossApp.prototype.handleStatusCommand.call(
    statusApp({ sent, configRoot: root, threadId: "sess-1", memoryContext: null }),
    STATUS_MESSAGE,
  );

  // Owner 2026-08-07: the stamp was clutter once the figure itself became right.
  assert.match(sent[0], /📦 context: approx 1k\/200k \| 100% left$/m);
  assert.doesNotMatch(sent[0], /ago/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /status must report the running child, not the stored intent.
//
// Owner 2026-08-11: /status 与 /model 报 claude-fable-5 整整五天，而子进程实际
// 一直跑 claude-opus-4-6。两条命令都走 windowOverride → configuredModel 这条梯子，
// 读的全是配置意图；覆盖被清掉而进程还活着时，显示就永久性地说假话。
// 唯一说真话的是重启通知 —— 因为它报的是启动 argv。
// ---------------------------------------------------------------------------

test("/status prefers the model the child actually launched with, and names the drift", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 1, cacheRead: 10 }, new Date().toISOString())]);
  const sent = [];
  const app = statusApp({ sent, configRoot: root, threadId: "sess-1", memoryContext: null });
  // 配置说 fable-5（见 statusApp 的 describe），进程实际是 opus-4-6。
  app.liveLaunchByLane = { get: () => ({ model: "claude-opus-4-6", effort: "high" }) };

  await CyberbossApp.prototype.handleStatusCommand.call(app, STATUS_MESSAGE);

  const text = sent.join("\n");
  assert.match(text, /🤖 model: claude-opus-4-6/u, "报的必须是进程实际在跑的");
  assert.doesNotMatch(text, /🤖 model: claude-fable-5/u, "配置值不能冒充实际值");
  assert.match(text, /⚠️[^\n]*claude-fable-5/u, "分叉必须显式说出来，不能沉默");
  assert.match(text, /下次重启按配置走/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/status stays quiet when the child matches the configuration", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 1, cacheRead: 10 }, new Date().toISOString())]);
  const sent = [];
  const app = statusApp({ sent, configRoot: root, threadId: "sess-1", memoryContext: null });
  app.liveLaunchByLane = { get: () => ({ model: "claude-fable-5", effort: "medium" }) };

  await CyberbossApp.prototype.handleStatusCommand.call(app, STATUS_MESSAGE);

  const text = sent.join("\n");
  assert.match(text, /🤖 model: claude-fable-5/u);
  assert.doesNotMatch(text, /⚠️/u, "没分叉就不该有告警，否则告警会被当噪音");
  fs.rmSync(root, { recursive: true, force: true });
});

test("/status falls back to the configured value when no launch has been recorded", async () => {
  const root = tempConfigRoot();
  writeTranscript(root, "proj-a", "sess-1", [assistantEntry({ input: 1, cacheRead: 10 }, new Date().toISOString())]);
  const sent = [];
  const app = statusApp({ sent, configRoot: root, threadId: "sess-1", memoryContext: null });
  // bridge 刚起、还没有子进程启动过：退回旧行为，不能因此炸掉 /status。
  app.liveLaunchByLane = new Map();

  await CyberbossApp.prototype.handleStatusCommand.call(app, STATUS_MESSAGE);

  const text = sent.join("\n");
  assert.match(text, /🤖 model: claude-fable-5/u);
  assert.doesNotMatch(text, /⚠️/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("announceProcessLaunch records the launch argv even for a lane it will not announce", async () => {
  const recorded = new Map();
  const app = Object.setPrototypeOf({
    liveLaunchByLane: recorded,
    runtimeAdapter: { getSessionStore: () => ({ buildBindingKey: () => "b" }) },
    // 没有 telegramProfileRouter：走到"不是她的窗口"那条早退分支。
    telegramProfileRouter: null,
    config: {},
    activeAccountId: "telegram",
  }, CyberbossApp.prototype);

  await CyberbossApp.prototype.announceProcessLaunch.call(app, {
    laneKey: "v2|sys|system-message",
    threadId: "t-1",
    model: "claude-fable-5",
    effort: "medium",
  });

  assert.equal(recorded.get("v2|sys|system-message")?.model, "claude-fable-5",
    "记账必须发生在'要不要通知'的判断之前");
});
