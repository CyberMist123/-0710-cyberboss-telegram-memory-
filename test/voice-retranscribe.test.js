"use strict";

// The retranscribe tool runs in the tool-MCP-server process, which never
// handles inbound voice, so its in-memory lastInbound is always null. These
// tests pin that the persisted pointer lets a SECOND VoiceService instance
// (standing in for that separate process) still find the most recent voice —
// the bug being that it used to always throw no_recent_voice.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { VoiceService } = require("../src/services/voice-service");

function stubKit(record) {
  return {
    describe: () => ({ id: "stub" }),
    sttEnabled: () => true,
    ttsEnabled: () => false,
    transcribe: async (opts) => {
      record.push(opts);
      return {
        ok: true,
        text: "云端结果",
        model: "qwen3-asr-flash",
        provider: "voice-kit",
        voiceNote: "[声音: 语速中等 · 背景安静]",
        elapsedMs: 1,
      };
    },
  };
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cbx-voice-"));
}

test("retranscribe reaches the last inbound voice across a separate process", async () => {
  const stateDir = tmpStateDir();
  const audioPath = path.join(stateDir, "voice-123.ogg");
  fs.writeFileSync(audioPath, "audio-bytes");

  // Process A — the main app: handle an inbound voice, which persists the pointer.
  const inbound = new VoiceService({ config: { stateDir } });
  inbound.kit = stubKit([]);
  const normalized = {
    text: "",
    telegram: { voice: { mimeType: "audio/ogg" } },
    attachments: [{ kind: "voice", absolutePath: audioPath }],
  };
  await inbound.processInboundVoice({ normalized });
  assert.ok(fs.existsSync(path.join(stateDir, "voice-last-inbound.json")), "pointer file was written");

  // Process B — the tool-MCP-server: a fresh instance whose in-memory pointer
  // is null. Before the fix this threw no_recent_voice.
  const toolServer = new VoiceService({ config: { stateDir } });
  assert.strictEqual(toolServer.lastInbound, null, "the tool-server process has no in-memory pointer");
  const calls = [];
  toolServer.kit = stubKit(calls);
  const result = await toolServer.retranscribe({ engine: "cloud" });

  assert.strictEqual(result.text, "云端结果");
  assert.strictEqual(calls[0].filePath, audioPath, "retranscribe used the persisted audio path");
  assert.strictEqual(calls[0].engine, "cloud", "the cloud engine was requested");
  assert.strictEqual(result.voiceNote, "[声音: 语速中等 · 背景安静]", "the observer note is surfaced");
});

test("processInboundVoice appends the observer note on its own line after the transcript", async () => {
  const stateDir = tmpStateDir();
  const audioPath = path.join(stateDir, "voice-note.ogg");
  fs.writeFileSync(audioPath, "audio-bytes");
  const svc = new VoiceService({ config: { stateDir } });
  svc.kit = stubKit([]);
  const normalized = {
    text: "",
    telegram: { voice: { mimeType: "audio/ogg" } },
    attachments: [{ kind: "voice", absolutePath: audioPath }],
  };
  await svc.processInboundVoice({ normalized });
  // Words first, then how it was said — each on its own line.
  assert.ok(normalized.text.includes("[语音转写: 云端结果]"), "transcript line present");
  assert.ok(normalized.text.includes("\n[声音: 语速中等 · 背景安静]"), "observer note on its own line");
  assert.strictEqual(normalized.voiceTranscription.voiceNote, "[声音: 语速中等 · 背景安静]");
});

test("retranscribe still reports no_recent_voice when nothing was ever processed", async () => {
  const svc = new VoiceService({ config: { stateDir: tmpStateDir() } });
  svc.kit = stubKit([]);
  await assert.rejects(() => svc.retranscribe({}), /no_recent_voice/);
});

test("an explicit path is respected without a persisted pointer", async () => {
  const svc = new VoiceService({ config: { stateDir: tmpStateDir() } });
  const calls = [];
  svc.kit = stubKit(calls);
  const explicitPath = path.join(tmpStateDir(), "explicit.ogg");
  const result = await svc.retranscribe({ filePath: explicitPath, engine: "local" });
  assert.strictEqual(result.text, "云端结果");
  assert.strictEqual(calls[0].filePath, explicitPath);
  assert.strictEqual(calls[0].engine, "local");
});
