# Implementation Status

## 2026-07-26 翻盘清单第 1/2/4/5 条：接线测试门（`fix/r4-test-gate`）

恢复工作的第一步，按 R4 报告末尾清单的序号执行。本分支只动测试门与 watchdog 版本守卫，不碰 F2/F4 的代码修复（清单 6–9 留待后续 `fix/*` 分支）。

**顺带修复了一个更急的问题：`main` 的 CI 自审计报告并入后一直是红的。** 根因是 `scripts/portability-check.js` 的 `windows-drive-path` 检查命中了 `docs/audit/R4_FINAL_CODE_REVIEW.md` 里逐字引用的证据路径（盘符开头的合成夹具路径，来自 status-script 测试）。修法：仅对 `docs/audit/` 豁免 `windows-drive-path` 这一条 —— 审计报告必须逐字引用证据；用户路径、私名等其余检查对 docs 照常生效。

- **清单 1（F1.4）**：`npm run test:orchestration` 从 7 个文件扩到 11 个（补 `status-script`、`release-manifest`、`stable-telegram-launcher`、`release-descriptor-watchdog-owner` —— 最后一个此前不被任何脚本引用），并作为独立步骤接进 `.github/workflows/phase1-offline.yml`。5 个 release/cutover 测试文件自此全部在 windows-latest 上真实执行。
- **清单 2（F1）**：`release-control-plane`（4 个 PS 测试）、`orchestration-release-watchdog`（2 个 PS 测试）、`status-script`（2 个 Windows 路径断言测试）补 `{ skip: !IS_WINDOWS }`。只守卫真正 Windows-only 的测试；Python 探针类测试保持全平台执行（F1.3(b) 的教训：那些不是平台问题，skip 等于埋掉缺陷）。
- **清单 4（F1.1/F1.2）**：5 处 `assert.notEqual(status, 0)` 假绿断言收紧为 `assertFailedClosed`：先断言 `result.error` 为空、`status !== null`（证明进程真的跑过），失败信息携带 stderr/stdout。ENOENT 不再静默成 `null !== 0` 通过。
- **清单 5（F5）**：`watchdog.py` 加 `from __future__ import annotations`（低版本导入不再炸出无解释的 TypeError），`main()` 入口加 `enforce_python_floor()`（< 3.10 时带明确诊断 fail-closed）。CI 末尾新增 Python 3.9 探针步骤，断言 watchdog 确实以清晰信息拒绝启动 —— 守住 CI 主流程 Python 3.12 复现不了该缺陷的盲区。
- **清单 3** 的首轮证据由接线后的 windows-latest CI run 提供（PS 测试真实执行的完整输出）；真机 Windows 留证仍待生产机操作时补。

**接线后测试门立刻抓到并修复了两个真实 Windows 缺陷**（此前 Mac 上被 F5 全红遮蔽、CI 上从未执行过）：

1. `watchdog_identity` 的路径比较（normcase+abspath）无法把 Windows 8.3 短路径与长路径判为同一文件 —— 短路径启动的重复 watchdog 不会被重复守卫拦截（fail-open）。修法：比较前两侧都 `Path.resolve()` 规范化（`same_file_path`），语义仍是精确三元组匹配。
2. 安装器测试把 8.3 短路径喂给了要求"输入必须等于规范长形"的 fail-closed 校验（生产传的是长路径）。修法在测试侧：`fs.realpathSync.native` 先展开临时目录。同时给三处校验的报错补上 given/normalized 对照（F1.2 的教训：fail-closed 报错必须携带诊断）。

**另外解掉两个与本清单无关但挡路的存量红灯**：

- `main` 的 CI（phase1-offline）自 7 月 25 日起持续红：`portability-check` 的 `windows-drive-path` 命中审计报告的证据引用。修法：仅对 `docs/audit/` 豁免该单条检查。
- 密钥审计（PR 门）在 `main` 上也已是红的：redaction 夹具 sentinel `never-print-this` 的历史 blob 触发 `generic_secret_assignment`。按既有先例把该 sentinel 归类为占位符。本次合并前已在本地全量跑通该审计。

**CI 可观测性**：所有测试步骤经 `scripts/ci/run-annotated.ps1` 执行，失败时把 TAP 失败块写成 run 页面 annotation（无需登录即可读取），另有 step outcomes 汇总 annotation —— 无仓库凭据的环境（手机、外部会话）也能诊断 CI 失败。注意 GitHub pwsh 步骤会以结尾的 `$LASTEXITCODE` 判定成败，凡"预期非零退出"的步骤必须显式 `exit 0`。

## 2026-07-26 项目搁置：状态快照与恢复条件

**当前状态：搁置（shelved）。不得切生产。** 恢复工作前先读完本节。

### 为什么不能切生产

