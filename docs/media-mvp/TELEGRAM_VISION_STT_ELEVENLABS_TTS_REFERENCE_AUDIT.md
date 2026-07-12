# Telegram Vision + STT + ElevenLabs TTS — Reference Audit and Porting Map

> Prepared by: ChatGPT  
> Date: 2026-07-13  
> Purpose: eliminate repeated GitHub research during implementation  
> Rule: Codex reads this file and the local repository. Codex does not browse for alternative designs unless a named dependency is unavailable.

## 1. Decision summary

There are mature Telegram multimodal bots, so this MVP is not greenfield. No single project can be copied wholesale into Cyberboss because the mature examples are mainly Python or Go and use different runtimes, message histories, and model APIs.

Use the references as follows:

| Source | Role | Copy policy |
|---|---|---|
| current Cyberboss branch | architecture and integration target | authoritative implementation base |
| `aldorado/visor` | voice-module separation, ElevenLabs client/test pattern | MIT; small adapted portions allowed with notice when substantial |
| `n3d1117/chatgpt-telegram-bot` | proven Telegram voice/image/TTS behavior | GPL-2.0; behavior reference only, no verbatim code |
| `yym68686/ChatGPT-Telegram-Bot` | mature multimodal feature checklist | GPL-3.0; behavior reference only for this task |
| `Mrklypto/Lunaselenebot` | direct model-reply-to-ElevenLabs flow | no license found; behavior reference only, no code copying |
| `k2-fsa/sherpa-onnx` | official Node SenseVoice API | Apache-2.0; API usage may be adapted with attribution if substantial |
| `elevenlabs/elevenlabs-js` | official Node TTS SDK and output formats | MIT; use as dependency, do not reimplement generated SDK |
| `eugeneware/ffmpeg-static` | Windows FFmpeg binary resolution | GPL-3.0 repository/package; use as dependency only and retain package licensing |

No external source bundle is committed to this repository. That is intentional: bundling GPL and unlicensed example code would add license and maintenance baggage while providing less value than pinned file/function references.

## 2. Current Cyberboss audit: exact gaps

### 2.1 Telegram update normalization

File:

```text
src/adapters/channel/telegram.js
```

Current behavior:

- `normalizeIncomingMessage(update)` accepts private non-bot messages and performs dedupe.
- text falls back to `getNonTextDescription(message)`.
- `photo` becomes `[图片]`.
- `voice` becomes `[语音]`.
- `audio` becomes `[音频]`.
- returned `attachments` is always `[]`.
- caption is not used as message text.
- `reply_to_message` content is not preserved.

Required minimal change:

- use `message.text || message.caption` as original text;
- build normalized Telegram attachment descriptors;
- choose the last/largest `message.photo` entry;
- preserve `file_id`, `file_unique_id`, size, duration, MIME, and filename where available;
- preserve reply metadata for `/say`:

```js
telegram: {
  // existing fields
  replyTo: {
    messageId: "",
    fromBot: false,
    text: "",
    caption: ""
  }
}
```

Do not move dedupe or offset advancement. Do not change the first `getUpdates`/`deleteWebhook` behavior.

### 2.2 Attachment persistence is WeChat-specific

File/function:

```text
src/core/app.js
prepareIncomingMessageForRuntime()
```

Current behavior:

- if attachments exist, it always calls `persistIncomingWeixinAttachments`;
- Telegram has no persistence route.

Required minimal change:

```js
const persisted = normalized.provider === "telegram"
  ? await persistIncomingTelegramAttachments(...)
  : await persistIncomingWeixinAttachments(...);
```

Do not build a general plugin framework. Two explicit provider branches are sufficient.

### 2.3 Telegram bypasses Vision

File/function:

```text
src/core/app.js
buildRuntimeTurn()
```

Current behavior:

- provider `system` returns plain text;
- provider `telegram` immediately returns `formatTelegramRuntimeText(prepared)` and `attachments: []`;
- only non-Telegram messages call `resolveVisionContext` and `assembleRuntimeTurnText`.

Required minimal change:

