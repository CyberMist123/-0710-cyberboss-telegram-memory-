# Implementation Status

Last updated: 2026-07-11

Phase 1 engineering and the minimum orchestration foundation are live verified. Phase 2 hard-context engineering is offline verified and has not been cut over to live yet.

## Verified Evidence

- The same implementation baseline passed offline with `72/72`.
- Telegram normal flow, 10 consecutive messages, duplicate messages, streaming, `/new`, and `/switch` all passed.
- After fixing the PowerShell array issue, the real memory stayed `118 -> 118`, with `added = 0`, `removed = 0`, and `modified = 0`.
- The CI workflow is consolidated into `.github/workflows/phase1-offline.yml` as the sole Phase 1 entry point, and it installs the Python requirements before `npm run test:phase1`.
- The external current release descriptor selects the E-drive Phase 1 release; the legacy release is retained only as an atomic rollback target.
- `cyberboss-watchdog` is the sole effective Telegram auto-recovery owner. The legacy TG task action is inert, and Te Launcher auto-start manages only WeChat.
- The watchdog completed a full healthy cycle and then restored only the Phase 1 TG after its verified process tree was stopped once. The old TG did not appear.
- Dashboard duplicate risk was closed by stopping the verified Python Manager parent. Its listener child exited with it, leaving dashboard off and port 520 unbound without affecting TG or WeChat.
- Writer lease, atomic orchestrator state, interrupted-resume fixtures, release validation, and local-only canary fixtures are implemented.
- The canary runner reads existing local log/state/recorder sources only. It does not call Telegram `getUpdates` or the Bot API.
- Final local verification passed: 61 Node tests, 18 janitor fixtures, 3 dashboard fixtures, portability, PowerShell parsing, and syntax checks.
- Live verification after the recovery drill: new TG `1`, old TG `0`, WeChat `1`, Telegram poller `1`, watchdog `1`, dashboard `0`, port 520 listeners `0`, and Telegram 409 conflicts `0`.
- Real memory remained 118 files with no added, removed, or modified files; `state_log.jsonl` was unchanged.

## Current Scope

- Phase 2 now provides first-turn-only Re-entry, opening/refresh Current State, Context Trace, explicit resume-origin handling, and four-gate legacy-memory enforcement.
- Phase 3 through Phase 5 are still incomplete.
- Soft Retrieval remains off.

## Phase 2 Offline Gate

- `CYBERBOSS_CONTINUITY_DIR` is an explicit external root. The adjudicated operational target is outside the Git worktree, state-dir, and legacy memory directory, and Janitor scans only its separately supplied transcript input.
- Re-entry is read as canon bytes without persona template substitution, truncation, or rewriting. Files over 300 non-whitespace characters are skipped with a warning.
- A successful injection is persisted by runtime thread ID in `sessions.json`; `/new` gets a new thread budget, existing `/switch` and `/reread` paths never load Re-entry, and implicit runtime loss rebuilds with `thread_recreated` evidence.
- Current State uses the Desire service's read-only state interface and is loaded only for opening or instruction refresh.
- Context Trace uses a single-process asynchronous append queue, stores hashes/counts/reasons only, and records Episodes, Timeline, Portrait, Self-note, and Rereadings as default-hidden.
- `npm run check`, `npm run test:phase2` (9/9), and `npm run test:phase1` (61 Node + 18 Janitor + 3 Dashboard, portability and PowerShell checks) passed.
- Writer change: no canon writer changed. The existing session-store writer now owns only the per-thread Re-entry injection marker; Context Trace is a new append-only evidence writer.
- Rollback: revert the Phase 2 commit and restore the previous external orchestrator `last_green_sha`. Offline fixtures used temporary directories, so no live continuity data rollback is required before cutover.

## Notes

- The live process and port map is stored outside the repo as an external snapshot.
- The watchdog cutover plan and live release/state files remain outside the repo.
- The enabled legacy TG scheduled task points to an intentionally inert VBS because the current user could not change task enablement without elevation; it is not an effective TG owner.
