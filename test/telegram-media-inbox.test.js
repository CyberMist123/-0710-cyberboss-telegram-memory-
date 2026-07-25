const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { createTelegramChannelAdapter } = require("../src/adapters/channel/telegram");
const { MediaInboxService, DEFAULT_MAX_INBOUND_MEDIA_BYTES } = require("../src/services/media-inbox-service");
const { VoiceService } = require("../src/services/voice-service");
const { CyberbossApp } = require("../src/core/app");

function makeTempStateDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAdapter(stateDir) {
  return createTelegramChannelAdapter({
    telegramBotToken: "token-123",
    telegramAllowedUserIds: [],
    telegramStateFile: path.join(stateDir, "telegram-state.json"),
  });
}

function makePhotoUpdate({ messageId = 42, caption = "" } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      date: 1753142400,
      chat: { id: 777, type: "private" },
      from: { id: 777, is_bot: false },
      ...(caption ? { caption } : {}),
      photo: [
        { file_id: "photo-small", width: 90, height: 60, file_size: 1200 },
        { file_id: "photo-large", width: 900, height: 600, file_size: 50_000 },
        { file_id: "photo-medium", width: 320, height: 210, file_size: 9_000 },
      ],
    },
  };
}

test("telegram adapter keeps largest photo metadata and caption", () => {
  const stateDir = makeTempStateDir("cb-tg-photo-meta-");
  const adapter = makeAdapter(stateDir);

  const normalized = adapter.normalizeIncomingMessage(makePhotoUpdate({ caption: "look at this" }));

  assert.equal(normalized.text, "[图片] look at this");
  assert.deepEqual(normalized.attachments, []);
  assert.equal(normalized.telegram.caption, "look at this");
  assert.equal(normalized.telegram.photo.fileId, "photo-large");
  assert.equal(normalized.telegram.photo.width, 900);
  assert.equal(normalized.telegram.photo.height, 600);
  assert.equal(normalized.telegram.photo.sizeBytes, 50_000);
  assert.equal(normalized.telegram.voice, null);
});

test("telegram adapter keeps voice caption in text", () => {
  const stateDir = makeTempStateDir("cb-tg-voice-meta-");
  const adapter = makeAdapter(stateDir);

  const normalized = adapter.normalizeIncomingMessage({
    update_id: 2,
    message: {
      message_id: 43,
      date: 1753142401,
      chat: { id: 777, type: "private" },
      from: { id: 777, is_bot: false },
      caption: "listen to this",
      voice: { file_id: "voice-1", duration: 3, mime_type: "audio/ogg", file_size: 4_000 },
    },
  });

  assert.equal(normalized.text, "[语音] listen to this");
  assert.equal(normalized.telegram.voice.fileId, "voice-1");
  assert.equal(normalized.telegram.photo, null);
});

test("media inbox service saves photo metadata without rewriting message text", async () => {
  const stateDir = makeTempStateDir("cb-media-photo-");
  const service = new MediaInboxService({ config: { stateDir } });
  const normalized = {
    messageId: "42",
    receivedAt: "2026-07-22T02:00:00.000Z",
    text: "[图片] look at this",
    attachments: [],
    telegram: { photo: { kind: "photo", type: "photo", fileId: "photo-large", width: 900, height: 600, sizeBytes: 50_000, extension: ".jpg", contentType: "image/jpeg" } },
  };
  const calls = [];

  await service.processInboundPhoto({
    normalized,
    channelAdapter: {
      async fetchFileById({ fileId, maxSizeBytes }) {
        calls.push({ fileId, maxSizeBytes });
        return { bytes: Buffer.from("photo"), remotePath: "photo.jpg", fileName: "photo.jpg", sizeBytes: 5 };
      },
    },
  });

  const expectedDir = path.join(stateDir, "media", "photos");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fileId, "photo-large");
  assert.equal(calls[0].maxSizeBytes, DEFAULT_MAX_INBOUND_MEDIA_BYTES);
  assert.equal(normalized.text, "[图片] look at this");
  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].kind, "photo");
  assert.equal(normalized.attachments[0].type, "photo");
  assert.equal(normalized.attachments[0].isImage, true);
  assert.equal(normalized.attachments[0].absolutePath.startsWith(expectedDir), true);
  assert.equal(normalized.attachments[0].path, normalized.attachments[0].absolutePath);
  assert.equal(normalized.attachments[0].contentType, "image/jpeg");
  assert.equal(normalized.attachments[0].downloadState, "saved");
});

test("media inbox service logs failures without mutating message text", async () => {
  const service = new MediaInboxService({ config: { stateDir: makeTempStateDir("cb-media-photo-fail-") } });
  const normalized = {
    messageId: "42",
    receivedAt: "2026-07-22T02:00:00.000Z",
    text: "[图片] look at this",
    attachments: [],
    telegram: { photo: { kind: "photo", type: "photo", fileId: "photo-large", width: 900, height: 600, sizeBytes: 50_000, extension: ".jpg", contentType: "image/jpeg" } },
  };
  const logs = [];

  await service.processInboundPhoto({
    normalized,
    channelAdapter: {
      async fetchFileById() {
        throw new Error("boom");
      },
    },
    log: (message) => logs.push(message),
  });

  assert.equal(normalized.text, "[图片] look at this");
  assert.deepEqual(normalized.attachments, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /photo inbound failed .*error=boom/);
});