- ordinary Telegram text must keep the exact existing path;
- Telegram with image attachments must call `resolveVisionContext`;
- assemble caption plus visual context, then put the result inside the existing Telegram XML envelope;
- native runtime attachments may be passed only when the runtime/model capability already permits it;
- voice messages become text before `buildRuntimeTurn`, so they continue through the ordinary Telegram text path.

### 2.4 Telegram XML envelope is part of the protocol

File/function:

```text
src/core/app.js
formatTelegramRuntimeText()
```

Keep:

```xml
<channel source="telegram" chat_id="..." message_id="..." user_id="..." username="..." sent_at="...">
...
</channel>
```

Do not remove or rename fields. Add media content only to the body.

### 2.5 Existing Vision implementation is already sufficient

File:

```text
src/services/vision-context.js
```

Existing capabilities:

- filters image attachments;
- chooses native input, tool read, or caption provider;
- supports OpenAI-compatible `chat/completions` image input;
- returns `items`, `errors`, and `runtimeAttachments`;
- fails per attachment instead of crashing the entire turn.

Do not create `telegram-vision-service.js`. Only improve prompt behavior if a failing test proves the current generic prompt cannot answer a user caption. Prefer passing the user's caption as the question to the existing caption request; use the current generic prompt only when caption is empty.

### 2.6 Existing attachment schema and inbox layout must be reused

Reference implementation:

```text
src/adapters/channel/weixin/media-receive.js
```

Reuse the shape and behavior, not WeChat encryption logic:

- daily inbox directory;
- deterministic safe filename plus collision avoidance;
- `absolutePath`, `relativePath`, `sizeBytes`;
- `saved` and `failed` arrays;
- per-attachment failure isolation;
- optional image compression through existing `sharp` conventions.

Telegram-specific code should implement only Telegram URL retrieval/download and map into the same returned shape.

### 2.7 Correct TTS lifecycle hook

File:

```text
src/core/stream-delivery.js
```

Current behavior:

- accumulates streaming reply items;
- sends completed text through `sendReplyDelivery`;
- on `runtime.turn.completed`, forces final flush and disposes run state;
- may send multiple completed items before turn completion.

Do not synthesize in `runtime.reply.completed`; that can produce multiple voice messages.

Recommended narrow change:

1. add optional constructor callback `onTurnTextDelivered`;
2. add `deliveredTextParts: []` to run state;
3. after a successful `sendTextWithRetry`, append the actual transformed user-visible text, excluding deferred system prefixes;
4. at `runtime.turn.completed`, after the force flush and before state disposal, invoke the callback once with:

```js
{
  threadId,
  turnId,
  target: state.replyTarget,
  text: state.deliveredTextParts.join("\n\n").trim()
}
```

5. invoke only when text delivery succeeded and target provider is Telegram;
6. callback failure must be caught and logged without changing text-delivery success.

This gives `/voice once` the exact text Luna already sent, after existing reply transformations, without a second model and without duplicate TTS per stream chunk.

### 2.8 Command integration

Files:

```text
src/core/app.js
src/core/command-registry.js
```

Add only:

```text
/say
/voice once
```

`/say` behavior:

- if replying to a bot text message, use `telegram.replyTo.text || telegram.replyTo.caption`;
- otherwise use command arguments;
- if neither exists, return usage;
- sanitize deterministically and synthesize;
- this command does not create a Luna turn.

`/voice once` behavior:

- store a one-shot flag for the current binding/thread target;
- no persistent config file is needed for the MVP;
- clear after one completed reply, whether TTS succeeds or fails;
- clear on `/new` only if the state key is thread-specific; binding-specific state may remain until consumed, but choose one design and test it explicitly.

Preferred state location: a tiny in-memory map owned by `CyberbossApp`, keyed by binding key. Do not add another state file unless restart persistence is explicitly requested later.

## 3. External reference A — `aldorado/visor`

Pinned commit:

```text
467ec7dff9da3863c3a2c844f493b0132fe0803c
```

License:

```text
MIT
```

Relevant files:

```text
internal/voice/handler.go
internal/voice/elevenlabs.go
internal/voice/elevenlabs_test.go
```

### What is useful

`handler.go` proves a compact boundary:

