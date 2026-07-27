# Current Status

> **这是本仓库唯一的当前进度真相。** README、CLAUDE.md、架构文档一律不重复这里的结论，只链接过来。
> 历史过程见 `docs/archive/`；能不能切生产的判据见本文件末尾，不看别处。

| 字段 | 值 |
| --- | --- |
| 快照对应 main | `5aaeab8`（`fix(telegram): return the model-facing envelope to plaintext`） |
| 快照日期 | 2026-07-27 |
| 主 CI workflow | `.github/workflows/phase1-offline.yml`（windows-latest） |
| **是否允许切生产** | **否** —— 见第五节 |
| **G1（Telegram memory_context）** | **FAIL** —— 见 P0-1 |

* * *

## 一、能力表

口径说明，四列各自的含义是固定的，不许模糊：

- **代码**：源文件存在**并且**被主链引用（`src/core/app.js` 或其调用链能到达）。存在但无人引用记 `孤儿`。
- **测试**：有对应 `test/*.test.js` 或 `memory-kit/tests/test_*.py`。
- **主 CI**：该测试文件在 `phase1-offline.yml` 实际跑的六个步骤（`test:phase1` / `phase2` / `phase3` / `phase4` / `phase5a` / `orchestration`）里。**不在 \= 无 CI 信号**，哪怕本地能跑绿。
- **生产接线**：Windows 生产机上真的会执行。真机才能确认的一律写 `未核`，不写 ✅。

| 能力 | 代码 | 测试 | 主 CI | 生产接线 | 当前结论 |
| --- | --- | --- | --- | --- | --- |
| Telegram 主链（poller / adapter / payload） | ✅ | ✅ | ✅ | 未核 | 可用 |
| Telegram route lanes v2 / profile router | ✅ | ✅ 13 文件 | ❌ | 未核 | **有测试，无 CI 信号** |
| Telegram 媒体入站（media inbox） | ✅ | ✅ 4 文件 | ❌ | 未核 | **有测试，无 CI 信号** |
| Hard context · Re-entry | ✅ | ✅ | ✅ | 未核 | **CONNECTED** |
| Hard context · Current State | ✅ | ✅ | ✅ | 未核 | **CONNECTED** |
| Hard context · memory_context（Telegram） | ⚠️ 代码不可达 | ✅ 单测 | ✅ | ❌ | **DISCONNECTED · G1 FAIL** |
| memory_context 按需检索（skip / state_only / targeted） | ✅ | ✅ | ✅ | ❌ Telegram 上不执行 | 逻辑正确，**通路断开** |
| Context Trace 覆盖 memory_context | ❌ | ❌ | ❌ | ❌ | **trace 结构上不含该块** |
| `memory_lookup`（Phase 5A，仅 user_pull） | ✅ | ✅ | ✅ | 未核 | 可用 |
| 工具按需取用（timeline / weather / diary / sticker 等） | ✅ | 部分 | 部分 | 未核 | 可用 |
| MCP 工具分组隐藏（省 schema token） | ❌ | ❌ | ❌ | ❌ | **未开始** |
| Memory 目录化（只注入目录，正文靠翻） | ❌ | ❌ | ❌ | ❌ | **未开始** |
| 子代理结果胶囊化（隔离 Work 输出） | ❌ | ❌ | ❌ | ❌ | **未开始**，当前子代理输出直接回流主上下文 |
| 记忆服务层（validator / resolver / candidate-extractor 等） | ✅ | ✅ 11 文件 | ❌ | 未核 | **有测试，无 CI 信号** |
| Closeout liveness / nightly closeout | ✅ | ✅ | ❌ | ❌ 默认关闭 | **未接通** |
| Reflect / 低频重读（rereadings） | ⚠️ 孤儿 | ✅ | ❌ | ❌ | **0，无调度器也无 runtime.reflect 实现** |
| `/effort` | ✅ | ✅ | ✅ | 未核 | 可用 |
| Desire（八维状态 + hourly poller） | ✅ | ✅ | ✅ | 未核 | 可用 |
| 520 · 只读视图与健康度 | ✅ | ✅ 6 个 py | ✅ | 未核 | 可用 |
| 520 · 活跃写端点（提示词 / 分层 / 门控 / 调度） | ✅ | 部分 | 部分 | 未核 | 可用，测试覆盖不全 |
| 520 · 按设计冻结的写端点（5 个） | ✅ | ✅ | ✅ | 冻结中 | 按设计冻结 |
| 520 · 关怀页写路径（care config / cycle） | 后端 ✅ 前端 ❌ | 部分 | 部分 | ❌ 待补前端 | **未完成，非安全边界** |
| 520 · 剧场页（theater scripts） | ✅ 纯只读 | ❌ | ❌ | — | 只读可用 |
| Windows release / watchdog 控制平面 | ✅ | ✅ 12 文件 | ✅ | ⚠️ 真机留证缺失 | **挡生产** |
| `fable-chat` profile 绑定 | ❌ 仅文档 | ❌ | ❌ | ❌ | **未开始** |
| Codex 作为子代理运行时 | ❌ 仅主运行时 | 部分 | ❌ | ❌ | **未开始** |
| 语音（voice-service） | ✅ 注册为工具 | 部分 | ❌ | 未核 | 能力表待补口径 |
| 天气（weather-service） | ✅ 注册为工具 | 部分 | ❌ | 未核 | 能力表待补口径 |
| embedding-service | ✅ 被 app.js 调用 | 部分 | 部分 | 未核 | 能力表待补口径 |
| Phase 5B 自动 Soft Retrieval / BM25 / reranker | ❌ | ❌ | ❌ | ❌ | 未实现（暂缓） |
| Apple Watch bridge | ❌ 仅 5 份 spec | ❌ | ❌ | ❌ | 未开始 |

