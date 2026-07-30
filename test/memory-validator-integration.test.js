const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { StreamDelivery } = require("../src/core/stream-delivery");

test("reply delivery falls back when outgoing text conflicts with hard memory", async () => {
  const sent = [];
  const appLike = {
    memoryService: {
      resolvePreResponseMemory() {
        return {
          index: [{
            id: "mem_1",
            key: "nickname",
            value: "哥哥",
            text: "叫我哥哥",
            priority: "hard_preference",
            status: "active",
          }],
        };
      },
    },
  };
  appLike.transformReplyDelivery = CyberbossApp.prototype.transformReplyDelivery;
  // transformReplyDelivery now also feeds the reply back into the legacy memory
  // background pipeline (src/core/app.js:2616/2621/2628 -> :2632 -> :2644).
  // The recorder is borrowed for real; only the fire-and-forget pipeline is
  // stubbed out, exactly as test/telegram-lane-isolation.test.js:76 does.
  appLike.recordAssistantReplyForMemory = CyberbossApp.prototype.recordAssistantReplyForMemory;
  appLike.maybeRunLegacyMemoryBackgroundPipeline = () => {};

  const streamDelivery = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
      getKnownContextTokens() {
        return {};
      },
    },
    sessionStore: {
      findBindingForThreadId() {
        return null;
      },
    },
    transformReplyDelivery: (payload) => appLike.transformReplyDelivery(payload),
  });

  streamDelivery.queueReplyTargetForThread("thread-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", text: "nickname 以后我叫你宝宝" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "nickname 以后我叫你哥哥",
    contextToken: "ctx-1",
  }]);
});
