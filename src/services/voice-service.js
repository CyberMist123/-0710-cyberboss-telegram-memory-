"use strict";

const path = require("path");
const fs = require("fs");

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
    // The most recent inbound voice note, so a retranscribe tool call does not
    // have to be handed a file path. Exposing paths to the model would put
    // them in the prompt and in every conversation log that follows.
    this.lastInbound = null;
    // In-memory alone is not enough: processInboundVoice runs in the main app
    // process, but the retranscribe tool runs in the SEPARATE tool-MCP-server
    // process (index.js runToolMcpServer), which never handles inbound voice —
    // so its this.lastInbound is forever null and every retranscribe returned
    // no_recent_voice. Persist a server-only pointer both processes can read.
    // The path still never reaches the model (only this service reads the file),
    // and only processInboundVoice writes it, so the single-writer rule holds.
    this.lastInboundFile = normalizeText(this.config.stateDir)
      ? path.join(this.config.stateDir, "voice-last-inbound.json")
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
    this.lastInbound = {
      filePath: saved.absolutePath,
      mimeType: voice.mimeType || "audio/ogg",
      at: new Date().toISOString(),
    };
    this.rememberLastInbound(this.lastInbound);
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
      // The engine name is only surfaced to the model when the good engine did
      // NOT serve the request. Naming it every time would put a machine detail
      // into every voice line of the conversation log and the episodes built
      // from it; naming it on degradation is what lets the AI know a
      // retranscribe is worth trying.
      const engine = normalizeText(result.model);
      const degraded = Boolean(engine) && /whisper/i.test(engine);
      const body = degraded ? `语音转写（降级到 ${engine}，可能不准）` : "语音转写";
      normalized.text = `${normalizeText(normalized.text) || VOICE_PLACEHOLDER}\n[${body}: ${result.text}]`;
      // The observer's one-liner (语速/停顿/气声/背景) rides on its own line after
      // the transcript, so the chat AI reads how it was said next to what was
      // said. Empty for a plain transcript; then nothing is appended.
      const voiceNote = normalizeText(result.voiceNote);
      if (voiceNote) {
        normalized.text = `${normalized.text}\n${voiceNote}`;
      }
      normalized.voiceTranscription = {
        provider: result.provider,
        model: engine,
        engine,
        degraded,
        voiceNote,
        elapsedMs: result.elapsedMs,
      };
    } else {
      normalized.text = `${normalizeText(normalized.text) || VOICE_PLACEHOLDER}（转写失败）`;
      normalized.voiceTranscription = { error: result.error, provider: result.provider };
    }
  }

  /**
   * Persist the most-recent-inbound pointer for the other process to read.
   * Single writer (only processInboundVoice calls this) and fail-open: a lost
   * pointer costs one retranscribe, never the message flow. The path lives only
   * in this file and this service, never in the model's prompt.
   */
  rememberLastInbound(entry) {
    if (!this.lastInboundFile || !entry) return;
    try {
      fs.mkdirSync(path.dirname(this.lastInboundFile), { recursive: true });
      fs.writeFileSync(this.lastInboundFile, JSON.stringify(entry), "utf8");
    } catch {}
  }

  /** Read the persisted pointer; null when absent or unreadable. */
  readLastInbound() {
    if (!this.lastInboundFile) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lastInboundFile, "utf8"));
      return parsed && normalizeText(parsed.filePath) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Transcribe a voice note again, by default the most recent inbound one and
   * by default with the paid cloud engine.
   *
   * This exists because the resident 1.7B model garbles clause endings often
   * enough that a transcript can read fluent and still say the wrong thing.
   * Only the AI reading the conversation can notice that, so the retry is a
   * tool it calls, not something this service decides on its own.
   *
   * Throws on failure so the tool handler surfaces the reason to the model.
   */
  async retranscribe({ filePath = "", engine = "cloud" } = {}) {
    if (!this.kit || !this.kit.sttEnabled()) {
      throw new Error("stt_not_configured: retranscribe needs the CMX voice provider");
    }
    // this.lastInbound is null in the tool-server process; the persisted pointer
    // is the cross-process fallback that makes retranscribe actually reachable.
    const recent = this.lastInbound || this.readLastInbound();
    const target = normalizeText(filePath) || normalizeText(recent?.filePath);
    if (!target) {
      throw new Error("no_recent_voice: nothing has been transcribed in this session yet");
    }
    const result = await this.kit.transcribe({
      filePath: target,
      mimeType: normalizeText(recent?.mimeType) || "audio/ogg",
      language: normalizeText(this.config.voiceSttLanguage),
      engine: normalizeText(engine) || "cloud",
    });
    if (!result.ok) {
      throw new Error(`retranscribe failed: ${result.error}`);
    }
    return {
      text: result.text,
      engine: normalizeText(result.model),
      detectedLanguage: normalizeText(result.detectedLanguage),
      emotion: normalizeText(result.emotion),
      // The observer's closed-vocabulary one-liner, when CMX ran it.
      voiceNote: normalizeText(result.voiceNote),
      // Present only when the cloud engine was asked for and could not run;
      // the text above then came from the local chain after all.
      cloudError: normalizeText(result.cloudError),
      elapsedMs: result.elapsedMs,
    };
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
