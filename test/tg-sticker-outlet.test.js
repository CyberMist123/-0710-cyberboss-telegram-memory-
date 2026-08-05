const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readConfig } = require("../src/core/config");
const { createProjectTooling } = require("../src/tools/create-project-tooling");
const { ChannelFileService } = require("../src/services/channel-file-service");
const { StickerService } = require("../src/services/sticker-service");

const REPO_ROOT = path.join(__dirname, "..");

const CHANNEL_ENV_KEYS = [
  "CYBERBOSS_STATE_DIR",
  "CYBERBOSS_CONTINUITY_DIR",
  "CYBERBOSS_CHANNEL",
  "CYBERBOSS_TELEGRAM_BOT_TOKEN",
];

// The tool-mcp-server child builds its tooling from `readConfig()` alone and
// passes no adapter, so the config has to come from the same place the child
// gets it -- a hand-written object would not prove the default path.
function withChannelConfig(channel, run) {
  const saved = Object.fromEntries(CHANNEL_ENV_KEYS.map((key) => [key, process.env[key]]));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-channel-outlet-"));
  try {
    process.env.CYBERBOSS_STATE_DIR = stateDir;
    process.env.CYBERBOSS_CONTINUITY_DIR = path.join(stateDir, "continuity");
    process.env.CYBERBOSS_CHANNEL = channel;
    process.env.CYBERBOSS_TELEGRAM_BOT_TOKEN = "test-token";
    run(readConfig());
  } finally {
    for (const key of CHANNEL_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

test("tool server tooling routes channel tools to telegram when the deployment channel is telegram", () => {
  withChannelConfig("telegram", (config) => {
    // No channelAdapter option: this is exactly the tool-mcp-server call shape.
    const { services } = createProjectTooling(config);
    const adapter = services.channelFile.channelAdapter;
    assert.equal(adapter.describe().id, "telegram");
    // A WeChat adapter here is what made sticker send fail with
    // "No saved WeChat account was found" while running on Telegram.
    assert.equal(typeof adapter.resolveSelectedAccount, "undefined");
    assert.equal(services.sticker.channelAdapter.describe().id, "telegram");
  });
});

test("tool server tooling keeps the weixin adapter when the channel is not telegram", () => {
  withChannelConfig("weixin", (config) => {
    const { services } = createProjectTooling(config);
    assert.equal(services.channelFile.channelAdapter.describe().id, "weixin");
  });
});

test("sticker send asks the channel for the inline animation form", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sticker-outlet-"));
  const stickersDir = path.join(stateDir, "stickers");
  const config = {
    stateDir,
    stickersDir,
    stickerAssetsDir: path.join(stickersDir, "assets"),
    stickersIndexFile: path.join(stickersDir, "index.json"),
    stickerTagsFile: path.join(stickersDir, "tags.json"),
    stickersTemplateDir: path.join(REPO_ROOT, "templates", "stickers"),
    stickersTemplateIndexFile: path.join(REPO_ROOT, "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.join(REPO_ROOT, "templates", "stickers", "tags.json"),
    channel: "telegram",
    accountId: "telegram",
  };
  const sent = [];
  const service = new StickerService({
    config,
    channelAdapter: { async sendText() {} },
    sessionStore: { state: { bindings: {} } },
    channelFileService: {
      async sendToCurrentChat(args) {
        sent.push(args);
        return { filePath: args.filePath, userId: args.userId, sentAs: "animation" };
      },
    },
  });

  const stickerId = Object.keys(require("../src/services/sticker-service").loadStickerIndexSync(config))[0];
  assert.ok(stickerId, "template sticker library should seed at least one sticker");
  await service.sendToCurrentChat({ stickerId, userId: "tg-user-1" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].as, "animation");

  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("channel file service prefers sendAnimation and falls back to sendFile", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-channel-file-"));
  const filePath = path.join(stateDir, "stk_001.gif");
  fs.writeFileSync(filePath, Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
  const config = { channel: "telegram", accountId: "telegram", stateDir };

  const animationCalls = [];
  const inline = new ChannelFileService({
    config,
    channelAdapter: {
      async sendTyping() {},
      async sendFile() { throw new Error("sendFile must not be used when sendAnimation exists"); },
      async sendAnimation(payload) { animationCalls.push(payload); },
    },
    sessionStore: { state: { bindings: {} } },
  });
  const inlineResult = await inline.sendToCurrentChat({ filePath, userId: "tg-user-1", as: "animation" });
  assert.equal(animationCalls.length, 1);
  assert.equal(animationCalls[0].userId, "tg-user-1");
  assert.equal(animationCalls[0].contextToken, "telegram:tg-user-1");
  assert.equal(inlineResult.sentAs, "animation");

  // A channel with no inline form (weixin) must still deliver the sticker.
  const fileCalls = [];
  const fallback = new ChannelFileService({
    config,
    channelAdapter: {
      async sendTyping() {},
      async sendFile(payload) { fileCalls.push(payload); },
    },
    sessionStore: { state: { bindings: {} } },
  });
  const fallbackResult = await fallback.sendToCurrentChat({ filePath, userId: "tg-user-1", as: "animation" });
  assert.equal(fileCalls.length, 1);
  assert.equal(fallbackResult.sentAs, "file");

  fs.rmSync(stateDir, { recursive: true, force: true });
});
