"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { buildTelegramRouteLane, buildSystemRouteLane } = require("../src/core/route-lane");

function telegramMessage({ chatId = "500", messageThreadId = null, text = "hi", messageId = "1" } = {}) {
  return {
    provider: "telegram",
    workspaceId: "default",
    accountId: "telegram",
    senderId: "500",
    chatId,
    messageThreadId,
    messageId,
    contextToken: `telegram:${chatId}`,
    originalText: text,
    text,
    attachments: [],
    attachmentFailures: [],
    receivedAt: "2026-07-25T00:00:00.000Z",
    telegram: { chatId, messageThreadId, messageId },
  };
}

function makeAppLike({ blocked = false } = {}) {
  const typing = [];
  const sent = [];
  const dispatched = [];
  const turnGateStore = new TurnGateStore();

  const appLike = {
    config: {},
    turnGateStore,
    turnBoundaryScopeKeys: new Set(),
    pendingInboundByScope: new Map(),
    pendingImageInboundByScope: new Map(),
    channelAdapter: {
      async sendTyping(payload) { typing.push(payload); },
      async sendText(payload) { sent.push(payload); },
    },
    streamDelivery: {
      setReplyTarget() {},
      setReplyTargetForThread() {},
      bindReplyTargetForTurn() {},
      queueReplyTargetForThread() {},
    },
    threadStateStore: {
      getThreadState() {
        return blocked ? { status: "running", pendingApproval: null } : null;
      },
    },
    runtimeAdapter: {
      describe() { return { id: "claudecode" }; },
      getSessionStore() {
        return {
          buildBindingKey: () => "default:telegram:500",
          getThreadIdForWorkspace: () => (blocked ? "thread-busy" : ""),
          getRuntimeParamsForWorkspace: () => ({ model: "" }),
        };
      },
      async sendTurn(args) {
        dispatched.push(args);
        return { threadId: `thread-${dispatched.length}`, turnId: `turn-${dispatched.length}` };
      },
    },
    async buildRuntimeTurn({ prepared }) {
      return { text: prepared.text, attachments: [] };
    },
    resolveWorkspaceRoot: () => "/workspace",
    async prepareIncomingMessageForRuntime(normalized) { return { ...normalized }; },
    maybeRunLegacyMemoryBackgroundPipeline() {},
    logTelegramDebug() {},
    recordInboundMessage() {},
    // Borrowed prototype methods under test.
    resolveRouteLane: CyberbossApp.prototype.resolveRouteLane,
    buildRouteScopeKey: CyberbossApp.prototype.buildRouteScopeKey,
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
    dispatchTelegramPreparedInbound: CyberbossApp.prototype.dispatchTelegramPreparedInbound,
    dispatchPreparedTurn: CyberbossApp.prototype.dispatchPreparedTurn,
    bufferPendingInboundMessage: CyberbossApp.prototype.bufferPendingInboundMessage,
    hasPendingInboundMessage: CyberbossApp.prototype.hasPendingInboundMessage,
    flushPendingInboundMessages: CyberbossApp.prototype.flushPendingInboundMessages,
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
    enqueuePendingImageInbound: CyberbossApp.prototype.enqueuePendingImageInbound,
    hasPendingImageInbound: CyberbossApp.prototype.hasPendingImageInbound,
    schedulePendingImageInboundFlush: CyberbossApp.prototype.schedulePendingImageInboundFlush,
    clearPendingImageInboundTimer: CyberbossApp.prototype.clearPendingImageInboundTimer,
  };
  return { appLike, typing, sent, dispatched, turnGateStore };
}

test("two topics in one chat occupy different turn-gate scopes", () => {
  const { appLike } = makeAppLike();
  const laneDefault = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: null });
  const laneTopic = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: 9 });

  const scopeDefault = appLike.buildRouteScopeKey(laneDefault, "b", "/workspace");
  const scopeTopic = appLike.buildRouteScopeKey(laneTopic, "b", "/workspace");
  assert.notEqual(scopeDefault, scopeTopic);

  appLike.turnGateStore.beginScope(scopeDefault);
  assert.equal(
    appLike.isTurnDispatchBlocked("b", "/workspace", { lane: laneDefault }),
    true,
    "the busy lane is blocked",
  );
  assert.equal(
    appLike.isTurnDispatchBlocked("b", "/workspace", { lane: laneTopic }),
    false,
    "the other topic is free to run",
  );
});