**表内所有 ❌ 与「未核」都是实测结果，不是猜测。** 证据锚点：

- `npm run` 分组定义见 `package.json`；CI 实际执行的步骤见 `.github/workflows/phase1-offline.yml`。
- **G1（memory_context 断链）**：`src/core/app.js` 的 `buildRuntimeTurn()` 在 `prepared.provider === "telegram"` 时提前 `return`（约 1040 行），`resolveMemoryContextForPrepared()`（953 行）位于该 return 之后，**Telegram turn 永远不执行它**。Telegram 的模型输入由 `formatTelegramRuntimeText()`（3390 行）构造，只含 `<channel>` 信封 + 正文 + `<media>` 引用。
- **Re-entry / Current State 为什么仍然连通**：它们不走 `buildRuntimeTurn`，而是由运行时适配器调 `prepareOpeningContext()`（`claudecode/index.js:895`、`codex/index.js:245/276`）注入。这是两条独立通路 —— 所以「三门」不是一个整体，必须分行记。
- **Context Trace 的结构性缺口**：`recordContextTrace()` 记录的是运行时适配器返回的 `continuity`，其 block type 只有 `reentry` 与 `current_state`（见 `src/core/hard-context.js`）。`memory_context` 在全仓只作为 gate 键存在，从未作为 trace block 出现 —— **这不是 Telegram 独有，任何 provider 的 trace 都不解释 memory_context**。
- Reflect：`src/continuity/weekly-reflect.js` 除自身测试外无任何引用方，且其依赖的 `runtime.reflect()` 无实现。
- `fable` 在 `src/` 里只出现在 `weekly-reflect.js` 与 `memory-note-service.js` 的 writer-lease 元数据字符串（`phase:"fable"`），不是 chat profile。
- nightly：`CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED` / `CYBERBOSS_CANON_LIVENESS_ENABLED` / `CYBERBOSS_RECALL_LIVENESS_ENABLED` 在 `src/core/config.js` 默认全为 `false`。
- 520 写端点分层见 `dashboard.py` 的 `FROZEN_WRITE_ENDPOINTS`；完整端点表与三档取用方式见 `docs/architecture/SYSTEM_OVERVIEW.md` 第四、七节。

## 二、当前 P0

### P0-1 · G1 FAIL：Telegram 上的 memory_context 通路断开

**这是当前最高优先级的功能缺陷，不是文档问题。**

`src/core/app.js` 的 `buildRuntimeTurn()` 对 `provider === "telegram"` 提前 return，`resolveMemoryContextForPrepared()` 在该 return 之后 —— Telegram 的每一轮都不执行记忆检索。Telegram 送进模型的文本由 `formatTelegramRuntimeText()` 构造，只有 `<channel>` 信封、用户原文和 `<media>` 引用。

后果：

- `memory-resolver` 的四种模式、六个槽位、七日记忆、pending promise、location 注入 —— 在 Telegram 上**全部不生效**；
- `context-gates.json` 的 `memory_context` 开关在 Telegram 上是空开关；
- Context Trace 看不到这一块，所以从 trace 也发现不了它没跑。

**修复时的已知风险**：这个 early return 与 `<channel>` 明文信封是同一段代码（近期提交 `51a8a83` / `5aaeab8` 刚把模型可见信封改回明文）。直接删掉 return 会同时把 `resolveVisionContext` 拉回 Telegram 路径并改变信封形状。修法必须显式决定：memory_context 拼在信封的哪一侧、要不要同时恢复 vision context。**改这里必须配一条钉住信封格式的测试。**

### P0-2 · Context Trace 结构上不覆盖 memory_context

`recordContextTrace()` 只记录运行时适配器返回的 `continuity`，其 block type 仅 `reentry` / `current_state`。`memory_context` 在全仓只作为 gate 键存在，从未作为 trace block 出现。

这不是 Telegram 独有的问题。README 那条「Context Trace 无法解释实际上下文 = 一级腐化信号」目前对所有 provider 都成立。修 P0-1 时必须一并把 memory_context 写进 trace，否则修完也无法验证。