R4 终审判 **FAIL**，结论与完整证据见 [`docs/audit/R4_FINAL_CODE_REVIEW.md`](./audit/R4_FINAL_CODE_REVIEW.md)。**五条发现全部仍在 `main` 上，一条都没修。**

判 FAIL 的根本理由不是这五条本身，而是：**改动生产机的那批 PowerShell 入口在任何地方都没有测试门。** CI 只执行 `npm run test:phase1` 的 4 个文件（全仓 82 个），release/cutover 那批一个都不在内；而在非 Windows 的本机上，5 处 `assert.notEqual(status, 0)` 因 `spawnSync` ENOENT（`status === null`）而**恒真** —— 「脚本没跑」与「脚本正确退役」不可区分。所以"测试全绿"在这段链路上不构成任何证据。

这不是理论风险，当天就被证实了一次：`c399901` 引入的一行死代码让**每一次 Telegram 启动必死**（`describe()` 里引用了作用域内不存在的 `message`，`ReferenceError`），当天进 `main`、靠人肉发现。全仓有 5 个测试文件构造 Telegram adapter，**没有一个调用 `describe()`**，而那 5 个文件也都不在 CI 内。

### 恢复工作时的第一件事

翻盘清单在审计报告末尾，共 9 项，**必须按序号顺序做**。第 1 条是接线 CI，优先于所有代码修复 —— 否则后续每一项修复都只能靠人工断言，而人工断言正是本次判 FAIL 的成因。

好消息是第 1 条几乎零成本：`npm run test:orchestration` **本来就存在**，已覆盖 `release-control-plane` 与 `orchestration-release-watchdog`，CI 只是没调用它。补 `status-script`、`release-manifest`、`stable-telegram-launcher` 三个文件进该脚本，再把它加进 `.github/workflows/phase1-offline.yml` 即可。CI 已是 `windows-latest` + Python 3.12，两个环境前提都满足。

注意 CI 的 Python 3.12 **不会**复现 F5（`watchdog.py` 硬依赖 Python ≥ 3.10 却无版本声明，3.9 上导入即 `TypeError`），需另加低版本 job 或显式版本断言才守得住。

### 本次会话已完成的工作

- **修复 1 个启动致命回归**：移除 `src/adapters/channel/telegram.js` 中 `describe()` 里的死代码（`10157ae`，已合并）。修复前后均实测：`main` 上 `ReferenceError: message is not defined`，修复后正常返回。
- **审计报告归档**：`docs/audit/R4_FINAL_CODE_REVIEW.md`，含 F1/F1.4/F2/F4/F5 与翻盘清单。
- **文档入口重建**：新增 `CLAUDE.md`（AI 协作入口，自动载入）与 `AGENTS.md`（指向前者）。修正 `README.md` 第九节已完全失效的分支表（原列 5 个分支，其中 3 个在 origin 上不存在），第七节文档地图补入审计报告与设计文档。
- **根目录整理**：9 个散落的 md/txt 收敛为 1 个。删除上游继承的 `README.en.md` / `README.zh-CN.md`（来自 `c41f9bd`，描述的是微信桥接，与本项目不符；需要时从该提交取回）。
- **分支收敛**：6 个分支收为 2 个（`main` 与 `audit/r4-final-review`）。删除的 3 个是 `ahead=0` 的死分支，其 tip 均已在 `main` 历史中。
- **vendor 可执行位修正**（`b1b4377`）：两个 bin 入口原为 100644，`npm ci` 每次改成 755 导致工作区凭空变脏。

### 半成品：记忆跨机同步

**Mac 侧与 GitHub 侧已完成，Windows 侧待执行。**

私有仓库 `CyberMist123/cyberboss-memory` 已创建（private 已验证：未认证访问 API 与 raw 均返回 404），含 `.gitattributes`、`.gitignore`、`README.md`、`SETUP.md`（接入手册，命令均已实测）、`PROPOSAL.md`（设计提案与验收修正）。

**Windows 侧要做的**：按 `SETUP.md` 执行 —— 先固定 `CYBERLINK_ROOT`（这同时是 F4 的缓解措施，代码支持但未启用），再量体（`.backups/` 无清理逻辑，体量未实测），再 `git init` 并推送首次快照。

设计要点（避免恢复工作时重新踩坑）：

- `.jobs/` **必须**排除。写者租约无 host 标识、无 TTL、无 fencing token，存活检查是 `process.kill(pid, 0)`（`src/orchestration/writer-lease.js:120`），只对本机 PID 有意义。同步它会制造代码无法兑现的跨机互斥假象。
- `.gitattributes` 的 `* -text` **不可删**。本项目对字节敏感（全链路拒 BOM、多处 sha256 比对），行尾转换会静默破坏哈希。
- 密钥**不走**该仓库。`keys.local.json` 不是只读配置，生产机会自动写它（`extensions/relationship-memory/memory-kit/dashboard.py:296`）；双向同步会导致旧副本回传 → 面板 401 → `apply_keys_to_env.py` 把旧 key 刷进 `.env` → Telegram 起不来。

