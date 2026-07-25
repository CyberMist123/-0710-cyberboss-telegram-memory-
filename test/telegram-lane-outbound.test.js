"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTelegramChannelAdapter } = require("../src/adapters/channel/telegram");

function makeAdapter() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tg-out-"));
  return createTelegramChannelAdapter({
    telegramBotToken: "test-token",
    accountId: "telegram",
    workspaceId: "default",
    telegramStateFile: path.join(stateDir, "telegram-state.json"),
  });
}

// Captures every outbound Telegram API call without any network access.
function captureRequests(run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = String(url).split("/").pop().split("?")[0];
    let body = null;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body);
    } else if (init.body && typeof init.body.get === "function") {
      body = Object.fromEntries(
        [...init.body.keys()].map((key) => [key, init.body.get(key)]),
      );
    }
    calls.push({ endpoint, body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: {} };
      },
      async text() {
        return JSON.stringify({ ok: true, result: {} });
      },
    };
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function makeFile(name, contents = "x") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tg-file-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

test("inbound messages capture the topic id and keep the default lane distinct", () => {
  const adapter = makeAdapter();

  const withTopic = adapter.normalizeIncomingMessage({
    message: {
      message_id: 1, date: 1, chat: { id: 500, type: "private" },
      from: { id: 77 }, text: "hi", message_thread_id: 9,
    },
  });
  assert.equal(withTopic.messageThreadId, "9");
  assert.equal(withTopic.telegram.messageThreadId, "9");
  assert.equal(withTopic.threadKey, "500:9");

  const withoutTopic = adapter.normalizeIncomingMessage({
    message: {
      message_id: 2, date: 1, chat: { id: 500, type: "private" },
      from: { id: 77 }, text: "hi",
    },
  });
  assert.equal(withoutTopic.messageThreadId, null);
  assert.equal(withoutTopic.threadKey, "500");
  assert.notEqual(withTopic.threadKey, withoutTopic.threadKey);
});

test("the same message id in two topics is not deduplicated away", () => {
  const adapter = makeAdapter();
  const base = { message_id: 7, date: 1, chat: { id: 500, type: "private" }, from: { id: 77 }, text: "hi" };

  assert.ok(adapter.normalizeIncomingMessage({ message: { ...base, message_thread_id: 1 } }));
  assert.ok(adapter.normalizeIncomingMessage({ message: { ...base, message_thread_id: 2 } }));
  // The exact same lane and message id is still a duplicate.
  assert.equal(adapter.normalizeIncomingMessage({ message: { ...base, message_thread_id: 2 } }), null);
});

test("a present but non-canonical topic id drops the message instead of routing it", () => {
  const adapter = makeAdapter();
  for (const messageThreadId of ["", "abc", 0, -1, 1.5, "01"]) {
    const normalized = adapter.normalizeIncomingMessage({
      message: {
        message_id: Math.floor(Math.random() * 1e9), date: 1,
        chat: { id: 500, type: "private" }, from: { id: 77 }, text: "hi", message_thread_id: messageThreadId,
      },
    });
    assert.equal(normalized, null, `expected drop for ${JSON.stringify(messageThreadId)}`);
  }
});

test("sendText carries message_thread_id on every chunk, and omits it for the default lane", async () => {
  const adapter = makeAdapter();
  await captureRequests(async (calls) => {
    await adapter.sendText({ userId: "500", text: "hello", messageThreadId: "9" });
    await adapter.sendText({ userId: "500", text: "hello", messageThreadId: null });

    const [topic, plain] = calls;
    assert.equal(topic.endpoint, "sendMessage");
    assert.equal(topic.body.message_thread_id, 9);
    assert.equal(typeof topic.body.message_thread_id, "number");
    assert.equal(Object.hasOwn(plain.body, "message_thread_id"), false);
  });
});

test("typing carries message_thread_id", async () => {
  const adapter = makeAdapter();
  await captureRequests(async (calls) => {
    await adapter.sendTyping({ userId: "500", messageThreadId: 4 });
    await adapter.sendTyping({ userId: "500" });

    assert.equal(calls[0].endpoint, "sendChatAction");
    assert.equal(calls[0].body.message_thread_id, 4);
    assert.equal(Object.hasOwn(calls[1].body, "message_thread_id"), false);
  });
});

test("voice, document and photo all carry message_thread_id", async () => {
  const adapter = makeAdapter();
  const filePath = makeFile("clip.ogg");
  await captureRequests(async (calls) => {
    await adapter.sendVoice({ userId: "500", filePath, messageThreadId: "12" });
    await adapter.sendFile({ userId: "500", filePath, messageThreadId: "12" });
    await adapter.sendPhoto({ userId: "500", filePath, caption: "c", messageThreadId: "12" });

    assert.deepEqual(calls.map((call) => call.endpoint), ["sendVoice", "sendDocument", "sendPhoto"]);
    for (const call of calls) {
      assert.equal(call.body.message_thread_id, "12", `${call.endpoint} lost the topic`);
      assert.equal(call.body.chat_id, "500");
    }
  });
});

test("media sends omit the field entirely for the default lane", async () => {
  const adapter = makeAdapter();
  const filePath = makeFile("doc.txt");
  await captureRequests(async (calls) => {
    await adapter.sendVoice({ userId: "500", filePath });
    await adapter.sendFile({ userId: "500", filePath, messageThreadId: null });
    for (const call of calls) {
      assert.equal(Object.hasOwn(call.body, "message_thread_id"), false);
    }
  });
});

test("a non-canonical outbound topic id is rejected rather than dropped to the default lane", async () => {
  const adapter = makeAdapter();
  await captureRequests(async (calls) => {
    await assert.rejects(
      () => adapter.sendText({ userId: "500", text: "x", messageThreadId: "abc" }),
      /messageThreadId/,
    );
    await assert.rejects(
      () => adapter.sendText({ userId: "500", text: "x", messageThreadId: -1 }),
      /messageThreadId/,
    );
    assert.equal(calls.length, 0, "nothing was sent to the wrong lane");
  });
});

test("errors and status text reach the originating topic because they use sendText", async () => {
  const adapter = makeAdapter();
  await captureRequests(async (calls) => {
    await adapter.sendText({ userId: "500", text: "❌ Request failed\nboom", messageThreadId: "9" });
    await adapter.sendText({ userId: "500", text: "✅ Compact finished", messageThreadId: "9" });
    for (const call of calls) {
      assert.equal(call.body.message_thread_id, 9);
    }
  });
});