test("a workspace-wide job yields while any lane is running", () => {
  const { appLike } = makeAppLike();
  const laneTopic = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: 9 });
  appLike.turnGateStore.beginScope(appLike.buildRouteScopeKey(laneTopic, "b", "/workspace"));

  const systemLane = buildSystemRouteLane("system-message");
  assert.equal(appLike.isTurnDispatchBlocked("b", "/workspace", { lane: systemLane }), false);
  assert.equal(appLike.isTurnDispatchBlocked("b", "/workspace", { lane: systemLane, anyLane: true }), true);
  assert.equal(appLike.isTurnDispatchBlocked("b", "/other", { lane: systemLane, anyLane: true }), false);
});

test("buffered messages from different topics never merge into one turn", async () => {
  const { appLike, dispatched } = makeAppLike({ blocked: true });

  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: null, text: "default lane 1", messageId: "1" }),
  });
  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: "9", text: "topic 9 message", messageId: "2" }),
  });
  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: null, text: "default lane 2", messageId: "3" }),
  });

  assert.equal(dispatched.length, 0, "everything was buffered while the runtime was busy");
  assert.equal(appLike.pendingInboundByScope.size, 2, "one buffer per lane");

  const buffers = [...appLike.pendingInboundByScope.values()];
  const defaultBuffer = buffers.find((entry) => entry.lane.messageThreadId === null);
  const topicBuffer = buffers.find((entry) => entry.lane.messageThreadId === "9");

  assert.deepEqual(
    defaultBuffer.messages.map((message) => message.text),
    ["default lane 1", "default lane 2"],
  );
  assert.deepEqual(topicBuffer.messages.map((message) => message.text), ["topic 9 message"]);
  // The topic buffer never saw the default lane's text.
  assert.equal(
    JSON.stringify(topicBuffer.messages).includes("default lane"),
    false,
  );
});

test("buffered messages keep their topic so the reply returns to it", async () => {
  const { appLike } = makeAppLike({ blocked: true });
  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: "9", text: "hi", messageId: "1" }),
  });
  const [buffer] = [...appLike.pendingInboundByScope.values()];
  assert.equal(buffer.messages[0].messageThreadId, "9");
  assert.equal(buffer.messages[0].chatId, "500");
});

test("flushing one lane leaves the other lane's buffer untouched", async () => {
  const { appLike, dispatched } = makeAppLike({ blocked: true });
  const laneDefault = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: null });

  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: null, text: "default", messageId: "1" }),
  });
  await appLike.dispatchTelegramPreparedInbound({
    bindingKey: "b", workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: "9", text: "topic", messageId: "2" }),
  });
  assert.equal(appLike.pendingInboundByScope.size, 2);

  // Unblock and flush only the default lane.
  appLike.threadStateStore.getThreadState = () => null;
  appLike.runtimeAdapter.getSessionStore = () => ({
    buildBindingKey: () => "default:telegram:500",
    getThreadIdForWorkspace: () => "",
    getRuntimeParamsForWorkspace: () => ({ model: "" }),
  });

  await appLike.flushPendingInboundMessages({
    bindingKey: "b", workspaceRoot: "/workspace", lane: laneDefault, ignoreBoundary: true,
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].lane.messageThreadId, null);
  assert.equal(appLike.pendingInboundByScope.size, 1, "the other topic is still queued");
  assert.equal([...appLike.pendingInboundByScope.values()][0].lane.messageThreadId, "9");
});