```text
Telegram client
+ STT client
+ TTS client
→ Transcribe(fileID)
→ SynthesizeAndSend(chatID, text)
```

It keeps Telegram download/send orchestration separate from provider clients.

`elevenlabs.go` demonstrates:

- client owns key, voice ID, and injectable HTTP client;
- TTS returns bytes rather than a permanent file;
- non-2xx response becomes an explicit error;
- response body is read only after status validation.

`elevenlabs_test.go` demonstrates the right test shape:

- local fake HTTP server;
- assert method, headers, and non-empty body;
- fake audio bytes returned;
- explicit 429/error test;
- no real ElevenLabs call.

### What to adapt

- provider client returns `Buffer`;
- injectable request function/client for offline tests;
- explicit status/body errors with secret redaction;
- TTS service has no Telegram concepts;
- send service has no ElevenLabs concepts.

### What not to copy

- Go syntax or file layout;
- bare `http.Get` without timeout;
- hard-coded `eleven_multilingual_v2`;
- hard-coded MP3 assumption;
- direct voice send before the normal text reply;
- logging raw chat IDs if current repository logging policy does not need them.

## 4. External reference B — `n3d1117/chatgpt-telegram-bot`

Pinned commit:

```text
df4dcaa26923dee560ef8f9b4f18a682c9b059ad
```

License:

```text
GPL-2.0
```

Relevant file:

```text
bot/telegram_bot.py
```

Relevant methods:

```text
transcribe()
vision()
tts()
```

### Proven behavior to reproduce independently

`transcribe()`:

- uses Telegram `get_file` and downloads the effective attachment;
- converts Telegram audio before transcription;
- sends transcript to the same chat model path when configured to answer;
- tracks errors separately for download, format conversion, and provider;
- removes intermediate files in `finally`.

`vision()`:

- selects the highest-resolution photo variant;
- downloads to memory;
- uses the Telegram caption as image prompt when present;
- produces one normal model answer.

`tts()`:

- converts supplied text;
- sends through Telegram `reply_voice`;
- isolates provider errors.

### Do not copy

- no verbatim Python code;
- no GPL-2.0 source files or translated line-for-line ports;
- no pydub dependency;
- no OpenAI Whisper requirement;
- no transcript/answer labels in the user-visible response;
- no global current-directory temporary files.

This source is a behavioral acceptance reference only.

## 5. External reference C — `yym68686/ChatGPT-Telegram-Bot`

License:

```text
GPL-3.0
```

Repository capability evidence:

- voice and audio question answering;
- image question answering;
- document upload;
- multiple OpenAI-compatible models;
- streaming and long-message handling.

Use only as a completeness checklist:

- media type routing;
- caption preservation;
- long text splitting;
- model capability checks;
- provider failure isolation.

Do not import its architecture. Cyberboss already owns runtime sessions, model switching, streaming, memory, and Telegram offset state.

## 6. External reference D — `Mrklypto/Lunaselenebot`

Pinned commit:

```text
13bdad4b3d8b0f094fe5b05af33189b0eb0bd26a
```

License:

```text
No license file found. Treat as all-rights-reserved for copying purposes.
```

Useful behavior only:

```text
normal model text reply
→ deterministic string cleanup
→ ElevenLabs conversion
→ Telegram sendVoice
```

Do not copy its code. In particular, do not copy:

- raw incoming update logging;
- hard-coded webhook URL;
- outdated voice model/output settings;
- arbitrary 300-character truncation;
- synchronous network calls;
- personality prompt or product logic.

The only retained idea is that the already generated model reply is the TTS source.

## 7. Official STT source — `k2-fsa/sherpa-onnx`

Pinned commit:

```text
40b75e98a0cd5b3f961e73ae158305b3447b5ebb
```

License:

```text
Apache-2.0
```

Relevant files:

```text
nodejs-addon-examples/README.md
nodejs-addon-examples/test_asr_non_streaming_sense_voice.js
```

Official Node requirements and behavior:

- Node >= 16;
- `sherpa-onnx-node` native addon;
- multi-thread support;
- SenseVoice non-streaming file recognition;
- 16 kHz feature config;
- `OfflineRecognizer`;
- `readWave`;
- `createStream`, `acceptWaveform`, `decode`, `getResult`;
- CPU provider and configurable thread count.

