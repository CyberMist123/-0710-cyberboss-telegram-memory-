const test = require("node:test");
const assert = require("node:assert/strict");

const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");

test("codex reasoning and thinking events map to runtime thinking events", () => {
  assert.deepEqual(mapCodexMessageToRuntimeEvent({
    method: "reasoning/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "internal thought",
    },
  }), {
    type: "runtime.thinking",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "",
      text: "internal thought",
      sourceMethod: "reasoning/delta",
    },
  });

  assert.deepEqual(mapCodexMessageToRuntimeEvent({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-1",
        type: "reasoning",
      },
      summary: "internal thought",
    },
  }), {
    type: "runtime.item.started",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "reasoning",
      text: "internal thought",
    },
  });

  assert.deepEqual(mapCodexMessageToRuntimeEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-1",
        type: "reasoning",
      },
      text: "internal thought",
    },
  }), {
    type: "runtime.thinking",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "internal thought",
      sourceMethod: "item/completed",
      itemType: "reasoning",
    },
  });
});
