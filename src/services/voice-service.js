"use strict";

const path = require("path");

const { ConversationRecorder } = require("./conversation-recorder");
const {
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  writeMediaLog,
} = require("./media-inbox-service");

const VOICE_PLACEHOLDER = "[语音]";

/**
 * Bridge between cyberboss and the standalone voice-kit module.
 *
 * voice-kit lives outside this repo and is located via config.voiceKitDir
 * (CYBERBOSS_VOICE_KIT_DIR). If the dir is missing or providers are not
 * configured, everything degrades to the current behavior ("[语音]"
 * placeholder, no voice replies) without blocking the message flow.
 */
class VoiceService {
  constructor({ config }) {
    this.config = config || {};
    this.kit = loadVoiceKit(this.config);
    this.recorder = this.config.conversationDir
      ? new ConversationRecorder({ dirPath: this.config.conversationDir })
      : null;
  }

  describe() {
    return this.kit ? this.kit.describe() : { id: "voice-kit", state: "not_loaded" };
  }

  ttsEnabled() {
    return Boolean(this.kit && this.kit.ttsEnabled());
  }

  /**
   * Handle an inbound Telegram voice message in-place on `normalized`:
   * download the audio into voiceMediaDir/inbox, attach it, transcribe it,
   * and rewrite `normalized.text`. Never throws.
   */
  async processInboundVoice({ normalized, channelAdapter, log = null }) {
    const voice = normalized?.telegram?.voice;
    if (!voice?.fileId || typeof channelAdapter?.downloadFileById !== "function") {
      return;
    }
    const mediaDir = normalizeText(this.config.voiceMediaDir);
    if (!mediaDir) {
      return;
    }
    const maxInboundBytes = normalizePositiveInt(this.config.mediaInboxMaxBytes)
      || DEFAULT_MAX_INBOUND_MEDIA_BYTES;
    if (voice.sizeBytes > maxInboundBytes) {
      normalized.text = `${normalized.text || VOICE_PLACEHOLDER}（超出大小上限，未下载）`;
      writeMediaLog(log, `voice inbound skipped messageId=${normalized.messageId} sizeBytes=${voice.sizeBytes} limit=${maxInboundBytes}`);
      return;
    }

    let saved = null;
    try {
      saved = await channelAdapter.downloadFileById({
        fileId: voice.fileId,
        targetDir: path.join(mediaDir, "inbox"),
        maxSizeBytes: maxInboundBytes,
      });
      if (!Array.isArray(normalized.attachments)) {
        normalized.attachments = [];
      }
      normalized.attachments.push({
        kind: "voice",
        type: "voice",
        contentType: voice.mimeType || "audio/ogg",
        isImage: false,
        sourceFileName: "",
        fileName: saved.fileName,
        absolutePath: saved.absolutePath,
        path: saved.absolutePath,
        relativePath: path.relative(mediaDir, saved.absolutePath).replace(/\\/g, "/"),
        sizeBytes: saved.sizeBytes,
        durationSec: voice.durationSec || 0,
      });
    } catch (error) {
      normalized.text = `${normalized.text || VOICE_PLACEHOLDER}（下载失败）`;
      writeMediaLog(log, `voice inbound download failed messageId=${normalized.messageId} error=${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!this.kit || !this.kit.sttEnabled()) {
      // Transcription not configured yet: keep the original marker/caption.
      return;
    }
    const result = await this.kit.transcribe({
      filePath: saved.absolutePath,
      mimeType: voice.mimeType || "audio/ogg",
      language: normalizeText(this.config.voiceSttLanguage),
    });
    if (result.ok) {
      normalized.text = `${normalizeText(normalized.text) || VOICE_PLACEHOLDER}\n[语音转写: ${result.text}]`;
      normalized.voiceTranscription = {
        provider: result.provider,
        model: result.model,
        elapsedMs: result.elapsedMs,
      };
    } else {
      normalized.text = `${normalizeText(normalized.text) || VOICE_PLACEHOLDER}（转写失败）`;
      normalized.voiceTranscription = { error: result.error, provider: result.provider };
    }
  }

  /**
   * Synthesize `text` into an Ogg/Opus file under voiceMediaDir/outbox.
   * Throws on failure so tool handlers surface the error to the model.
   */
  async synthesizeToFile({ text = "" } = {}) {
    if (!this.kit) {
      throw new Error("voice-kit not loaded: set CYBERBOSS_VOICE_KIT_DIR");
    }
    const mediaDir = normalizeText(this.config.voiceMediaDir);
    if (!mediaDir) {
      throw new Error("voice media dir missing: CYBERBOSS_STATE_DIR required");
    }
    const result = await this.kit.synthesize({
      text,
      outputDir: path.join(mediaDir, "outbox"),
    });
    if (!result.ok) {
      throw new Error(`voice synthesis failed: ${result.error}`);
    }
    return { filePath: result.filePath, provider: result.provider };
  }

  /**
   * Record the text of an outbound voice reply into the conversation JSONL so
   * the AI's own memory pipeline can see what it said.
   */
  recordVoiceReply({ text = "", filePath = "", userId = "" } = {}) {
    if (!this.recorder) {
      return;
    }
    try {
      this.recorder.record({
        type: "assistant",
        text: normalizeText(text),
        meta: {
          provider: "telegram",
          form: "voice",
          tool: "cyberboss_telegram_send_voice",
          filePath: normalizeText(filePath),
          userId: normalizeText(userId),
        },
      });
    } catch {}
  }
}

function loadVoiceKit(config) {
  const kitDir = normalizeText(config.voiceKitDir);
  if (!kitDir) {
    return null;
  }
  let createVoiceKit;
  try {
    ({ createVoiceKit } = require(path.join(kitDir, "index.js")));
  } catch {
    return null;
  }
  try {
    return createVoiceKit({
      stt: {
        provider: normalizeText(config.voiceSttProvider),
        apiKey: normalizeText(config.voiceSttApiKey),
        baseUrl: normalizeText(config.voiceSttBaseUrl),
        model: normalizeText(config.voiceSttModel),
        language: normalizeText(config.voiceSttLanguage),
      },
      tts: {
        provider: normalizeText(config.voiceTtsProvider),
        apiKey: normalizeText(config.voiceTtsApiKey),
        baseUrl: normalizeText(config.voiceTtsBaseUrl),
        voiceId: normalizeText(config.voiceTtsVoiceId),
        modelId: normalizeText(config.voiceTtsModelId),
      },
    });
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

module.exports = { VoiceService };
