# Current Status

```text
Status: active
Authority: current project status
Last verified: 2026-07-29
Verified against: 9bb78a0f (main)
```

- `Status: active` —— 这份文件当前有效。
- `Authority: current project status` —— 它是当前进度的**唯一**权威来源。README、`CLAUDE.md`、架构文档都不重复这里的结论，只链接过来。
- `Last verified` —— 最后一次依据源码和运行证据核对的日期。
- `Verified against` —— 这些结论对应哪个 main commit。

历史过程见 `docs/archive/`；已定与已翻转的决定见 `docs/DECISIONS.md`。

---

## 一、Gate 总表

这张表只在本文件维护，其他文档一律链接过来，不复制。

| Gate | 状态 | 中文含义 |
|---|---|---|
| G1 Telegram 核心读取路径 | `PARTIAL` | 代码通路与 Trace 验收结构已接通，缺真机执行证据 |
| G2 后台记忆写入边界 | `FAIL` | Closeout 后的 owner、Review、History 与 nightly 边界未闭环 |
| G3 Chat 成本与 profile 隔离 | `PARTIAL` | 基础管道存在，真实 fable-chat 配置与隔离未完成 |
| G4 Windows 生产验证 | `PARTIAL` | 代码控制面基本完成，真机 release/cutover 证据缺失 |
| G5 备份与回滚验证 | `NOT_VERIFIED` | 缺少真实备份恢复演练证据 |

**是否允许切生产：否。** 判据见第五节。

---

## 二、状态词典

能力表的每一列只允许使用下列状态词。**不要自造近义词**，也不要用 ✅ / ❌ / “可用” / “部分” 这类自由文本 —— 它们在多轮 PR 之后会各自漂移。

| 维度 | 允许状态 | 中文解释 |
|---|---|---|
| 代码 | `WIRED` | 已进入目标主运行链，真实调用可达 |
| 代码 | `PARTIAL` | 只有部分 provider、lane 或路径可达 |
| 代码 | `ORPHAN` | 代码存在，但目标主路径不可达或无人调用 |
| 代码 | `ABSENT` | 没有对应实现 |
| 测试 | `COVERED` | 有针对真实目标通路的验收测试 |
| 测试 | `UNIT_ONLY` | 只有函数或组件单测，没有真实主路径测试 |
| 测试 | `PARTIAL` | 部分行为有测试，关键边界仍未覆盖 |
| 测试 | `NONE` | 无对应测试 |
| 主 CI | `BLOCKING` | 已进入阻塞合并的主 CI |
| 主 CI | `NONBLOCKING` | 有自动化信号，但不阻塞合并 |
| 主 CI | `NONE` | 无自动化 CI 信号 |
| 生产接线 | `VERIFIED` | 已在真实生产 Windows 上验证 |
| 生产接线 | `WIRED` | 已接生产入口，但尚无真机验证证据 |
| 生产接线 | `DISABLED` | 已有生产接线，但默认或当前关闭 |
| 生产接线 | `NOT_WIRED` | 没有生产接线 |
| 生产接线 | `UNKNOWN` | 仓库无法判断真机实际状态 |
| 总体结论 | `PASS` | 当前范围已满足 |
| 总体结论 | `PARTIAL` | 部分满足，但仍有明确缺口 |
| 总体结论 | `FAIL` | 当前关键目标未满足 |
| 总体结论 | `DEFERRED` | 明确不在当前阶段施工 |
| 总体结论 | `NOT_VERIFIED` | 可能已具备，但缺少所需证据 |

两条使用纪律：

1. **`BLOCKING` 是对"这条能力的目标通路"说的，不是对"某个相关单测"说的。** 一个 resolver 单测进了 CI 分组，不代表它覆盖的完整通路有 CI 信号。
2. **仓库证明不了的一律 `UNKNOWN`**，不要写成 `NOT_WIRED` 或 `DISABLED`。生产机的环境变量与计划任务状态不在版本控制内。

---

## 三、能力表

