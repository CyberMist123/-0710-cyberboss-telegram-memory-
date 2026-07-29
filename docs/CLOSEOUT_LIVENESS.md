# Closeout and canon/recall liveness

```text
Status: active
Authority: stable architecture
Scope: Closeout 与 canon/recall liveness 的结构
Current status: docs/CURRENT_STATUS.md
```


The P0 automation is disabled by default. When enabled, `CyberbossApp` registers one independent closeout/liveness owner during `start()`. It owns one cancellable timer and does not modify the existing Desire scheduler or normal Telegram/WeChat turn path.

## Configuration

```dotenv
CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED=false
CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR=4
CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE=30
CYBERBOSS_AUTOMATION_TIMEZONE=Australia/Sydney

CYBERBOSS_CANON_LIVENESS_ENABLED=false
CYBERBOSS_CANON_LIVENESS_THRESHOLD_HOURS=48
CYBERBOSS_RECALL_LIVENESS_ENABLED=false
CYBERBOSS_RECALL_LIVENESS_THRESHOLD_HOURS=48
CYBERBOSS_LIVENESS_STARTUP_GRACE_MINUTES=30
CYBERBOSS_LIVENESS_ALERT_COOLDOWN_HOURS=24
CYBERBOSS_LIVENESS_RECOVERY_ENABLED=true
```

Boolean values must be explicit. Hours, minutes, thresholds, grace, and cooldown are strict bounded integers; values such as `48abc` are rejected during configuration parsing. Existing `incoming-media`, Fable, Desire, and ordinary Telegram behavior are not changed.

## Closeout path

At or after the configured target time, the owner uses `CYBERBOSS_AUTOMATION_TIMEZONE` to select the just-ended previous complete local day, then directly calls `ContinuityPipeline.runCloseoutAsync()` through `src/continuity/closeout-job.js`. The shared business-day utility also drives conversation file partitioning, ledger keys, and candidate timestamps. The owner does not enqueue a prompt asking the model whether to run closeout. The pipeline remains responsible for filtered materials, the existing writer lease, candidate idempotency, and the `.jobs/closeout-YYYY-MM-DD.json` ledger.

The owner also uses a small durable claim lease and retry state. Empty output while the processing window remains open is stored as `retryable_no_output` and retried after backoff; when the next business-day window opens, an older empty day may become terminal `sealed_no_output`. A successful or sealed result is not run again. Legacy `no_output` ledger and retry-state records are interpreted as retryable and are lazily replaced by one of the explicit states. Failures are recorded, retried after backoff, and capped; a failure never writes a success ledger.

## Liveness path

Canon and recall are separate checks with separate switches and thresholds. The checker parses JSONL records and uses the newest valid record timestamp, not filesystem `mtime`. It distinguishes missing, empty, corrupt, unreadable, no-valid-record, stale, and healthy states. A valid prior record followed by a partial final line is tolerated without changing the JSONL format.

State is persisted under the continuity `.jobs` directory with `status`, `fingerprint`, `first_seen_at`, `last_checked_at`, `last_alerted_at`, `recovered_at`, and the last error/delivery fields. Initial no-data findings respect startup grace; explicit corruption and unreadable data do not. Fingerprints and cooldown survive restart, and a recovery alert is emitted at most once per failure episode.

Alerts are queued only when the current channel is explicitly Telegram. They use the existing system-message queue and dispatcher; no bot token, chat ID, URL, or HTTP client is added. Delivery failures are bounded and recorded without stopping the main chat loop or scheduler.

Focused offline coverage is available with:

```text
npm run check:p0-closeout-liveness
npm run test:p0-closeout-liveness
```