### P0-3 · CI 只覆盖 37/85 个测试文件

48 个测试文件不在任何 CI 步骤里，改动它们覆盖的代码**不会有任何 CI 信号**。缺口按域：

| 域 | 未进 CI 的测试文件数 | 对应分组 |
|---|---|---|
| Telegram / route lane | 9 | `test:route-lanes`、`test:telegram-media` 整组未接 |
| 记忆链 / closeout | 12 | `test:p0-closeout-liveness` 整组未接 |
| 运行时适配器（claudecode / codex） | 11 | 无分组 |
| 其他（timeline / tool-host / sticker 等） | 16 | 无分组 |

这是「合并进 main ≠ 有人验证过」的结构性来源。

### P0-4 · 真 Windows 生产机 release/cutover 留证缺失

R4 终审翻盘清单第 3 条。代码侧 1/2/4/5/6/7/8/9 已全部合入 main，windows-latest CI 的首轮证据已有，**真机留证未补**。

---

## 三、当前 P1

- **P1-1 · Reflect 从未接通**：`weekly-reflect.js` 是孤儿代码，缺调度器、缺 `runtime.reflect()` 实现方。README 主张的 `episodes → 低频重读 → 理解变化 → Re-entry 姿态变化` 断在第二步。
- **P1-2 · nightly closeout 未接生产**：代码与测试都在，`CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED` 等三个开关默认关闭，生产机上从未启用。后台 memory owner 与 nightly 的边界需与 P0-1 一并裁定。
- **P1-3 · `fable-chat` 未绑定**：设计交接在 `docs/design/HANDOFF-P0-FABLE-CHAT-PROFILE.md`，代码侧零实现。
- **P1-4 · 语音 / 天气 / embedding 的能力口径待补**：`voice-service.js`、`weather-service.js`（经 `create-project-tooling.js` 注册为工具）、`embedding-service.js`（由 `app.js` 调用）都已存在且被引用，需要逐项裁决是承认已实现还是撤掉代码，并把结论写进第一节能力表。**README 不再参与能力状态判定。**
- **P1-5 · 520 活跃写端点缺测试与 CI**：冻结名单有 `test_dashboard_write_freeze.py` 守着，但提示词保存、分层快照 / 回滚、门控切换这些真正会改生产行为的端点覆盖不完整。
- **P1-6 · 上下文预算的三处未做**：MCP 工具分组隐藏、Memory 目录化、子代理结果胶囊化。

### 已澄清，不再是待办

**旧 launch-profile plumbing / selector 分支已被 main 的 lanes-v2 取代。** 不存在等待集成的补丁：仓库与工作区没有 `launch-profile` 相关的 patch 文件，origin 上没有对应分支，工作区的 472 个「已修改」文件经逐字节比对全部只是 CRLF 差异。**历史分支不得倒灌 main。**

---

## 四、优先级

```text
NOW
- 完成本次文档真相收口

NEXT
- Telegram Memory Context 修复（G1）
- Context Trace 覆盖 memory_context（G1 的验收前提）
- 后台 memory owner / nightly 边界

LATER
- Chat Profile A/B
- 最小 Chat Profile
- Windows 最终 canary

PARALLEL GATE
- R4 真 Windows 留证
- CI 缺口接线（route-lanes / telegram-media / p0-closeout-liveness）

DEFERRED
- Soft Retrieval
- Route 1 / Route 2
- 多 Bot
- Apple Watch
- CMX
```

**PARALLEL GATE 里的两项可以与 NEXT 并行推进，但不能替代 G1/G2。** 文档合并后直接去做 CI 接线和 Windows 留证、跳过 Telegram Memory Context，是本文件明确要防止的走法。

---

## 五、切生产判据

同时满足下列全部条件才允许切生产，缺一不可：

0. **G1 通过**：Telegram 上 memory_context 实际执行，且 Context Trace 能证明它执行了。当前 FAIL；
1. R4 翻盘清单第 3 条已补：真 Windows 生产机的 release/cutover 测试完整输出已归档进 `docs/audit/`；
2. 生产机启动项已固化 `CYBERLINK_ROOT`（否则 `start-dashboard.ps1` / `start-telegram.ps1` fail-closed）；
3. 启动 watchdog 的入口显式传 `--descriptor`（`watchdog.py` 已删除祖先探测与 cwd 兜底，该参数必填）；
4. 上表中「生产接线」列没有任何 `未核` 的能力被计入放行范围。

**当前状态：条件 0 与条件 1 均未满足。不得切生产。**

* * *

## 六、维护规则

- 一个功能 PR 合并时，只改本文件对应的**那一行**。不要同时改 README、CLAUDE.md 或架构文档 —— 它们里没有状态结论可改。
- 本文件只保留**当前**结论。旧结论移进 `docs/archive/`，不在这里留时间线。
- 「代码存在」永远不等于「已接生产」。拿不准就写 `未核`，不要写 ✅。
