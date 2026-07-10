const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createTelegramChannelAdapter,
  chunkReplyTextForTelegram,
} = require("../src/adapters/channel/telegram");

test("chunkReplyTextForTelegram merges short natural boundaries", () => {
  const chunks = chunkReplyTextForTelegram("A。\n\nB。\n\nC。", 20);
  assert.deepEqual(chunks, ["A。\n\nB。\n\nC。"]);
});

test("telegram adapter persists min chunk chars and splits outbound text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-telegram-chunks-"));
  const config = {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: ["1"],
    telegramStateFile: path.join(dir, "telegram-state.json"),
    accountId: "telegram-test",
  };

  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(options.body || "{}")),
    });
    return {
      ok: true,
      async text() {
        return "{}";
      },
    };
  };

  try {
    const adapter = createTelegramChannelAdapter(config);
    assert.equal(adapter.getMinChunkChars(), 20);
    assert.equal(adapter.setMinChunkChars(50), 50);

    const reloaded = createTelegramChannelAdapter(config);
    assert.equal(reloaded.getMinChunkChars(), 50);

    const longA = "a".repeat(3000);
    const longB = "b".repeat(3000);
    await reloaded.sendText({
      userId: "1",
      text: `${longA}\n\n${longB}`,
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.chat_id, "1");
    assert.equal(requests[0].body.text, `${longA}\n\n`);
    assert.equal(requests[1].body.text, longB);

    const saved = JSON.parse(fs.readFileSync(config.telegramStateFile, "utf8"));
    assert.equal(saved.minChunkChars, 50);
  } finally {
    global.fetch = originalFetch;
  }
});
