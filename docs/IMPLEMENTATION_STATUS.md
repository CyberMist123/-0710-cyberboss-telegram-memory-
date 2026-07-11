# Implementation Status

Last updated: 2026-07-12

Phase 1 through Phase 5A are present in the selected immutable live release. The user explicitly waived the pending Telegram canary on 2026-07-12, so the release is temporarily green based on offline gates, the live process matrix, and a healthy watchdog cycle; this is not recorded as a passed canary.

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
- The live release descriptor and remote implementation branch both selected `ba5efce3621d8874f09a0c2ccab9c28535c426e6` before the current 520 follow-up work began.

## Current Scope

- Phase 2 now provides first-turn-only Re-entry, opening/refresh Current State, Context Trace, explicit resume-origin handling, and four-gate legacy-memory enforcement.
- Phase 3 now provides the leased Closeout/Janitor candidate path, independent Auto Review decisions, and the unique History writer publication path.
- Phase 4 now provides the independent 520 read-only observation console, module state, Trace/candidate/decision views, and controlled exceptional re-review.
- The 520 octant view now consumes current DesireService `drive/scores` as well as the legacy `drives[]` shape, reports source/freshness/completeness, and prefers Desire-owned `desire-history.jsonl` over frozen `state_log.jsonl`.
- Upstream `AngeliaSama/cyberboss-deepseek@ecc98cd` was compared semantically because the imported Git histories have no merge base. Claude runtime already contained upstream's turn-completed Desire recovery; the live gap was `CYBERBOSS_DESIRE_DRIVEN=0`. The gate is now enabled while coupling, baseline drift, heartbeat autonomy, and self-drive remain off, and Claude-reported octants atomically update realtime state plus a deduplicated history row.
- Windows silent startup is defined by one independent repository PS1 which registers separate 520 and memory-watchdog tasks; it has no Te Launcher dependency and preserves process-tree isolation.
- Phase 5A now provides explicit `user_pull` string lookup with server-enforced budgets, supersession visibility, and recall evidence.
- Phase 5B remains incomplete.
- Soft Retrieval：离线 replay harness 已实现并完成本机测试；尚未接入 SHADOW、Telegram 或真实回复链。
  - 位置：`tools/soft-retrieval-replay/`（纯 Python，依赖 numpy + pyyaml；规范见 `docs/soft-retrieval/SPEC.md` 与 `REPLAY_HARNESS.md`）。
  - 测试：`cd tools/soft-retrieval-replay && python -m unittest discover -s tests` — 15/15 通过（HARNESS §8 十三条清单 + 2 条附加）。
  - 真实 API smoke：`python smoke_real_apis.py`（读本目录 .env，勿提交）。沙箱内因网络出口 403（请求未到达 API）未能验证 Gemini/DeepSeek 适配器——属环境限制而非适配器缺陷；须在本机跑通一次后方可用于真实回放。
  - 限制：仅 mock/fixture provider 经过验证；检索链只读、无 TG 引用、无常驻进程；独立证据/模式治理仅埋 schema 字段，算法按 SPEC 禁令未实现。

## Phase 2 Offline Gate

- `CYBERBOSS_CONTINUITY_DIR` is an explicit external root. The adjudicated operational target is outside the Git worktree, state-dir, and legacy memory directory, and Janitor scans only its separately supplied transcript input.
- Re-entry is read as canon bytes without persona template substitution, truncation, or rewriting. Files over 300 non-whitespace characters are skipped with a warning.
- A successful injection is persisted by runtime thread ID in `sessions.json`; `/new` gets a new thread budget, existing `/switch` and `/reread` paths never load Re-entry, and implicit runtime loss rebuilds with `thread_recreated` evidence.
- Current State uses the Desire service's read-only state interface and is loaded only for opening or instruction refresh.
- Context Trace uses a single-process asynchronous append queue, stores hashes/counts/reasons only, and records Episodes, Timeline, Portrait, Self-note, and Rereadings as default-hidden.
- `npm run check`, `npm run test:phase2` (9/9), and `npm run test:phase1` (61 Node + 18 Janitor + 3 Dashboard, portability and PowerShell checks) passed.
- Writer change: no canon writer changed. The existing session-store writer now owns only the per-thread Re-entry injection marker; Context Trace is a new append-only evidence writer.
- Rollback: revert the Phase 2 commit and restore the previous external orchestrator `last_green_sha`. Offline fixtures used temporary directories, so no live continuity data rollback is required before cutover.