Minimal API mapping:

```js
const sherpa = require("sherpa-onnx-node");
const recognizer = new sherpa.OfflineRecognizer(config);
const wave = sherpa.readWave(wavPath);
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
```

Implementation requirements beyond the example:

- load addon lazily inside a guarded function;
- validate model and tokens paths before recognizer creation;
- set debug off by default;
- reuse recognizer;
- normalize varying result shapes to one text string;
- strip SenseVoice control tags only when they are metadata tags, not normal text;
- enforce timeout at orchestration level because synchronous native decoding may not honor AbortSignal;
- do not claim cancellation if decoding cannot actually be interrupted;
- use a worker thread only if real smoke proves decoding blocks the Telegram poll loop noticeably. Do not add worker complexity preemptively.

Model files stay external. Record the model version in local config/evidence, not Git.

## 8. Official TTS source — `elevenlabs/elevenlabs-js`

Pinned SDK source commit used for audit:

```text
314ed067477f1266c232c5fcab52c5c87dd45abc
```

License:

```text
MIT
```

Package:

```text
@elevenlabs/elevenlabs-js
```

Relevant files:

```text
README.md
src/api/resources/textToSpeech/client/Client.ts
src/api/resources/textToSpeech/types/TextToSpeechConvertRequestOutputFormat.ts
```

Official Node usage pattern:

```js
const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
const client = new ElevenLabsClient({ apiKey });
const audio = await client.textToSpeech.convert(voiceId, {
  text,
  modelId: "eleven_flash_v2_5",
  outputFormat: "opus_48000_64"
});
```

The official output enum includes `opus_48000_64` and other Opus bitrates. Use config rather than hard-coding the format inside request logic.

Implementation notes:

- current project is CommonJS, so verify dynamic import in Stage 1;
- SDK has retry behavior; do not wrap it in an unbounded second retry loop;
- set an explicit maximum retry count and request timeout if SDK options permit;
- consume the returned stream/iterable into one `Buffer` using a helper tested with fake chunks;
- do not use SDK `play()`; that needs local playback dependencies and is unrelated to Telegram;
- do not use Speech Engine/WebSocket for this MVP.

## 9. FFmpeg dependency audit

Package/repository:

```text
ffmpeg-static
eugeneware/ffmpeg-static
```

Purpose:

- provide a Windows-resolvable FFmpeg binary path;
- normalize Telegram OGG/Opus to WAV for local STT;
- optionally remux TTS output only if Telegram direct voice upload fails.

Required command shape:

```js
spawn(ffmpegPath, [
  "-y",
  "-i", inputPath,
  "-ar", "16000",
  "-ac", "1",
  "-c:a", "pcm_s16le",
  outputPath
], { windowsHide: true });
```

Add `-nostdin` to prevent accidental console blocking. Capture bounded stderr for diagnostics. Never invoke through `cmd.exe`, PowerShell, or `shell: true`.

License note: the package repository is GPL-3.0 and distributed FFmpeg binary licensing depends on the build. Keep it as an npm dependency; do not copy the binary into Git. Preserve package notices in distribution artifacts.

## 10. Exact implementation interfaces

### Telegram media receive

```js
async function persistIncomingTelegramAttachments({
  attachments,
  stateDir,
  botToken,
  messageId,
  receivedAt,
  fetchImpl = fetch,
  maxImageBytes,
  maxAudioBytes,
  timeoutMs
}) -> { saved, failed }
```

Attachment descriptors from normalization:

```js
{
  kind: "image" | "voice" | "audio",
  fileId: "",
  fileUniqueId: "",
  contentType: "",
  fileName: "",
  sizeBytes: 0,
  durationSeconds: 0
}
```

Security requirements:

- never return or log a URL containing Bot Token;
- validate `getFile` JSON;
- check announced size when present and actual downloaded size always;
- stream with a byte cap if practical; otherwise reject after bounded buffer read;
- filename derives from trusted kind/extension plus hash, not raw user path;
- write with exclusive/unique semantics;
- no path component from Telegram is joined directly without basename/sanitization.

### STT service

