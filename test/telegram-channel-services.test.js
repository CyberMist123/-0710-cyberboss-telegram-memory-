const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ChannelFileService } = require("../src/services/channel-file-service");
const { StickerService } = require("../src/services/sticker-service");

test("channel file service sends files on telegram without WeChat account files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-telegram-file-"));
  const filePath = path.join(tempDir, "note.txt");
  fs.writeFileSync(filePath, "hello", "utf8");
  const sent = [];
  const service = new ChannelFileService({
    config: {
      channel: "telegram",
      accountId: "telegram-deepseek",
      allowedUserIds: [],
    },
    channelAdapter: {
      async sendTyping(payload) {
        sent.push(["typing", payload]);
      },
      async sendFile(payload) {
        sent.push(["file", payload]);
      },
    },
    sessionStore: {
      getBindings() {
        return {};
      },
    },
  });

  const result = await service.sendToCurrentChat({
    filePath,
    userId: "8719061650",
  }, {});

  assert.equal(result.userId, "8719061650");
  assert.equal(result.filePath, filePath);
  assert.deepEqual(sent[0], ["typing", { userId: "8719061650", status: 1, contextToken: "telegram:8719061650" }]);
  assert.deepEqual(sent[1], ["file", { userId: "8719061650", filePath, contextToken: "telegram:8719061650" }]);
});

test("sticker service sends context text on telegram without WeChat account files", async () => {
  const sentTexts = [];
  const service = new StickerService({
    config: {
      channel: "telegram",
      accountId: "telegram-deepseek",
      allowedUserIds: [],
    },
    channelAdapter: {
      async sendText(payload) {
        sentTexts.push(payload);
      },
    },
    sessionStore: {
      getBindings() {
        return {};
      },
    },
    channelFileService: {
      async sendToCurrentChat() {
        return {};
      },
    },
  });

  const ok = await service.sendContextText({
    text: "saved",
    userId: "8719061650",
  }, {});

  assert.equal(ok, true);
  assert.deepEqual(sentTexts, [{
    userId: "8719061650",
    text: "saved",
    contextToken: "telegram:8719061650",
    preserveBlock: true,
  }]);
});
