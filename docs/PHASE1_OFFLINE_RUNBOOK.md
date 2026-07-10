# Phase 1 Offline Runbook

This runbook is intentionally placeholder-only. Do not paste real tokens, live memory paths, sessions, conversations, or logs into it.

## Offline Acceptance

- Use a fixture state directory: `<STATE_DIR>`.
- Use a fixture workspace: `<WORKSPACE>`.
- Use a private config directory: `<CONFIG_DIR>`.
- Use a prompt file: `<REPO_ROOT>/templates/weixin-instructions.md` or another reviewed prompt file.
- Use a fake Telegram token or a mock channel adapter for automated tests.
- Keep `CYBERBOSS_MEMORY_RETRIEVAL=0`, `CYBERBOSS_MEMORY_BACKGROUND_WRITE=0`, and `CYBERBOSS_MEMORY_REPLY_TRANSFORM=0` unless a later phase explicitly re-enables them.
- Do not start 520 or Janitor during Phase 1 acceptance.

## Manual Switch Checklist

1. Verify the old Telegram poller has been stopped by the operator.
2. Verify the old dashboard/520 process is not being changed by this script.
3. Set `CYBERBOSS_CONFIG_DIR`, `CYBERBOSS_STATE_DIR`, `CYBERBOSS_WORKSPACE`, `CYBERBOSS_PROMPT_FILE`, `CYBERBOSS_TELEGRAM_BOT_TOKEN`, and `CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS` in the shell or private `.env`.
4. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/phase1-switch.ps1` to preflight only.
5. Run the same script with `-ConfirmSwitch` only after the operator has confirmed the live poller is no longer active.
6. Send one Telegram smoke-test message and verify exactly one reply path is active.

## One-Command Rollback

1. Set `CYBERBOSS_STATE_DIR` to the Phase 1 state directory.
2. Optionally set `CYBERBOSS_LEGACY_START_COMMAND` to the operator-approved legacy start command.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/phase1-rollback.ps1` to preflight only.
4. Run the same script with `-ConfirmRollback` to stop the configured Phase 1 service and optionally launch the approved legacy command.

## Writer Declaration

- Conversation recorder remains the only runtime conversation writer.
- Legacy MemoryService background write is off by default.
- Legacy MemoryService reply validator and rewriter are off by default.
- Legacy MemoryService pre-response retrieval is off by default.
- Dashboard Janitor scheduling is off by default and requires explicit transcript and memory directories.
- Janitor and extractor require explicit output directories and should use copy-on-write fixtures for Phase 1 tests.

## Data Protection

- Real memory is not migrated in Phase 1.
- Real memory must not be deleted, moved, overwritten, normalized, or schema-migrated.
- Future migrations must copy to a new directory, record file list, size, mtime, and SHA-256 before and after, and leave the original directory untouched.
