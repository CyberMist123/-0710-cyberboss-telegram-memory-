# Telegram media runtime contract

```text
Status: active
Authority: stable architecture
Scope: Telegram 入站媒体运行时契约
Current status: docs/CURRENT_STATUS.md
```


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

The Telegram runtime bridge is the plaintext envelope the deployment speaks:

```
<channel source="telegram" chat_id="…" message_id="…" user_id="…" username="…" sent_at="…">
<body text, as the user typed it>
<media kind="photo" content_type="…" file_name="…" reference="state-media://media/photos/<file>" />
</channel>
```

Every attribute is omitted when empty and XML-escaped when present, so caption,
filename, MIME and username cannot add an attribute or a second media entry. Only
verified state-media references are emitted; an unresolvable reference is dropped
and an absolute path is never exposed. The body is passed through verbatim apart
from a literal `</channel>`, which is escaped to `&lt;/channel&gt;` so user text
cannot end the envelope early. Body text that merely looks like markup is left as
written and read by the model as text — the envelope is a frame, not a sandbox.
Telegram media directories reject links/reparse points and use bounded downloads,
`.part` files, fsync and rename before an attachment is recorded.

Local Whisper is opt-in with `CYBERBOSS_LOCAL_WHISPER_ENABLED=true`. It requires a
local model directory, uses argv-only process spawning, has bounded input/output and
timeout controls, waits for a terminated process tree before returning, and never
downloads a model automatically. When enabled, `CYBERBOSS_LOCAL_WHISPER_MODEL` must
be an existing absolute local directory.
