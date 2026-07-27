# Current Status

> **这是本仓库唯一的当前进度真相。** README、CLAUDE.md、架构文档一律不重复这里的结论，只链接过来。
> 历史过程见 `docs/archive/`；能不能切生产的判据见本文件末尾，不看别处。

| 字段 | 值 |
| --- | --- |
| 快照对应 main | `5aaeab8`（`fix(telegram): return the model-facing envelope to plaintext`） |
| 快照日期 | 2026\-07\-27 |
| 主 CI workflow | `.github/workflows/phase1-offline.yml`（windows\-latest） |
| **是否允许切生产** | **否** —— 见「切生产判据」 |

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
| Hard context 三门（reentry / current\_state / memory\_context） | ✅ | ✅ | ✅ | 未核 | 可用，真机 Context Trace 待留证 |
| memory\_context 按需检索（skip / state\_only / targeted） | ✅ | ✅ | ✅ | 未核 | 可用，纯规则匹配 |
| `memory_lookup`（Phase 5A，仅 user\_pull） | ✅ | ✅ | ✅ | 未核 | 可用 |
| 工具按需取用（timeline / weather / diary / sticker 等） | ✅ | 部分 | 部分 | 未核 | 可用 |
| MCP 工具分组隐藏（省 schema token） | ❌ | ❌ | ❌ | ❌ | **未开始** |
| Memory 目录化（只注入目录，正文靠翻） | ❌ | ❌ | ❌ | ❌ | **未开始** |
| 子代理结果胶囊化（隔离 Work 输出） | ❌ | ❌ | ❌ | ❌ | **未开始**，当前子代理输出直接回流主上下文 |
| 记忆服务层（validator / resolver / candidate\-extractor 等） | ✅ | ✅ 11 文件 | ❌ | 未核 | **有测试，无 CI 信号** |
| Closeout liveness / nightly closeout | ✅ | ✅ | ❌ | ❌ 默认关闭 | **未接通** |
| Reflect / 低频重读（rereadings） | ⚠️ 孤儿 | ✅ | ❌ | ❌ | **0，无调度器也无 runtime.reflect 实现** |
| `/effort` | ✅ | ✅ | ✅ | 未核 | 可用 |
| Desire（八维状态 \+ hourly poller） | ✅ | ✅ | ✅ | 未核 | 可用 |
| 520 · 只读视图与健康度 | ✅ | ✅ 6 个 py | ✅ | 未核 | 可用 |
| 520 · 活跃写端点（提示词 / 分层 / 门控 / 调度） | ✅ | 部分 | 部分 | 未核 | 可用，测试覆盖不全 |
| 520 · 按设计冻结的写端点（5 个） | ✅ | ✅ | ✅ | 冻结中 | 按设计冻结 |
| 520 · 关怀页写路径（care config / cycle） | 后端 ✅ 前端 ❌ | 部分 | 部分 | ❌ 待补前端 | **未完成，非安全边界** |
| 520 · 剧场页（theater scripts） | ✅ 纯只读 | ❌ | ❌ | — | 只读可用 |
| Windows release / watchdog 控制平面 | ✅ | ✅ 12 文件 | ✅ | ⚠️ 真机留证缺失 | **挡生产** |
| `fable-chat` profile 绑定 | ❌ 仅文档 | ❌ | ❌ | ❌ | **未开始** |
| Codex 作为子代理运行时 | ❌ 仅主运行时 | 部分 | ❌ | ❌ | **未开始** |
| Phase 5B 自动 Soft Retrieval / BM25 / reranker | ❌ | ❌ | ❌ | ❌ | 未实现（暂缓） |
| Apple Watch bridge | ❌ 仅 5 份 spec | ❌ | ❌ | ❌ | 未开始 |

**表内所有 ❌ 与「未核」都是实测结果，不是猜测。** 证据锚点：

- `npm run` 分组定义见 `package.json`；CI 实际执行的步骤见 `.github/workflows/phase1-offline.yml`。
- Reflect：`src/continuity/weekly-reflect.js` 除自身测试外无任何引用方，且其依赖的 `runtime.reflect()` 无实现。
- `fable` 在 `src/` 里只出现在 `weekly-reflect.js` 与 `memory-note-service.js` 的 writer\-lease 元数据字符串（`phase:"fable"`），不是 chat profile。
- nightly：`CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED` / `CYBERBOSS_CANON_LIVENESS_ENABLED` / `CYBERBOSS_RECALL_LIVENESS_ENABLED` 在 `src/core/config.js` 默认全为 `false`。
- 520 写端点分层见 `dashboard.py` 的 `FROZEN_WRITE_ENDPOINTS`；完整端点表与三档取用方式见 `docs/architecture/SYSTEM_OVERVIEW.md` 第四、七节。

