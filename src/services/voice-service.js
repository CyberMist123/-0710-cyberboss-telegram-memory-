"use strict";

const path = require("path");

const { ConversationRecorder } = require("./conversation-recorder");
const { LocalWhisperTranscriber } = require("./local-whisper-transcriber");

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
    this.localWhisper = new LocalWhisperTranscriber(this.config);
    this.recorder = this.config.conversationDir
      ? new ConversationRecorder({
        dirPath: this.config.conversationDir,
        automationTimezone: this.config.automationTimezone,
      })
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
  async processInboundVoice({ normalized }) {
    const voice = normalized?.telegram?.voice;
    const saved = Array.isArray(normalized?.attachments)
      ? normalized.attachments.find((item) => item.kind === "voice")
      : null;
    if (!voice || !saved?.absolutePath) {
      return;
    }
    if (normalized.voiceTranscription) {
      return;
    }

    if ((!this.kit || !this.kit.sttEnabled()) && !this.localWhisper.enabled) {
      // Transcription not configured yet: keep the original marker/caption.
      return;
    }
    let result;
    try {
      result = this.kit?.sttEnabled()
        ? await this.kit.transcribe({ filePath: saved.absolutePath, mimeType: voice.mimeType || "audio/ogg", language: normalizeText(this.config.voiceSttLanguage) })
        : await this.localWhisper.transcribe({ filePath: saved.absolutePath, language: normalizeText(this.config.voiceSttLanguage) });
    } catch (error) {
      normalized.voiceTranscription = { error: error?.message || String(error), provider: this.kit?.sttEnabled() ? "voice-kit" : "local-whisper" };
      return;
    }
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

module.exports = { VoiceService };
