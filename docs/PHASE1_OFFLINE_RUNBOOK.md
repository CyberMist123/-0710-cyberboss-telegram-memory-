# Phase 1 Offline Runbook

This runbook is intentionally placeholder-only. Do not paste real tokens, live memory paths, sessions, conversations, or logs into it.

## Offline Acceptance

- Use a fixture state directory: `<STATE_DIR>`.
- Use a fixture workspace: `<WORKSPACE>`.
- Use a private config directory: `<CONFIG_DIR>`.
- Use a prompt file: `<REPO_ROOT>/templates/weixin-instructions.md` or another reviewed prompt file.
- Use a fake Telegram token or a mock channel adapter for automated tests.
- Keep `CYBERBOSS_MEMORY_RETRIEVAL=0`, `CYBERBOSS_MEMORY_BACKGROUND_WRITE=0`, `CYBERBOSS_MEMORY_REPLY_TRANSFORM=0`, and `CYBERBOSS_INCLUDE_LEGACY_MEMORY_RELAYS=0` unless a later phase explicitly re-enables them.
- Keep `CYBERBOSS_DESIRE_DRIVEN=0` during the Phase 1 Telegram-only smoke test.
- Runtime configuration comes from exactly one source: explicit `CYBERBOSS_ENV_FILE`, or `<CONFIG_DIR>/.env` when no explicit env file is set. `<STATE_DIR>/.env` is not loaded.
- Run `.github/workflows/phase1-offline.yml` or `npm run test:phase1` before any live switch.
- Do not start 520 or Janitor during Phase 1 acceptance.

## Manual Switch Checklist

1. Record the old Telegram poller PID and set `CYBERBOSS_LEGACY_PID_FILE` when a reliable PID file is available.
2. Verify the old Telegram poller has been stopped by the operator.
3. Keep the old dashboard/520 process unchanged.
4. Set `CYBERBOSS_CONFIG_DIR`, `CYBERBOSS_STATE_DIR`, `CYBERBOSS_WORKSPACE`, `CYBERBOSS_PROMPT_FILE`, `CYBERBOSS_TELEGRAM_BOT_TOKEN`, and `CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS` in the current PowerShell process before running the switch preflight.
5. When another non-Telegram Cyberboss process must remain running, set `$env:CYBERBOSS_NON_TELEGRAM_PID_ALLOWLIST` in that same PowerShell process to its current PID or comma-separated PIDs. Only explicitly verified non-Telegram processes belong in this list. Never add the old Telegram PID.
6. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/phase1-switch.ps1` to preflight only.
7. Read the reported allowlist and process scan output. If any PID is unexpected, stop and correct the environment instead of bypassing it.
8. Run the same script with `-ConfirmSwitch` only after the operator has confirmed the live Telegram poller is no longer active.
9. Send one Telegram smoke-test message and verify exactly one reply path is active.

## One-Command Rollback

1. Set `CYBERBOSS_STATE_DIR` to the Phase 1 state directory.
2. Validate the external `deployment/current.json` release descriptor.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/phase1-rollback.ps1` to preflight only.
4. Run the same script with `-ConfirmRollback` to atomically switch the descriptor, stop the verified current process, and let the sole watchdog restore the rollback release.

## Writer Declaration

- Conversation recorder remains the only runtime conversation writer.
- Legacy MemoryService background write is off by default.
- Legacy MemoryService reply validator and rewriter are off by default.
- Legacy MemoryService pre-response retrieval is off by default.
- Hourly Desire polling is off unless `CYBERBOSS_DESIRE_DRIVEN` is explicitly enabled.
- Dashboard Janitor scheduling is off by default and requires explicit transcript and memory directories.
- Janitor and extractor require explicit output directories and should use copy-on-write fixtures for Phase 1 tests.

## Data Protection

- Real memory is not migrated in Phase 1.
- Real memory must not be deleted, moved, overwritten, normalized, or schema-migrated.
- Future migrations must copy to a new directory, record file list, size, mtime, and SHA-256 before and after, and leave the original directory untouched.