## 二、当前 P0

### P0\-1 · 真 Windows 生产机 release/cutover 留证缺失

R4 终审翻盘清单第 3 条。代码侧 1/2/4/5/6/7/8/9 已全部合入 main，windows\-latest CI 的首轮证据已有，**真机留证未补**。补齐前不得切生产。

### P0\-2 · CI 只覆盖 37/85 个测试文件

48 个测试文件不在任何 CI 步骤里，改动它们覆盖的代码**不会有任何 CI 信号**。缺口按域：

| 域 | 未进 CI 的测试文件数 | 对应分组 |
| --- | --- | --- |
| Telegram / route lane | 9 | `test:route-lanes`、`test:telegram-media` 整组未接 |
| 记忆链 / closeout | 12 | `test:p0-closeout-liveness` 整组未接 |
| 运行时适配器（claudecode / codex） | 11 | 无分组 |
| 其他（timeline / tool\-host / sticker 等） | 16 | 无分组 |

这是「合并进 main ≠ 有人验证过」的结构性来源，比任何单个 bug 都值钱。

* * *

## 三、当前 P1

- **P1\-1 · nightly closeout 未接生产**：代码与测试都在，三个开关默认关闭，生产机上从未启用。
- **P1\-2 · Reflect 从未接通**：`weekly-reflect.js` 是孤儿代码，缺调度器、缺 `runtime.reflect()` 实现方。README 主张的 `episodes → 低频重读 → 理解变化 → Re-entry 姿态变化` 这条链断在第二步。
- **P1\-3 · `fable-chat` 未绑定**：`docs/design/HANDOFF-P0-FABLE-CHAT-PROFILE.md` 是设计交接，代码侧零实现。Token A/B 也尚未开始。
- **P1\-4 · 本地 launch\-profile 补丁未保全**：工作区存在未提交改动，需确认是内容改动还是换行符 churn 后再决定合并或丢弃。
- **P1\-5 · README 的「暂缓清单」与实际代码冲突**：README 把语音、天气、embedding 列为「明确暂缓，不得顺手实现」，但 `src/services/voice-service.js`、`weather-service.js`（经 `create-project-tooling.js` 注册为工具）、`embedding-service.js`（由 `app.js` 调用）都已存在且被引用。**需要逐项裁决：是承认已实现（写进上表），还是承认越界（撤掉代码）。** 裁决前「暂缓」二字对 Agent 没有约束力。
- **P1\-6 · 520 活跃写端点缺测试与 CI**：冻结名单有 `test_dashboard_write_freeze.py` 守着，但提示词保存、分层快照 / 回滚、门控切换这些**真正会改生产行为**的端点，覆盖不完整。
- **P1\-7 · 上下文预算的三处未做**：MCP 工具分组隐藏、Memory 目录化、子代理结果胶囊化。三者都属于「省 Token」这条主线，当前只有 `memory-resolver` 的四模式在起作用。

## 四、下一步（最多三项，做完再排新的）

1. **文档收口**：README 去动态状态、`IMPLEMENTATION_STATUS.md` 归档、CLAUDE.md 精简 —— 即本文件所在的这次改动。
2. **补 CI 缺口**：把 `test:route-lanes`、`test:telegram-media`、`test:p0-closeout-liveness` 接进 `phase1-offline.yml`。接线前先在本地跑一轮，接线本身可能立刻抓到真实缺陷（清单 1 的先例：接线当天抓到两个 Windows 缺陷）。
3. **补真 Windows 留证**：在生产机跑一轮 release/cutover 测试，完整输出归档进 `docs/audit/`。

**这三项完成前，冻结新功能。**

* * *

## 五、切生产判据

同时满足下列全部条件才允许切生产，缺一不可：

1. R4 翻盘清单第 3 条已补：真 Windows 生产机的 release/cutover 测试完整输出已归档进 `docs/audit/`；
2. 生产机启动项已固化 `CYBERLINK_ROOT`（否则 `start-dashboard.ps1` / `start-telegram.ps1` fail\-closed）；
3. 启动 watchdog 的入口显式传 `--descriptor`（`watchdog.py` 已删除祖先探测与 cwd 兜底，该参数必填）；
4. 上表中「生产接线」列没有任何 `未核` 的能力被计入放行范围。

**当前状态：条件 1 未满足。不得切生产。**

* * *

## 六、维护规则

- 一个功能 PR 合并时，只改本文件对应的**那一行**。不要同时改 README、CLAUDE.md 或架构文档 —— 它们里没有状态结论可改。
- 本文件只保留**当前**结论。旧结论移进 `docs/archive/`，不在这里留时间线。
- 「代码存在」永远不等于「已接生产」。拿不准就写 `未核`，不要写 ✅。
