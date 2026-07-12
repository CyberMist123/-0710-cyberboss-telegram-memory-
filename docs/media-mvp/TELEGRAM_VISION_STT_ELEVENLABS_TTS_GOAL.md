# Telegram Vision + STT + ElevenLabs TTS — Goal and Execution Contract

> Prepared by: ChatGPT  
> Date: 2026-07-13  
> Status: branch-only execution contract  
> Target branch: `test/media-mvp-20260713`  
> Authority: this file governs only the media MVP on this test branch. It does not replace the repository's four authoritative architecture documents.

## 0. One-sentence goal

Give Luna on Telegram three bounded capabilities without disturbing the existing text, memory, thread, streaming, watchdog, or single-poller paths:

1. receive an image and answer from the image plus its caption;
2. receive a Chinese voice message, transcribe it locally, and answer naturally;
3. convert one selected Luna text reply to an ElevenLabs Telegram voice message.

This is **multimodal input plus manually triggered voice output**, not a general media platform.

## 1. User-visible contract

### 1.1 Ordinary text

Ordinary Telegram text must behave exactly as before. The existing XML channel envelope remains:

```xml
<channel source="telegram" chat_id="..." message_id="..." user_id="..." sent_at="...">
message body
</channel>
```

No regression in streaming, reply routing, `/new`, `/switch`, duplicate filtering, offset persistence, or model selection is allowed.

### 1.2 Voice input

Flow:

```text
Telegram voice/audio
→ Telegram file download
→ local OGG/Opus to 16 kHz mono WAV
→ local SenseVoice transcription
→ normal Luna turn
→ normal text reply
```

The message body sent to Luna is:

```text
[语音转写]
转写后的文本
```

Do not write `用户`, `用户说`, `以下是用户语音`, or similar prose. Do not expose model paths, provider names, confidence metadata, or temporary file names in the conversational body.

Internal metadata may record:

```js
{
  sourceType: "voice",
  transcriptionProvider: "sherpa-onnx-sensevoice",
  durationSeconds: 0,
  sourceAttachmentPath: "..."
}
```

If transcription is empty or fails, send one short Telegram error and do not create an empty Luna turn.

### 1.3 Image input

Flow:

```text
Telegram photo
→ largest Telegram photo variant
→ saved attachment using the existing inbox schema
→ existing `resolveVisionContext`
→ Luna receives original caption plus visual context
→ normal text reply
```

Rules:

- Preserve the user's image caption verbatim.
- Do not display a separate OCR/caption report to the user before Luna replies.
- Do not prefix the caption with `用户图片`, `用户说`, or similar wording.
- If there is no caption, Luna should still receive the visual context and answer naturally.
- Reuse the existing vision route; do not build a second vision service.
- If vision fails but a caption exists, the caption still reaches Luna.

### 1.4 Voice output

The source text is Luna's already generated Telegram reply. Do not call another model to rewrite, summarize, or “optimize” it.

Primary MVP triggers:

1. Reply to a Luna text message with `/say` to synthesize that replied message.
2. `/voice once` arms the next Luna reply: send the normal text reply first, then send the same reply as voice once, and automatically disarm.

Optional debug compatibility:

```text
/say <text>
```

This may synthesize supplied text, but it is not the primary product path.

Default behavior remains text-only. Do not implement persistent `/voice on` in the MVP.

### 1.5 Deterministic TTS sanitation

Luna replies are normally ordinary text. Apply only a small deterministic script before ElevenLabs:

- normalize repeated whitespace;
- remove Markdown emphasis markers while preserving words;
- convert `[label](url)` to `label`;
- remove bare long URLs;
- remove code fences and skip code-heavy replies;
- remove list bullets without rewriting list text;
- preserve wording, punctuation, order, and tone;
- never call an LLM for sanitation.

If the cleaned text is empty, code-heavy, or exceeds the configured maximum, keep the text reply and send a short TTS error only.

## 2. Non-goals

Do not implement any of the following:

- automatic voice for every reply;
- real-time streaming STT or TTS;
- wake words;
- speaker diarization;
- voice cloning UI;
- multiple voice profiles;
- STT API fallback;
- a Python sidecar;
- a new HTTP service;
- 520 controls;
- WeChat media changes;
- web UI media upload;
- video understanding;
- PDF/document ingestion;
- permanent transcript database;
- media search or embedding;
- memory, Re-entry, Self-note, Episode, Desire, or Soft Retrieval changes;
- a new poller, watchdog, scheduled task, startup script, port, or daemon.

