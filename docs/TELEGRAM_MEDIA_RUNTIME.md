# Telegram media runtime contract

Telegram inbound media has one production path:

1. `telegram.js` normalizes supported media into `telegram.media[]` descriptors.
2. `MediaInboxService` validates, bounds, downloads, and atomically stores files below `CYBERBOSS_STATE_DIR/media/`.
3. `VoiceService` performs optional STT after the voice attachment is saved.
4. The conversation record is written only after media and transcription state are final.

Supported descriptor kinds are `voice`, `audio`, `photo`, and `sticker`. Stickers carry
`stickerType` of `webp`, `tgs`, or `webm`. Telegram documents and videos remain
explicit placeholders and are not downloaded by this path.

Attachment metadata contains a stable `relativePath` and `stateMediaRef` such as
`state-media://media/photos/<file>`. The reference is resolved only against the
authoritative state media root after confinement checks; it cannot contain a drive,
UNC path, backslash, `.` or `..` segment. Absolute paths remain internal to the
service/VoiceService and are never emitted into the model-facing Telegram bridge.

The Telegram runtime bridge uses the deployed plaintext `<channel source="telegram"
...>` envelope. Message text remains readable; a literal `</channel>` in the body is
escaped as `&lt;/channel&gt;` so it cannot close the envelope. Attachments are emitted as
`<media ... reference="state-media://..." />` entries only after their references
resolve below the authoritative state media root. User-controlled media attributes
are XML-escaped, and absolute paths are never exposed. Telegram media directories
reject links/reparse points and use bounded downloads, `.part` files, fsync and rename
before an attachment is recorded.

Local Whisper is opt-in with `CYBERBOSS_LOCAL_WHISPER_ENABLED=true`. It requires a
local model directory, uses argv-only process spawning, has bounded input/output and
timeout controls, waits for a terminated process tree before returning, and never
downloads a model automatically. When enabled, `CYBERBOSS_LOCAL_WHISPER_MODEL` must
be an existing absolute local directory.
