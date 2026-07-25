# Telegram media runtime contract

Telegram inbound media has one production path:

1. `telegram.js` normalizes supported media into `telegram.media[]` descriptors.
2. `MediaInboxService` validates, bounds, downloads, and atomically stores files below `CYBERBOSS_STATE_DIR/media/`.
3. `VoiceService` performs optional STT after the voice attachment is saved.
4. The conversation record is written only after media and transcription state are final.

Supported descriptor kinds are `voice`, `audio`, `photo`, and `sticker`. Stickers carry
`stickerType` of `webp`, `tgs`, or `webm`. Telegram documents and videos remain
explicit placeholders and are not downloaded by this path.

Attachment metadata contains a stable `relativePath`, an internal absolute path for
runtime access, the source reference, content type, size, and download state. Full
paths are not written to Telegram logs or ordinary prose. The Telegram runtime bridge
uses a structured `<media ... path="..." />` entry so path-capable runtimes can open
the saved file without a second media pipeline.

Local Whisper is opt-in with `CYBERBOSS_LOCAL_WHISPER_ENABLED=true`. It requires a
local model directory, uses argv-only process spawning, has bounded input/output and
timeout controls, and never downloads a model automatically.