## 3. Repository boundaries

### Channel protocol code

Use:

```text
src/adapters/channel/telegram.js
src/adapters/channel/telegram/media-receive.js
src/adapters/channel/telegram/media-send.js
```

Responsibilities:

- parse Telegram updates;
- describe `photo`, `voice`, and optionally `audio` as structured attachments;
- call `getFile`, download bytes, enforce limits, and persist safely;
- send Telegram voice multipart payloads.

Telegram protocol details must not be implemented inside `src/core/app.js`.

### Reusable provider code

Use:

```text
src/services/speech-to-text-service.js
src/services/elevenlabs-tts-service.js
src/services/tts-text-sanitizer.js
```

These services must not know Telegram chat IDs, message IDs, or Bot Tokens.

### Core orchestration

`src/core/app.js` may only receive narrow wiring changes:

- select the attachment persister by provider;
- call STT for a prepared voice attachment;
- let Telegram image attachments use the existing vision path;
- dispatch `/say` and `/voice once`;
- attach one-shot TTS delivery to the existing completed-turn delivery lifecycle.

Do not place FFmpeg arguments, SenseVoice configuration, ElevenLabs HTTP details, or Telegram multipart implementation in `app.js`. Do not refactor unrelated legacy code.

### Text assembly

Use `src/core/inbound-turn.js` for media-body assembly. Do not create a second context builder.

## 4. Storage contract

Persist incoming Telegram media using the existing attachment schema under:

```text
<CYBERBOSS_STATE_DIR>/inbox/YYYY-MM-DD/
```

Expected attachment shape:

```js
{
  kind: "image" | "voice" | "audio",
  contentType: "...",
  isImage: true | false,
  sourceFileName: "...",
  fileName: "...",
  absolutePath: "...",
  relativePath: "inbox/YYYY-MM-DD/...",
  sizeBytes: 0
}
```

Temporary WAV files belong under:

```text
<CYBERBOSS_STATE_DIR>/cache/media/stt/
```

Delete temporary WAV files in `finally` blocks. Do not create a second transcript store. Do not write media into the Git worktree.

## 5. Fixed technology choices for the MVP

### STT

- package: `sherpa-onnx-node`;
- model: SenseVoice Small INT8 multilingual model;
- sample rate: 16000 Hz;
- channels: mono;
- threads: 2 by default;
- provider: CPU;
- recognizer: lazy-loaded and reused;
- model files: external/local, never committed.

Required first action: run a Node 22 Windows compatibility probe in a temporary directory before adding the dependency to this repository. A failed native addon probe is a blocker for STT only, not for image or TTS work.

### Audio normalization

- package: `ffmpeg-static`;
- invoke with `spawn` or `execFile` and an argument array;
- never interpolate file paths into a shell command;
- no system-wide FFmpeg installation requirement.

### Vision

Reuse `src/services/vision-context.js` and current `CYBERBOSS_VISION_*` configuration. Do not choose a new model in code. The actual provider/model stays configuration-driven.

### TTS

- official SDK: `@elevenlabs/elevenlabs-js`;
- default model: `eleven_flash_v2_5`;
- default output target: Telegram-compatible Opus where supported;
- otherwise request supported audio bytes and perform a minimal remux only if Telegram rejects the direct result;
- SDK load is lazy;
- normal application startup must not require an ElevenLabs key.

## 6. Configuration contract

All environment access is centralized in `src/core/config.js`. Provider modules receive config values through constructors/factories and do not read `process.env` independently.

Add only necessary fields:

```text
CYBERBOSS_STT_ENABLED
CYBERBOSS_STT_PROVIDER
CYBERBOSS_STT_MODEL_DIR
CYBERBOSS_STT_MODEL_FILE
CYBERBOSS_STT_TOKENS_FILE
CYBERBOSS_STT_THREADS
CYBERBOSS_STT_TIMEOUT_MS

CYBERBOSS_ELEVENLABS_API_KEY
CYBERBOSS_ELEVENLABS_VOICE_ID
CYBERBOSS_ELEVENLABS_MODEL
CYBERBOSS_ELEVENLABS_OUTPUT_FORMAT
CYBERBOSS_TTS_MAX_CHARS
CYBERBOSS_TTS_TIMEOUT_MS
```

