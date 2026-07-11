# Phase 1 Orchestration

The live release descriptor is external to the repository at
`<cyberlink-root>/deployment/current.json`. The repository
contains only its schema, example, loader, validation, and atomic rollback tool.

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