## Phase 3 Offline Gate

- Dashboard POST routes that could write memory, Desire/care state, candidates, configuration, or trigger Janitor are hard-frozen with HTTP 403 before the new data chain is used.
- Closeout runs at most once per date, allows `no_output`, calls the configured subject runtime in an isolated background thread, and emits only the frozen candidate schema.
- Janitor is gap-only, uses the same consumer-side purity filter, writes only candidates plus its operational cursor/cache, and requires the controlled writer-lease wrapper outside mock fixtures.
- Auto Review runs through the existing Python memory-kit model configuration. Missing or failed Review defers candidates; decisions never contain rewritten body text; imperative language warns without automatic rejection.
- History writer is the only canon publisher. It executes accepted primary decisions, keeps merged duplicates single, appends corrections, backs up changed canon files, atomically replaces Re-entry, and appends Self-notes.
- Same-day Closeout → Review → History replay is byte-identical. Candidate-to-Episode body equality, Dashboard 403 behavior, source-window lookup, boundary push rules, lease contention, over-budget Re-entry deferral, and `state_log.jsonl` immutability are covered by fixtures.
- Writer change: `closeout-writer` and `janitor-writer` may append candidates; `review-writer` appends decisions; `history-writer` alone publishes Episode/Re-entry/Self-note canon. The subject runtime remains the sole author of Re-entry/Self-note body text.
- Rollback: revert the Phase 3 commit. Before live use, restore changed canon from the continuity `.backups` directory and verify file hashes; offline fixtures require no data rollback.

## Phase 4 Offline Gate

- `/api/module-state` reports only `not_implemented`, `available`, `preview`, `on`, or `failed` for hard context, Trace, Re-entry, Closeout, Janitor, Auto Review, History writer, Dashboard, memory lookup, and Soft Retrieval.
- Context Trace, candidates, and decisions are exposed through bounded read-only endpoints and a dedicated Continuity view. Empty stores are reported honestly.
- The exceptional Re-review control is shown only for deferred or rejected decisions. Its authenticated endpoint invokes the leased Review service and never writes canon or Desire directly.
- Legacy file editing, care/cycle submission, Janitor triggering, and configuration editing are removed or retired in the UI; all corresponding server write routes remain frozen with HTTP 403.
- Dashboard termination is process-isolated from a TG sentinel, and the release watchdog contains no Dashboard target or restart path.
- `npm run check`, `npm run test:phase4` (one targeted Re-review test, the HTTP/UI/process fixture, and 10 orchestration tests), and the earlier Phase gates pass without touching live processes or real memory.
- Writer change: none. Phase 4 adds no canon or Desire writer; Re-review delegates to the existing `review-writer` lease.
- Rollback: revert the Phase 4 commit. No continuity or memory data restoration is required because the Phase 4 fixtures use temporary directories.

## Phase 5A Offline Gate

- `memory_lookup` exposes the frozen `memory.lookup(query, trigger="user_pull", reason)` contract through the project tool host and MCP server. The dotted name remains a direct host alias; the MCP-safe name is auto-approved.
- Any trigger other than `user_pull` returns `invalid_trigger`. Context builders and ordinary chat contain no automatic lookup call path, and Phase 5B/Soft Retrieval remains off.
- Lookup is literal string search over continuity `episodes.jsonl`: at most three hits, at most 500 non-whitespace characters per body, and honest empty or `lookup_failed` results.
- The five-call fault-loop guard is persisted per channel + account + thread and survives tool-server restarts. It is an operational guard, not a posture budget.
- Superseded hits include their correction without deleting or mutating the original Episode.
- `recall_log.jsonl` stores query, hit IDs, session hash, trigger, timestamp, and remaining budget but no hit body. The same turn's Context Trace receives only trigger and result count.
- `npm run check` and `npm run test:phase5a` (6/6) pass; Phase 1 through Phase 4 remain separate regression gates.
- Writer change: `memory-lookup` writes only operational budget/lock state and append-only recall evidence; it cannot write canon, candidates, decisions, Desire, or `state_log.jsonl`.
- Rollback: revert the Phase 5A commit and remove only Phase 5A operational recall/budget artifacts if a data rollback is explicitly required. Canon needs no restoration.

## Notes

- The live process and port map is stored outside the repo as an external snapshot.
- The watchdog cutover plan and live release/state files remain outside the repo.
- The enabled legacy TG scheduled task points to an intentionally inert VBS because the current user could not change task enablement without elevation; it is not an effective TG owner.