| 能力 | 代码 | 测试 | 主 CI | 生产接线 | 说明 / 当前结论 |
|---|---|---|---|---|---|
| Telegram 主链（poller / adapter / envelope） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 信封格式有 CI 测试钉住；真机运行状态未核 |
| Telegram route lanes v2 / profile router | `WIRED` | `COVERED` | `NONE` | `WIRED` | `test:route-lanes` 整组未接进主 CI |
| Telegram 媒体入站（media inbox） | `WIRED` | `COVERED` | `NONE` | `WIRED` | `test:telegram-media` 整组未接进主 CI |
| Hard context · Re-entry | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 由运行时适配器的 opening context 注入，通路正常 |
| Hard context · Current State | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 同上；与 memory_context 不是同一条通路 |
| **Telegram memory_context** | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 逻辑经 `buildRuntimeTurn()` Telegram 分支可达，信封外 `<memory_context>` 块，fail-open；真机执行证据缺失 |
| Context Trace 覆盖 memory_context | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | trace blocks / skipped 已解释 memory_context（所有 provider 的 turn 路径）；真机证据缺失 |
| `memory_lookup`（Phase 5A，仅 user_pull） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 受控翻档；真机使用情况未核 |
| 工具按需取用（timeline / weather / diary / sticker） | `WIRED` | `PARTIAL` | `NONE` | `WIRED` | 工具存在且注册，边界测试不全 |
| MCP 工具分组隐藏（省 schema token） | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` —— 降本方向，未开工 |
| Memory 目录化（注入目录而非命中行） | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` —— 降本方向，未开工 |
| 子代理结果胶囊化 | `ORPHAN` | `COVERED` | `BLOCKING` | `NOT_WIRED` | 胶囊契约与离线闭环已实现（`src/orchestration/delegation/`），验收测试在 `test:orchestration`，该分组已进主 CI。**但只有委派 runner 调用它**：主 Chat 仍直接回流子代理输出，目标通路未接。契约见 `DECISIONS.md` D14 |
| 记忆服务层（validator / resolver / extractor） | `WIRED` | `COVERED` | `NONE` | `WIRED` | 11 个测试文件全部未接进主 CI |
| Closeout liveness | `WIRED` | `COVERED` | `NONE` | `UNKNOWN` | 调度器已接入 `app.js`；生产机开关状态仓库无法判断 |
| nightly closeout | `WIRED` | `PARTIAL` | `NONE` | `UNKNOWN` | **`FAIL`** —— 仓库默认关闭；生产机实际环境变量与计划任务状态未核 |
| Reflect / 低频重读（rereadings） | `ORPHAN` | `UNIT_ONLY` | `NONE` | `NOT_WIRED` | **`FAIL`** —— 无调度器调它，`runtime.reflect()` 无实现方 |
| `/effort` | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | — |
| Desire（八维状态 + hourly poller） | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 最小闭环代码与生产落盘形态集成测试已进仓库；挂 `CYBERBOSS_DESIRE_LOOP_MINIMAL_ENABLED`，默认关闭，生产机实际开关状态由不入库的 secrets 决定 |
| 520 · 只读视图与健康度 | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 面板由独立计划任务拉起，真机状态未核 |
| 520 · 活跃写端点（提示词 / 分层 / 门控 / 调度） | `WIRED` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | 改生产行为的端点覆盖不全 |
| 520 · 安全冻结写端点（5 个） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 按设计冻结，见 `DECISIONS.md` D5 |
| 520 · 关怀页写路径（care config / cycle） | `PARTIAL` | `PARTIAL` | `NONE` | `NOT_WIRED` | 后端在、前端未接完；不是安全边界 |
| 520 · 剧场页（theater scripts） | `WIRED` | `NONE` | `NONE` | `UNKNOWN` | 纯展示只读 |
| Windows release / watchdog 控制平面 | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— 真机 release/cutover 留证缺失 |
| 备份与回滚演练 | `WIRED` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | **`NOT_VERIFIED`** —— 无真实恢复演练证据 |
| `fable-chat` profile 绑定 | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | 仅设计交接文档，代码侧零实现 |
| Codex 作为子代理运行时 | `PARTIAL` | `COVERED` | `BLOCKING` | `NOT_WIRED` | 有界委派协议与离线闭环已实现；2026-07-28 用真实 Codex 跑通一次 canary（只改 `test/`，边界成立，验收测试通过，判定 accept）。**仓库内没有把 Codex adapter 绑进委派 runner 的代码**，运行时由调用方注入，离线测试用 fake；主 Chat 未接 |
| 语音（voice-service） | `PARTIAL` | `PARTIAL` | `NONE` | `UNKNOWN` | 已注册为工具；能力口径待裁决（P1-4） |
| 天气（weather-service） | `PARTIAL` | `PARTIAL` | `NONE` | `UNKNOWN` | 同上 |
| embedding-service | `PARTIAL` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | 由 `app.js` 调用；与 D6 的边界待裁决 |
| Phase 5B 自动 Soft Retrieval / BM25 / reranker | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` |
| Apple Watch bridge | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` —— 仅 5 份规格 |

### 证据锚点