test("media inbox service skips oversized photos without downloading", async () => {
  const service = new MediaInboxService({ config: { stateDir: makeTempStateDir("cb-media-photo-large-") } });
  const normalized = {
    messageId: "42",
    receivedAt: "2026-07-22T02:00:00.000Z",
    text: "[图片]",
    attachments: [],
    telegram: {
      photo: {
        kind: "photo",
        type: "photo",
        fileId: "photo-large",
        width: 900,
        height: 600,
        sizeBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES + 1,
        extension: ".jpg",
        contentType: "image/jpeg",
      },
    },
  };
  const logs = [];
  let downloadCalls = 0;

  await service.processInboundPhoto({
    normalized,
    channelAdapter: {
      async fetchFileById() {
        downloadCalls += 1;
        return { absolutePath: path.join(os.tmpdir(), "cb-media-photos", "inbox", "x.jpg"), fileName: "x.jpg", sizeBytes: 1 };
      },
    },
    log: (message) => logs.push(message),
  });

  assert.equal(downloadCalls, 0);
  assert.equal(normalized.text, "[图片]");
  assert.deepEqual(normalized.attachments, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /photo inbound skipped .*limit=/);
});

function makeVoiceNormalized({ text = "[voice] caption" } = {}) {
  return {
    messageId: "voice-42",
    receivedAt: "2026-07-22T02:00:00.000Z",
    text,
    attachments: [],
    telegram: {
      voice: {
        fileId: "voice-file",
        durationSec: 3,
        mimeType: "audio/ogg",
        sizeBytes: 4_000,
      },
    },
  };
}

function makeVoiceService({ maxBytes = 0 } = {}) {
  return new VoiceService({
    config: {
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-media-voice-")),
      mediaInboxMaxBytes: maxBytes || DEFAULT_MAX_INBOUND_MEDIA_BYTES,
    },
  });
}

function makeSavedVoiceAttachment() {
  return {
    kind: "voice",
    type: "voice",
    absolutePath: path.join(os.tmpdir(), "voice-42.oga"),
    path: path.join(os.tmpdir(), "voice-42.oga"),
  };
}

test("voice service preserves saved metadata and appends no path to the text", async () => {
  const service = makeVoiceService();
  const normalized = makeVoiceNormalized();
  normalized.attachments = [makeSavedVoiceAttachment()];

  await service.processInboundVoice({ normalized });

  assert.equal(normalized.attachments[0].type, "voice");
  assert.equal(normalized.attachments[0].path, normalized.attachments[0].absolutePath);
  assert.equal(normalized.text, "[voice] caption");
});

test("MediaInboxService rejects oversized voice before download", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-media-voice-large-"));
  const media = { kind: "voice", type: "voice", fileId: "voice-file", extension: ".oga", contentType: "audio/ogg", sizeBytes: DEFAULT_MAX_INBOUND_MEDIA_BYTES + 1 };
  const service = new MediaInboxService({ config: { stateDir } });
  const normalized = makeVoiceNormalized();
  normalized.telegram.media = [media];
  const logs = [];
  let calls = 0;

  await service.processInboundMedia({
    normalized,
    channelAdapter: { async fetchFileById() { calls += 1; } },
    log: (message) => logs.push(message),
  });

  assert.equal(calls, 0);
  assert.deepEqual(normalized.attachments, []);
  assert.match(logs[0], /voice inbound skipped/);
});

test("MediaInboxService logs voice download failure without losing caption", async () => {
  const service = new MediaInboxService({ config: { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-media-voice-fail-")) } });
  const normalized = makeVoiceNormalized();
  normalized.telegram.media = [{ kind: "voice", type: "voice", fileId: "voice-file", extension: ".oga", contentType: "audio/ogg", sizeBytes: 1 }];
  const logs = [];

  await service.processInboundMedia({
    normalized,
    channelAdapter: { async fetchFileById() { throw new Error("download boom"); } },
    log: (message) => logs.push(message),
  });

  assert.match(normalized.text, /caption/);
  assert.deepEqual(normalized.attachments, []);
  assert.match(logs[0], /voice inbound failed .*download boom/);
});

test("voice STT success appends to the original text", async () => {
  const service = makeVoiceService();
  service.kit = {
    sttEnabled: () => true,
    async transcribe() { return { ok: true, text: "spoken words", provider: "test", model: "test", elapsedMs: 1 }; },
  };
  const normalized = makeVoiceNormalized({ text: "[voice] keep this caption" });
  normalized.attachments = [makeSavedVoiceAttachment()];

  await service.processInboundVoice({ normalized });

  assert.match(normalized.text, /keep this caption/);
  assert.match(normalized.text, /spoken words/);
});

test("voice STT failure preserves original text and saved path", async () => {
  const service = makeVoiceService();
  service.kit = {
    sttEnabled: () => true,
    async transcribe() { return { ok: false, error: "stt boom", provider: "test" }; },
  };
  const normalized = makeVoiceNormalized({ text: "[voice] keep this caption" });
  normalized.attachments = [makeSavedVoiceAttachment()];

  await service.processInboundVoice({ normalized });

  assert.match(normalized.text, /keep this caption/);
  assert.equal(normalized.attachments[0].absolutePath.endsWith("voice-42.oga"), true);
  assert.match(normalized.text, /转写失败/);
});

test("Telegram runtime bridge preserves ordinary text payload without media side effects", async () => {
  const turn = await CyberbossApp.prototype.buildRuntimeTurn.call({ config: {} }, {
    prepared: { provider: "telegram", text: "hello\nworld", originalText: "hello\nworld", attachments: [] },
  });
  const encoded = turn.text.match(/>([A-Za-z0-9_-]+)</)?.[1];
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(payload.text, "hello\nworld");
  assert.deepEqual(payload.attachments, []);
  assert.deepEqual(turn.attachments, []);
});
