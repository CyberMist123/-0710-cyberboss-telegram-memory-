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
const { createTelegramChannelAdapter, readResponseBytesBounded } = require("../src/adapters/channel/telegram");
const { resolveStateMediaReference } = require("../src/services/media-inbox-service");
const { readConfig } = require("../src/core/config");
const { CyberbossApp } = require("../src/core/app");

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("Telegram media descriptor allowlist and unknown-kind fail closed", () => {
  assert.deepEqual(Array.from(ALLOWED_MEDIA_KINDS).sort(), ["audio", "photo", "sticker", "voice"]);
  assert.equal(createTelegramMediaDescriptor({ kind: "document", fileId: "x" }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "photo", fileId: "x", extension: "../escape" }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "photo", fileId: "x", sizeBytes: -1 }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "photo", fileId: "x", width: "10" }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "voice", fileId: "x", durationSec: Infinity }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "photo", fileId: "x", extension: ".jpg", contentType: "text/html" }), null);
  assert.equal(createTelegramMediaDescriptor({ kind: "audio", fileId: "x", extension: ".mp3", contentType: "audio/ogg" }), null);
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

test("MediaInboxService rejects media-root links and unsafe state references without writing outside state", async (t) => {
  const stateDir = tempDir("cb-media-link-");
  const outside = tempDir("cb-media-outside-");
  const mediaPath = path.join(stateDir, "media");
  try {
    fs.symlinkSync(outside, mediaPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code || "unknown"}`);
    return;
  }
  const normalized = { messageId: "link", receivedAt: new Date().toISOString(), attachments: [], telegram: { media: [{ kind: "photo", fileId: "p", extension: ".jpg", contentType: "image/jpeg", sizeBytes: 1 }] } };
  let calls = 0;
  const service = new MediaInboxService({ config: { stateDir, mediaInboxMaxBytes: 10 } });
  await service.processInboundMedia({ normalized, channelAdapter: { async fetchFileById() { calls += 1; return { bytes: Buffer.from("x"), sizeBytes: 1 }; } } });
  assert.equal(calls, 0);
  assert.deepEqual(normalized.attachments, []);
  assert.equal(fs.readdirSync(outside).length, 0);
  assert.equal(resolveStateMediaReference(stateDir, "state-media://media/../escape.jpg"), "");
  assert.equal(resolveStateMediaReference(stateDir, `state-media://${["C:", "escape.jpg"].join("/")}`), "");
  assert.equal(resolveStateMediaReference(stateDir, "state-media:////server/share/x.jpg"), "");
});

test("bounded Telegram response rejects non-streaming bodies and cancels interrupted readers", async () => {
  await assert.rejects(() => readResponseBytesBounded({ body: null }, 10), /bounded streaming/);
  let cancelled = false;
  let released = false;
  const reader = {
    async read() { throw new Error("connection reset"); },
    async cancel() { cancelled = true; },
    releaseLock() { released = true; },
  };
  await assert.rejects(() => readResponseBytesBounded({ body: { getReader: () => reader } }, 10), /connection reset/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
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

test("local Whisper timeout waits for a real helper process and its child tree to exit", async () => {
  const pidFile = path.join(tempDir("cb-whisper-pids-"), "pids.json");
  const helper = [
    "const fs=require('fs'),cp=require('child_process');",
    "const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});",
    `fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));`,
    "setInterval(()=>{},10000);",
  ].join("");
  const result = await runWhisperProcess({ command: process.execPath, args: ["-e", helper], timeoutMs: 300, maxOutputChars: 100, maxStderrChars: 100 });
  assert.equal(result.error, "timeout");
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH|not found|unknown process/i);
  }
});

test("local Whisper config stays opt-in and rejects invalid enabled configuration", () => {
  const keys = ["CYBERBOSS_LOCAL_WHISPER_ENABLED", "CYBERBOSS_LOCAL_WHISPER_MODEL", "CYBERBOSS_LOCAL_WHISPER_TIMEOUT_MS"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(readConfig().localWhisperEnabled, false);
    process.env.CYBERBOSS_LOCAL_WHISPER_ENABLED = "maybe";
    assert.throws(() => readConfig(), /explicit boolean/);
    process.env.CYBERBOSS_LOCAL_WHISPER_ENABLED = "true";
    process.env.CYBERBOSS_LOCAL_WHISPER_MODEL = "small";
    assert.throws(() => readConfig(), /existing local absolute directory/);
    process.env.CYBERBOSS_LOCAL_WHISPER_MODEL = tempDir("cb-whisper-model-");
    process.env.CYBERBOSS_LOCAL_WHISPER_TIMEOUT_MS = "1.5";
    assert.throws(() => readConfig(), /TIMEOUT_MS must be an integer/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test("Telegram handler completes media and STT before record and runtime draft, while duplicate updates stop before download", async () => {
  const stateDir = tempDir("cb-media-chain-");
  const adapter = createTelegramChannelAdapter({ telegramBotToken: "fake", telegramStateFile: path.join(stateDir, "telegram-state.json") });
  const update = { update_id: 4, message: { message_id: 12, date: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, caption: "caption", voice: { file_id: "voice", file_size: 2, duration: 1, mime_type: "audio/ogg" } } };
  const normalized = adapter.normalizeIncomingMessage(update);
  assert.ok(normalized);
  assert.equal(adapter.normalizeIncomingMessage(update), null);
  let downloads = 0;
  let stt = 0;
  const records = [];
  const drafts = [];
  const app = {
    config: { channel: "telegram", stateDir },
    telegramChannelAdapter: { async fetchFileById() { downloads += 1; return { bytes: Buffer.from("ok"), sizeBytes: 2 }; } },
    projectServices: {
      mediaInbox: new MediaInboxService({ config: { stateDir, mediaInboxMaxBytes: 10 } }),
      voice: { async processInboundVoice({ normalized: item }) { stt += 1; item.text = `${item.text}\n[transcribed]`; item.voiceTranscription = { provider: "fake" }; } },
    },
    logTelegramDebug() {},
    recordInboundMessage(item) { records.push({ attachments: item.attachments.length, text: item.text }); },
    async handlePreparedMessage(item) { drafts.push(await CyberbossApp.prototype.buildRuntimeTurn.call({ config: { stateDir } }, { prepared: item })); },
  };
  await CyberbossApp.prototype.handleTelegramMessage.call(app, normalized);
  assert.equal(downloads, 1);
  assert.equal(stt, 1);
  assert.deepEqual(records, [{ attachments: 1, text: normalized.text }]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].text.split("\n").filter((line) => line.startsWith("<media ")).length, 1);
  assert.match(drafts[0].text, /caption/);
});