Optional media limits may be added only if enforced:

```text
CYBERBOSS_TELEGRAM_IMAGE_MAX_BYTES
CYBERBOSS_TELEGRAM_AUDIO_MAX_BYTES
CYBERBOSS_TELEGRAM_MEDIA_TIMEOUT_MS
```

Do not make these optional media settings startup-preflight requirements. Missing media configuration disables only the corresponding capability.

## 7. Execution sequence and gates

Codex must execute in order. A failed gate blocks only dependent stages.

### Stage 0 — Read-only baseline

Do not modify files.

Record:

```text
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
node --version
npm --version
```

Read:

```text
README.md
docs/CONTINUITY_ARCHITECTURE.md
docs/IMPLEMENTATION_STATUS.md
docs/IMPLEMENTATION_HANDOFF.md
docs/media-mvp/TELEGRAM_VISION_STT_ELEVENLABS_TTS_REFERENCE_AUDIT.md
src/adapters/channel/telegram.js
src/core/app.js
src/core/inbound-turn.js
src/services/vision-context.js
src/core/config.js
src/core/command-registry.js
package.json
```

Gate: identify the exact minimal functions to change and confirm no live/runtime directory is being edited.

### Stage 1 — Dependency probes outside the repository

In an OS temporary directory:

1. initialize a disposable npm package;
2. install and load `sherpa-onnx-node` under the installed Node 22 build;
3. install and resolve `ffmpeg-static` and verify the binary exists;
4. install and dynamically import `@elevenlabs/elevenlabs-js` from CommonJS.

Do not modify system Node, compile C++, or download unofficial binaries.

Gate output:

```text
sherpa addon: PASS | BLOCKED + exact error
ffmpeg-static: PASS | BLOCKED + exact error
elevenlabs sdk import: PASS | BLOCKED + exact error
```

### Stage 2 — Telegram media intake

Implement structured `photo`, `voice`, and optional `audio` normalization plus safe download/persistence.

Tests first or alongside implementation:

- largest photo variant selected;
- original caption preserved;
- voice metadata preserved;
- duplicate and offset state unchanged;
- file path cannot escape inbox;
- Bot Token never appears in returned errors or logs;
- download timeout, HTTP error, and size limit are isolated.

Gate:

```text
npm run check
node --test test/telegram-media.test.js
npm run test:phase1
```

Commit:

```text
feat(telegram): persist inbound photo and voice attachments
```

### Stage 3 — Telegram image to existing Vision

Remove the Telegram-only bypass that prevents image attachments from reaching `resolveVisionContext`, while preserving ordinary Telegram text byte-for-byte.

Required tests:

- ordinary Telegram text envelope exact regression fixture;
- Telegram image invokes `resolveVisionContext` once;
- caption plus visual context both appear;
- image-only message creates a turn;
- vision failure plus caption still creates a caption turn;
- WeChat image behavior unchanged.

Gate:

```text
npm run check
node --test test/telegram-media-integration.test.js
npm run test:phase1
npm run test:phase2
```

Commit:

```text
feat(telegram): route inbound photos through existing vision context
```

### Stage 4 — Local STT

Implement FFmpeg normalization, SenseVoice lazy initialization, result cleanup, and Telegram voice-to-text preparation.

Required tests use injected fakes; they do not load the real model:

- FFmpeg called with argument array, not shell text;
- recognizer initialized once and reused;
- cleaned transcript becomes `[语音转写]\n...`;
- no `用户` marker appears;
- empty transcript creates no Luna turn;
- timeout, model missing, native addon error, and FFmpeg error remain local;
- temporary WAV deleted on success and failure;
- normal text remains available after an STT error.

Gate:

```text
npm run check
node --test test/speech-to-text-service.test.js test/telegram-voice-integration.test.js
npm run test:phase1
npm run test:orchestration
```

Optional real local model smoke, only when official model files exist:

```text
10–30 second Mandarin voice
30–120 second Mandarin voice
Chinese-English mixed voice
```

Record transcription text and duration, but never commit the user's audio or transcript.

