# Phase 1 Orchestration

The live release descriptor is external to the repository at
`<cyberlink-root>/deployment/current.json`. The repository
contains only its schema, example, loader, validation, and atomic rollback tool.

`current.json` is UTF-8 without a BOM. Before an activation or rollback can
replace it, the control plane validates both the active and rollback targets:
their inferred release directories, Telegram entries, watchdog targets,
external state/log/PID paths, and release identities must all be valid. The
descriptor preflight checks static paths: a PID path must have an existing
external parent directory, but the PID file may be absent before startup. If it
already exists, it must be a regular file. A failed preflight leaves the
previous descriptor untouched.

PID contents and the real process identity are post-start health checks. They
are intentionally not part of static descriptor `--require-existing`
validation, and an inactive rollback release is not expected to have a running
process.

The scheduled task `cyberboss-watchdog` is the sole Telegram auto-recovery
owner. It reads the active release from `current.json`, validates the PID against
the full Telegram entry path and command line, and restores only that release.
WeChat remains independently owned. The dashboard is not a watchdog target.

`watchdog_owner_dir`, when present, is the external, stable directory that
holds the sole watchdog's own operational bookkeeping (its `watchdog.pid`,
`watchdog.log`, and any local state) — never the descriptor's telegram/watchdog
code targets. Validation (`requireExistingPaths`) requires it to be an
absolute, normalized path that is *outside* both the active and rollback
`release_path`, so deleting or replacing a release can never take the
watchdog's own bookkeeping down with it, and re-pointing it never requires an
immutable-release rebuild. `watchdog_target` (the script the watchdog
launches to restore the active release) is unaffected by this rule and may
still live inside the active release. An empty or absent `watchdog_owner_dir`
is accepted for backward compatibility with descriptors that predate this
field; once set, it is validated like any other external path field.

Live state files are external and must not be committed:

- `<cyberlink-root>/MEMORY_WRITER_LEASE.json`
- `<cyberlink-root>/MEMORY_ORCHESTRATOR_STATE.json`
- `<cyberlink-root>/MEMORY_CANARY_STATE.json`

Rollback preflight:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\windows\phase1-rollback.ps1
```

Confirmed rollback atomically switches the descriptor before the sole watchdog
restores the rollback release:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\windows\phase1-rollback.ps1 -ConfirmRollback
```

The canary runner reads only existing local logs/state/recorder files and never
calls Telegram `getUpdates` or the Bot API. A timeout returns
`USER_ACTION_PENDING` and can be resumed with `--resume`.

The official local canary source list now includes
`<CYBERBOSS_STATE_DIR>/canary-receipts.jsonl`. The sole Telegram inbound
poller appends a minimal JSONL receipt (timestamp, canary id, update id,
message id, thread hash, poller pid) whenever a message whose text is an
exact match for the canary UUID pattern passes the allowed-user check, and
never records ordinary message bodies, bot tokens, or raw chat ids. The
runner CLI accepts `--state-dir=<path>` to include the receipt file
automatically alongside any explicit `--source=<path>` arguments; the
receipt file is not fetched from Telegram and does not spawn a second
poller.