```js
function createSpeechToTextService({
  enabled,
  modelFile,
  tokensFile,
  threads,
  timeoutMs,
  ffmpegPath,
  cacheDir,
  loadSherpa,
  spawnImpl,
  fsImpl
})

service.transcribe({ inputPath, contentType })
  -> { text, provider, durationSeconds }
```

### TTS sanitizer

```js
function sanitizeTextForTts(text, { maxChars, codeRatioLimit })
  -> { ok, text, reason }
```

It is a pure function with no network, files, config reads, or model calls.

### ElevenLabs service

```js
function createElevenLabsTtsService({
  apiKey,
  voiceId,
  modelId,
  outputFormat,
  timeoutMs,
  loadSdk
})

service.synthesize(text) -> Buffer
```

### Telegram voice send

```js
async function sendTelegramVoice({
  token,
  chatId,
  audioBuffer,
  fileName,
  caption,
  fetchImpl
})
```

Use multipart field name `voice`.

## 11. Test fixture map

Do not copy external tests. Recreate these behaviors with this repository's `node:test` style.

### `test/telegram-media.test.js`

- update normalization fixtures for text, captioned photo, photo-only, voice, audio, reply-to-bot message;
- largest photo variant;
- dedupe unchanged;
- fake `getFile` and fake download;
- size limit and secret-redacted error;
- inbox attachment shape.

### `test/telegram-media-integration.test.js`

- exact ordinary text envelope snapshot;
- Telegram image to vision mock;
- caption + visual context;
- image-only turn;
- caption fail-open;
- WeChat regression.

### `test/speech-to-text-service.test.js`

- injected addon with fake recognizer;
- recognizer reuse;
- result normalization;
- FFmpeg argument array;
- WAV cleanup;
- missing model/addon/FFmpeg errors.

### `test/telegram-voice-integration.test.js`

- prepared voice becomes `[语音转写]\ntext`;
- no `用户` substring;
- empty/failure creates no runtime turn;
- subsequent text works.

### `test/tts-text-sanitizer.test.js`

- Markdown markers removed, wording retained;
- Markdown links become labels;
- URLs removed;
- ordinary Chinese punctuation retained;
- code-heavy and empty inputs rejected;
- max length behavior deterministic.

### `test/elevenlabs-tts-service.test.js`

- fake dynamic SDK loader;
- configured voice/model/output passed;
- stream/chunks converted to Buffer;
- 401/429/timeout error redaction;
- no API key in error text.

### `test/telegram-voice-output.test.js`

- multipart field `voice`;
- `/say` reply source selection;
- `/say <text>` fallback;
- `/voice once` single use;
- text delivered before voice callback;
- streaming chunks produce one final voice;
- TTS failure does not alter text success.

## 12. Dependency and source-copy policy

Allowed:

- install official npm dependencies;
- adapt small MIT/Apache patterns with attribution where substantial;
- independently implement behavior observed in GPL examples;
- quote repository names, commits, file paths, and function names in documentation.

Forbidden:

- copying GPL-2.0 Python implementation into JS line-for-line;
- copying unlicensed Luna demo source;
- vendoring external repositories or model binaries;
- copying generated ElevenLabs SDK code into this repository;
- downloading random prebuilt native addons outside official npm/release channels;
- adding source files whose license cannot be identified.

If a substantial portion of MIT or Apache source is copied, add a focused notice under:

```text
THIRD_PARTY_NOTICES.md
```

Do not create that file for ordinary API usage or high-level behavioral inspiration.

## 13. Things Codex must not reconsider

The following decisions are closed for this MVP:

- Node in-process integration, no Python sidecar;
- existing Vision service reused;
- local SenseVoice first, no API fallback;
- ElevenLabs official Node SDK;
- text reply remains primary;
- TTS is manual one-shot or reply `/say`;
- no second model for TTS text processing;
- no 520 UI;
- no persistent media/transcript database;
- no new poller/watchdog/startup task;
- no broad architecture refactor;
- no fresh GitHub research.

Codex may deviate only when a Stage 1 dependency probe produces a concrete blocker. The report must include the exact command, version, and error; it may not silently substitute a different architecture or provider.
