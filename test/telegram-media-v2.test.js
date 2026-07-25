const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_MEDIA_KINDS,
  buildTelegramMediaDescriptors,
  createTelegramMediaDescriptor,
} = require("../src/services/telegram-media-descriptor");
const { MediaInboxService } = require("../src/services/media-inbox-service");
const { runWhisperProcess } = require("../src/services/local-whisper-transcriber");
const { createTelegramChannelAdapter } = require("../src/adapters/channel/telegram");

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("Telegram media descriptor allowlist and unknown-kind fail closed", () => {
  assert.deepEqual(Array.from(ALLOWED_MEDIA_KINDS).sort(), ["audio", "photo", "sticker", "voice"]);
  assert.equal(createTelegramMediaDescriptor({ kind: "document", fileId: "x" }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "photo", fileId: "x", extension: "../escape" }), null);
});

test("adapter descriptors preserve largest photo/caption and sticker formats", () => {
  const descriptors = buildTelegramMediaDescriptors({
    caption: "caption",
    photo: [
      { file_id: "small", width: 10, height: 10, file_size: 1 },
      { file_id: "large", width: 100, height: 100, file_size: 2 },
    ],
    sticker: { file_id: "tgs", is_animated: true, width: 10, height: 10 },
    voice: { file_id: "voice", file_size: 3, duration: 2 },
    audio: { file_id: "audio", file_size: 4, duration: 5, file_name: "song.mp3" },
  });
  assert.equal(descriptors.find((item) => item.kind === "photo").fileId, "large");
  assert.equal(descriptors.find((item) => item.kind === "photo").caption, "caption");
  assert.equal(descriptors.find((item) => item.kind === "voice").extension, ".oga");
  assert.equal(descriptors.find((item) => item.kind === "audio").extension, ".mp3");
  assert.equal(descriptors.find((item) => item.kind === "sticker").stickerType, "tgs");
  assert.equal(buildTelegramMediaDescriptors({ sticker: { file_id: "webm", is_video: true } })[0].stickerType, "webm");
  assert.equal(buildTelegramMediaDescriptors({ sticker: { file_id: "webp" } })[0].stickerType, "webp");
});

test("document and video remain placeholders and produce no downloadable descriptor", () => {
  const descriptors = buildTelegramMediaDescriptors({
    document: { file_id: "doc", file_name: "x.pdf" },
    video: { file_id: "video", file_size: 10 },
  });
  assert.deepEqual(descriptors, []);
});

test("duplicate Telegram updates are rejected before media download", () => {
  const stateDir = tempDir("cb-media-dedupe-");
  const adapter = createTelegramChannelAdapter({ telegramBotToken: "token", telegramStateFile: path.join(stateDir, "telegram-state.json") });
  const update = { update_id: 1, message: { message_id: 7, date: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, voice: { file_id: "voice", file_size: 1 } } };
  assert.ok(adapter.normalizeIncomingMessage(update));
  assert.equal(adapter.normalizeIncomingMessage(update), null);
});

test("MediaInboxService saves audio and sticker atomically under state media", async () => {
  const stateDir = tempDir("cb-media-v2-");
  const normalized = {
    messageId: "42",
    receivedAt: "2026-07-26T00:00:00.000Z",
    text: "[audio] caption",
    attachments: [],
    telegram: {
      media: [
        { kind: "audio", type: "audio", fileId: "a", extension: ".mp3", contentType: "audio/mpeg", sizeBytes: 2 },
        { kind: "sticker", type: "sticker", fileId: "s", extension: ".webp", contentType: "image/webp", stickerType: "webp", sizeBytes: 2 },
      ],
    },
  };
  const service = new MediaInboxService({ config: { stateDir, mediaInboxMaxBytes: 10 } });
  await service.processInboundMedia({
    normalized,
    channelAdapter: { async fetchFileById() { return { bytes: Buffer.from("ok"), remotePath: "x", sizeBytes: 2 }; } },
  });
  assert.equal(normalized.attachments.length, 2);
  for (const attachment of normalized.attachments) {
    assert.equal(attachment.absolutePath.startsWith(path.join(stateDir, "media")), true);
    assert.equal(fs.existsSync(attachment.absolutePath), true);
    assert.equal(fs.existsSync(`${attachment.absolutePath}.part`), false);
  }
});

test("MediaInboxService cleans part files after bounded download failure and deduplicates", async () => {
  const stateDir = tempDir("cb-media-part-");
  const normalized = {
    messageId: "42", receivedAt: new Date().toISOString(), text: "[photo]", attachments: [],
    telegram: { media: [{ kind: "photo", type: "photo", fileId: "p", extension: ".jpg", contentType: "image/jpeg", sizeBytes: 2 }] },
  };
  const service = new MediaInboxService({ config: { stateDir, mediaInboxMaxBytes: 10 } });
  let calls = 0;
  const channelAdapter = { async fetchFileById() { calls += 1; throw new Error("over limit during stream"); } };
  await service.processInboundMedia({ normalized, channelAdapter });
  await service.processInboundMedia({ normalized, channelAdapter });
  assert.equal(calls, 2);
  assert.equal(fs.readdirSync(path.join(stateDir, "media", "photos")).some((name) => name.endsWith(".part")), false);
});

test("local Whisper process reports success, nonzero exit, missing Python, timeout, and output limits", async () => {
  const success = await runWhisperProcess({ command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({text:'hello',model:'test'}))"], timeoutMs: 1000, maxOutputChars: 100, maxStderrChars: 100 });
  assert.equal(success.ok, true);
  const nonzero = await runWhisperProcess({ command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 1000, maxOutputChars: 100, maxStderrChars: 100 });
  assert.match(nonzero.error, /process_exit/);
  const missing = await runWhisperProcess({ command: "definitely-not-a-python-command", args: [], timeoutMs: 1000, maxOutputChars: 100, maxStderrChars: 100 });
  assert.equal(missing.error, "python_not_found");
  const timeout = await runWhisperProcess({ command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], timeoutMs: 30, maxOutputChars: 100, maxStderrChars: 100 });
  assert.equal(timeout.error, "timeout");
  const output = await runWhisperProcess({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(101))"], timeoutMs: 1000, maxOutputChars: 100, maxStderrChars: 100 });
  assert.equal(output.error, "stdout_limit");
});