test("image debounce drafts are per lane, so bursts in two topics stay separate", () => {
  const { appLike } = makeAppLike();
  const image = (messageThreadId, messageId) => ({
    ...telegramMessage({ messageThreadId, text: "", messageId }),
    attachments: [{ kind: "image", absolutePath: `/tmp/${messageId}.png`, isImage: true }],
  });

  appLike.enqueuePendingImageInbound({
    bindingKey: "b", workspaceRoot: "/workspace", prepared: image(null, "1"),
  });
  appLike.enqueuePendingImageInbound({
    bindingKey: "b", workspaceRoot: "/workspace", prepared: image("9", "2"),
  });
  appLike.enqueuePendingImageInbound({
    bindingKey: "b", workspaceRoot: "/workspace", prepared: image(null, "3"),
  });

  assert.equal(appLike.pendingImageInboundByScope.size, 2);
  const drafts = [...appLike.pendingImageInboundByScope.values()];
  assert.deepEqual(drafts.map((draft) => draft.messages.length).sort(), [1, 2]);

  const laneDefault = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: null });
  const laneTopic = buildTelegramRouteLane({ accountId: "telegram", chatId: "500", messageThreadId: 9 });
  assert.equal(appLike.hasPendingImageInbound("b", "/workspace", laneDefault), true);
  assert.equal(appLike.hasPendingImageInbound("b", "/workspace", laneTopic), true);
  assert.equal(appLike.hasPendingImageInbound("b", "/other", laneTopic), false);

  for (const [scopeKey] of appLike.pendingImageInboundByScope) {
    appLike.clearPendingImageInboundTimer(scopeKey);
  }
});

test("dispatch sends typing and the runtime turn on the originating topic", async () => {
  const { appLike, typing, dispatched } = makeAppLike();

  await appLike.dispatchPreparedTurn({
    bindingKey: "b",
    workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: "9" }),
  });

  assert.equal(typing[0].messageThreadId, "9");
  assert.equal(dispatched[0].lane.messageThreadId, "9");
  assert.equal(dispatched[0].lane.chatId, "500");
});

test("dispatch failure reports the error back into the originating topic", async () => {
  const { appLike, sent } = makeAppLike();
  appLike.runtimeAdapter.sendTurn = async () => {
    throw new Error("boom");
  };

  const ok = await appLike.dispatchPreparedTurn({
    bindingKey: "b",
    workspaceRoot: "/workspace",
    prepared: telegramMessage({ messageThreadId: "9" }),
  });

  assert.equal(ok, false);
  assert.equal(sent[0].messageThreadId, "9");
  assert.match(sent[0].text, /Request failed/);
});

test("a non-Telegram turn keeps the pre-v2 payload shape exactly", async () => {
  const { appLike, typing, sent } = makeAppLike();
  appLike.runtimeAdapter.sendTurn = async () => {
    throw new Error("boom");
  };

  await appLike.dispatchPreparedTurn({
    bindingKey: "b",
    workspaceRoot: "/workspace",
    prepared: {
      provider: "weixin",
      workspaceId: "default",
      accountId: "wx",
      senderId: "user-1",
      contextToken: "ctx-1",
      text: "hi",
      originalText: "hi",
    },
  });

  assert.equal(Object.hasOwn(typing[0], "messageThreadId"), false);
  assert.equal(Object.hasOwn(sent[0], "messageThreadId"), false);
});

test("reply targets resolve per session id, so one topic cannot answer into another", () => {
  const delivery = new StreamDelivery({
    channelAdapter: { async sendText() {} },
    sessionStore: {
      // Deliberately hostile: the binding-level lookup points every session at
      // the same binding, which is exactly the pre-v2 leak. The session-scoped
      // map must win.
      findBindingForThreadId: () => ({ bindingKey: "shared-binding", workspaceRoot: "/workspace" }),
    },
  });

  delivery.setReplyTarget("shared-binding", {
    userId: "500", contextToken: "telegram:500", provider: "telegram", messageThreadId: null,
  });
  delivery.setReplyTargetForThread("thread-default", {
    userId: "500", contextToken: "telegram:500", provider: "telegram", messageThreadId: null,
  });
  delivery.setReplyTargetForThread("thread-topic", {
    userId: "500", contextToken: "telegram:500", provider: "telegram", messageThreadId: "9",
  });

  assert.equal(delivery.resolveReplyTargetForRun({ threadId: "thread-topic" }).messageThreadId, "9");
  assert.equal(
    Object.hasOwn(delivery.resolveReplyTargetForRun({ threadId: "thread-default" }), "messageThreadId"),
    false,
  );
  // Fail closed: a session with no recorded lane resolves to nothing rather
  // than to the binding's shared target, which would land in whichever topic
  // replied most recently.
  assert.equal(delivery.resolveReplyTargetForRun({ threadId: "thread-unknown" }), null);
  assert.equal(delivery.resolveReplyTargetForRun({ threadId: "" }), null);
});