### 架构决定：单后端

Windows 机长期开机充当服务器，因此**不需要第二个后端**。Mac 的定位是代码编辑与人工查看，**不运行 bot、不启用每晚的 closeout 作业** —— closeout 是唯一会自动改动 canon 的写入方，只应在 Windows 上跑。人工编辑不受此限（记忆仓库两侧均可写，收敛依赖分层策略而非锁）。

此决定也意味着：Mac 上跑不了 PowerShell 测试（即 F1），生产门只能在 Windows 机或 `windows-latest` CI 上验证 —— 这进一步说明翻盘清单第 1 条为何优先。

### 遗留的两个未审项

- `.github/workflows/secret-audit.yml` 的触发器只有 `pull_request` 与 `workflow_dispatch`，**没有 `push`**。直接推 `main` 不过密钥闸，目前只能靠本机 hook 补。
- 生产实际面板入口 `dashboard_continuity.py` 的**写入面从未被审查**（仅旧 `dashboard.py` 审过）。在考虑任何形式的 520 远程访问之前必须补审。

## 2026-07-20 Configurable desire schedule and 520 time display

- Desire check-ins remain on the existing model, Telegram binding, SessionStore thread, MCP configuration, tool set, and full eight-dimensional prompt/context. No short thread, model switch, retry/fallback, input/output cap, or MCP reduction was added.
- The scheduler uses a fixed 55-minute plan clock. The next plan is derived from the prior planned start, not completion time; after sleep/resume missed intervals are skipped rather than replayed. A pending queue or active marker produces privacy-safe `overlap_skipped` telemetry and never queues a concurrent run.
- 520 now exposes an authenticated controlled schedule endpoint and form. It stores `timezone` as IANA (default `Australia/Sydney`), `night_skip_enabled`, `night_start`, `night_end`, and fixed `interval_minutes: 55` under the existing dashboard state directory. Saves use atomic replacement, backup, revision conflict protection, and audit rows containing only hashes, source, and IANA timezone.
- Night intervals support cross-midnight windows; equal start/end explicitly means no active skip interval. Backend and frontend use the same IANA zone. API timestamps are explicit UTC ISO 8601, while schedule-related display uses the configured zone and actual offset, including DST.
- The page displays enabled state, cadence, night settings, IANA zone, Windows-style searchable timezone options, actual offset, local time, current night status, next plan, and last telemetry outcome. Saved changes report “next round” dynamic effect and do not interrupt an active call.
- New fixture coverage includes 55-minute no-drift planning, overlap/night/equal-boundary behavior, Sydney offset handling, schedule validation/backup/revision/audit, authenticated dashboard save/conflict behavior, and UTC-to-configured-zone display.

## 2026-07-20 Conversational runtime cost boundaries

- `CYBERBOSS_WORKSPACE` remains the formal system workspace: it continues to own Telegram bindings, SessionStore identity, `.mcp.json` generation, tool registration, source and deployment lookup. `CYBERBOSS_AGENT_CWD` is a separate conversation-process cwd and defaults to the canonical `CYBERBOSS_MEMORY_DIR` (the manifest memory path); it is never substituted into SessionStore or MCP configuration.
- New Claude conversation and isolated background processes use `agentCwd`; the fixture confirms the system workspace keeps `.mcp.json` while the memory cwd does not acquire it. This prevents a new conversation from naturally listing sibling project directories through its cwd. The existing Re-entry, Live State, persona, continuity and 520 paths are unchanged.
- Offline fixture measurement, before/after: opening prompt `15 -> 15` characters; opening context blocks `2 -> 2`; explicit files read before startup `0 -> 0`; cwd-visible top-level paths `3 -> 0`; the fixture prompt contains no project/directory exploration instruction. These are local fixture measurements only, not API billing, token savings, cache rates, or live-model cost claims.
- `desire_checkin` can now append privacy-limited usage telemetry only when `CYBERBOSS_DESIRE_TELEMETRY=1`; when disabled it does not create or write a file. Fields are timestamp, event type, irreversible event-ID hash, model, reused-session flag, input/cache-read/cache-create/output/reasoning tokens (unavailable values are `null`), duration, and success/error outcome. It never writes message/prompt/thought/memory/tool-output text, paths, credentials, or environment values.
- `CYBERBOSS_DESIRE_DRIVEN` remains unchanged and is still the master zero-call gate: when it is `0`, the hourly desire poller exits before resolving targets, queueing, or invoking a model. This work does not enable eight-dimensional desire, change the 55-minute cadence, alter live scheduling, switch models, deploy, or run a live smoke.
- User decision remains required before any future policy change: (1) 55-minute frequency, (2) skip or lower frequency overnight, (3) reuse a long thread versus a separate short context and/or a cheaper model.