- **G1（Telegram memory_context）**：`src/core/app.js` 的 `buildRuntimeTurn()` Telegram 分支调用 `resolveMemoryContextFailOpen()`（对 `resolveMemoryContextForPrepared()` 的 fail-open 包装，解析失败降级为空记忆），memory_context 作为独立 `<memory_context>` 块拼在 `formatTelegramRuntimeText()` 产出的 `<channel>` 信封外侧上方；无记忆时不出块，payload 与旧格式逐字节一致。格式裁定见 `DECISIONS.md` D15。
- **为什么测试记 `COVERED`**：`test/telegram-runtime-payload.test.js` 新增 4 条钉住新 payload 格式（有记忆 / 无记忆 / 转义 / 信封不变），在 `test:phase1` 分组内，阻塞主 CI。
- **仍缺什么**：真机 Telegram 上 memory_context 实际执行并被 trace 记录的留证，因此 G1 记 `PARTIAL` 而非 `PASS`。
- **为什么 Re-entry / Current State 仍是 `WIRED`**：它们不走 `buildRuntimeTurn`，而是由运行时适配器调 `prepareOpeningContext()`（`claudecode/index.js:895`、`codex/index.js:245/276`）注入。两条独立通路，不能合记一行。
- **Context Trace 覆盖 memory_context**：`recordContextTrace()` 新增 memoryContext 参数，有记忆行时在 `blocks` 记 `{type:"memory_context", loaded:true, reason:<mode>, chars}`，无记忆时在 `skipped` 记 `{type:"memory_context", reason:<mode|empty>}`；`dispatchPreparedTurn` 的调用点已接入，对所有 provider 的 turn 路径生效（opening refresh 调用点行结构不变）。由 `test/phase2-hard-context.test.js` 钉住，在 `test:phase2` 分组内，阻塞主 CI。
- **为什么 nightly 的生产接线记 `UNKNOWN`**：仓库只能证明 `.env.example` 里 `CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED=false`，以及 `src/core/config.js` 的默认值为 `false`。生产机实际环境变量在 `settings/secrets/*.local.json`，不入库；计划任务状态也不在版本控制内。**因此仓库无法对生产机的历史启用情况作出任何结论 —— 这一格只能记 `UNKNOWN`。**
- **CI 覆盖**：主 CI 只执行 `.github/workflows/phase1-offline.yml` 里列出的六个 `npm run test:*` 分组。`test:route-lanes`、`test:telegram-media`、`test:p0-closeout-liveness` 整组未接。

---

## 四、优先级

```text
NOW
- Telegram Memory Context 修复（G1）—— 本 PR

NEXT
- 后台 memory owner / nightly 边界（G2）

LATER
- Chat Profile A/B
- 最小 Chat Profile
- Windows 最终 canary

PARALLEL GATE
- R4 真 Windows 留证
- CI 缺口接线（route-lanes / telegram-media / p0-closeout-liveness）
- 备份恢复演练（G5）

DEFERRED
- Soft Retrieval
- Route 1 / Route 2
- 多 Bot
- Apple Watch
- CMX
```

**PARALLEL GATE 可以与 NEXT 并行推进，但不能替代 G1 / G2。** 文档合并后直接去做 CI 接线和 Windows 留证、跳过 Telegram Memory Context，是本文件明确要防止的走法。

### G1 修复的已知风险

已消解：memory_context 的位置、vision context 不回流、fail-open 与钉格式测试均由 `DECISIONS.md` D15 裁定并落地。

---

## 五、切生产判据

同时满足下列全部条件才允许切生产，缺一不可：

0. **G1 通过**：Telegram 上 memory_context 实际执行，且 Context Trace 能证明它执行了。当前 `PARTIAL`（缺真机证据）；
1. **G2 通过**：Closeout 后的 owner、Review、History 与 nightly 边界闭环。当前 `FAIL`；
2. R4 翻盘清单第 3 条已补：真 Windows 生产机的 release/cutover 测试完整输出已归档进 `docs/audit/`；
3. 生产机启动项已固化 `CYBERLINK_ROOT`（否则 `start-dashboard.ps1` / `start-telegram.ps1` fail-closed）；
4. 启动 watchdog 的入口显式传 `--descriptor`；
5. 能力表中「生产接线」列没有任何 `UNKNOWN` 的能力被计入放行范围。

**当前状态：条件 0、1、2 均未满足。不得切生产。**

---

## 六、维护规则

- 一个功能 PR 合并时，只改本文件对应的**那一行**。不要同时改 README、`CLAUDE.md` 或架构文档 —— 它们里没有状态结论可改。
- 改动本文件时更新 `Last verified` 与 `Verified against`。**没有重新核对就不要动这两行。**
- 状态词只能取第二节词典里的值。需要新状态时先改词典并说明理由，不要就地造词。
- 本文件只保留**当前**结论，旧结论移进 `docs/archive/`。
- 补充材料（调研、实验、外部资料）发生变化**不要求**修改本文件。只有当补充材料导致当前结论变化时，才更新这里。