Commit:

```text
feat(media): add local SenseVoice transcription for Telegram
```

### Stage 5 — ElevenLabs voice output

Implement:

- deterministic text sanitizer;
- ElevenLabs lazy client;
- `sendVoice` in Telegram adapter media-send module;
- reply-to-message `/say`;
- one-shot `/voice once` state;
- text reply is always delivered before optional voice;
- one-shot state clears after success or failure.

Do not change the content through another model.

Required tests:

- Markdown sanitation preserves words and order;
- code-heavy reply is rejected for TTS without hiding text;
- ElevenLabs request uses configured voice/model/output;
- key is never logged;
- HTTP 401, 429, timeout, and malformed audio are isolated;
- `sendVoice` uses Telegram multipart `voice`, not `document`;
- reply `/say` reads `reply_to_message.text`;
- `/voice once` applies once and automatically clears;
- TTS failure does not block the next normal message.

Gate:

```text
npm run check
node --test test/tts-text-sanitizer.test.js test/elevenlabs-tts-service.test.js test/telegram-voice-output.test.js
npm run test:phase1
npm run test:orchestration
```

Real API smoke is allowed only when the key and voice ID are already available locally. Never print them.

Commit:

```text
feat(tts): add one-shot ElevenLabs voice replies on Telegram
```

### Stage 6 — Full offline gate

Run:

```text
npm run check
npm run test:phase1
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run test:phase5a
npm run test:orchestration
npm run test:media-mvp
```

Add `test:media-mvp` to `package.json` as the single media regression entry point.

Gate conditions:

- all applicable existing gates pass;
- no test reads real `.env`, state-dir, continuity, memory, or live logs;
- no test starts a real poller;
- no test contacts Telegram, Vision, ElevenLabs, or model download hosts;
- portability check passes;
- `git status --short` contains only intended changes.

### Stage 7 — Controlled Telegram smoke

Do not start a second poller using the live Bot Token.

Preferred order:

1. use an alternate test Bot Token and isolated temporary state-dir;
2. otherwise stop and report `REAL_TELEGRAM_SMOKE_BLOCKED_NO_TEST_TOKEN`;
3. do not reuse the live token unless the user explicitly authorizes a controlled single-poller cutover.

Smoke matrix:

```text
ordinary text → normal Luna text reply
screenshot with caption → relevant image-aware reply
photo without caption → natural image-aware reply
voice → transcript reaches Luna and Luna replies
reply to Luna message with /say → Telegram voice returned
/voice once → next reply produces text then one voice, following reply text-only
invalid ElevenLabs key → error isolated, next text still works
STT disabled → concise voice error, text still works
```

## 8. Stop conditions

Stop the affected stage and report evidence if any of these occurs:

- a second Telegram poller or watchdog is created;
- a live directory, release descriptor, scheduled task, or startup action is modified;
- ordinary Telegram text envelope changes unexpectedly;
- memory, continuity, Desire, or 520 files enter the diff;
- a provider failure crashes the main loop;
- a key/token/path is printed or committed;
- an external source is copied despite the license rules in the reference audit;
- a test is made green by skipping or weakening an existing assertion;
- a broad `src/core/app.js` refactor appears;
- a native dependency requires changing the machine's global Node installation.

## 9. Commit and report discipline

One concern per commit. No force push, reset-hard, clean, merge, live deployment, or main-branch changes.

Final report must contain only:

```text
worktree
branch
base SHA
HEAD SHA
commits
changed files by stage
new dependencies and exact versions
probe results
test commands and pass/fail counts
real smoke status
known blockers
rollback per commit
git status --short
push status
```

Required writer declaration:

```text
Canon writer change: none
Memory writer change: none
Desire writer change: none
Operational writes added: state-dir inbox media and temporary STT cache only
```

## 10. Codex low-token operating instruction

Codex must not browse GitHub or redesign the feature. Read the two media MVP documents, inspect only the named local files, and implement the stages in order.

Use one agent. Keep progress reports to stage result, changed files, tests, blocker, and next stage. Do not restate the documents. Do not create extra planning documents. Do not modify authoritative architecture documents. Update `docs/IMPLEMENTATION_STATUS.md` only after the full offline gate, with factual branch-only status and actual smoke results.