## 2026-07-20 Fable wishlist completion

- Re-entry 注入在不改写 canon 的前提下附加 Episode 数量/最早月份元信息，并支持 `until` 过期钩子；该元信息不计入 300 字预算。
- `memory.note` 经 ToolHost/MCP 暴露，向 canonical `ai_self_notes.md` 受控追加；服务端按自然日强制 10 条额度，使用 writer lease、备份、原子替换与只含 hash/长度的审计。Self-note 默认不注入普通聊天。
- `memory_lookup` 支持 user_pull、resonance、stakes、repair；resonance/stakes 每 session 共享一次，repair 不消耗该额度但仍受五次故障环。来源包含 Episodes、relationship timeline 和 topics 别名；不读取 Self-note 或 rereadings。
- Weekly Reflect 以 Shanghai 自然周 checkpoint、writer lease 与稳定 idempotency marker 选择旧 Episode、读取有限近期 Self-note，并且仅在主体 runtime 有新理解时追加 `rereadings.md`。它不改 Episode、Portrait、Re-entry 或 Desire；rereadings 默认隐藏且不是 lookup 来源。
- `CYBERBOSS_AUTO_REVIEW_MODEL=off` 保留确定性来源、长度、安全、权限和重复检查，不调用模型 Review。现有 nightly writer lease 已支持跨进程排他与 stale 恢复；Janitor 子进程已有明确 timeout。
- Soft Retrieval 仍未启用；上述仅经临时 fixture 离线验证，尚需 live smoke（不在本次执行）。

Last updated: 2026-07-13

## 2026-07-13 Portability and migration verification

- The legacy 118-file memory set was safely copied into the unified memory root; the old workspace has not been deleted or archived.
- The canonical `episodes.jsonl` contains 11 valid Episodes, and the canonical candidate JSONL is valid under the standard UTF-8 parser. The earlier PowerShell validation failure was an encoding/parser false positive.
- Phase 5A `memory_lookup` offline tests pass. Phase 5B Soft Retrieval remains disabled and is not connected to Telegram or real replies.
- The 520 Context Manager implementation is committed on the implementation branch, including layered context UI, snapshots, TODO backup, API boundaries, and dashboard tests.
- Portability check passes after replacing a machine-specific path example with a repository placeholder. No runtime, memory, settings, sessions, secrets, or logs were added to Git.
- Full local gates pass: `npm run check`, `npm run test:phase1` through `npm run test:phase5a`, Python dashboard/context-manager tests, and `git diff --check`.

## 2026-07-12 Continuity Liveness Cutover

- Adjudication change: the operational continuity root moves to the workspace `memory\` directory, per workspace `FRAMEWORK.md` which names it the single formal home for Episodes/Re-entry/Candidates/Decisions. Startup preflight now allows `CYBERBOSS_CONTINUITY_DIR` to exactly equal `CYBERBOSS_MEMORY_DIR` only while all four legacy memory gates stay off; nesting or partial overlap remains forbidden. This supersedes the Phase 2 note that the target must be outside the legacy memory directory.
- Current State now also summarizes the live desire-report shape `{most_want, drives[]}`; the legacy `intent` shape keeps priority when present.
- `memory_lookup` tokenizes multi-word queries (full-phrase hit > all-token hit > partial hit, stable order for ties). Single-word behavior is unchanged; budgets, supersession, and honest-empty semantics are unchanged.
- `scripts/continuity/migrate-legacy-candidates.js` converts v1 janitor extractions (root `episodes.candidates.jsonl`, rich schema) into the frozen Phase 3 candidate schema under `candidates/`, skipping titles already in canon; bodies keep anchor quotes verbatim; unlocatable sources stay honest and defer at review.
- `scripts/windows/continuity-nightly.ps1` runs the closeout -> janitor -> review -> history chain via `run-phase3.js all`, loading paths from the cyberlink manifest and the Auto Review DeepSeek key from the soft-retrieval env file.

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
  - 测试：`cd tools/soft-retrieval-replay && python -m unittest discover -s tests` — 33/33 通过（HARNESS §8 十三条清单 + 附加案例 + 独立审计新增的路径守卫专项测试 9 条 + dynamic alpha/MMR 直接单元测试 8 条），无 ResourceWarning。
  - 真实 API smoke：`python smoke_real_apis.py`（读本目录 .env，勿提交）。已实跑：Gemini embedding 调用返回 HTTP 404，embedding API 未验证通过；DeepSeek 适配器同样未经真实调用验证。本次修复不对适配器是否存在缺陷下结论——不断言"属环境限制而非适配器缺陷"，需在本机复核请求 URL / 模型名 / 密钥后重新验证一次，方可用于真实回放。
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
