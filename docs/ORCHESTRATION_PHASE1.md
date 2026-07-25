# Phase 1 Orchestration

The live release descriptor is external to the repository at
`<cyberlink-root>/deployment/current.json`. The repository
contains only its schema, example, loader, validation, and atomic rollback tool.

`current.json` is UTF-8 without a BOM. Before an activation or rollback can
replace it, the control plane validates both the active and rollback targets:
their inferred release directories, Telegram entries, watchdog targets,
external state/log/PID paths, and release identities must all be complete and
present. A failed preflight leaves the previous descriptor untouched.

The scheduled task `cyberboss-watchdog` is the sole Telegram auto-recovery
owner. It reads the active release from `current.json`, validates the PID against
the full Telegram entry path and command line, and restores only that release.
WeChat remains independently owned. The dashboard is not a watchdog target.

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
