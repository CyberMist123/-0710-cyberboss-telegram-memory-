# Decisions

```text
Status: active
Authority: approved decisions
Current status: docs/CURRENT_STATUS.md
```

> **这份文件记录已经作出的决定，以及被取代的决定。**
> 它不记录进度（那在 `CURRENT_STATUS.md`），也不记录结构（那在 `docs/architecture/`）。
> 存在的理由：这个项目的决定翻转过好几次，没有这份清单，下一个 Agent 只能从 Design、Review、Handoff 和 issue 时间线里猜。

## 怎么写一条决定

每条正式决定的第一行必须是：

```text
Status: ACTIVE | SUPERSEDED | DEFERRED
Decision date: YYYY-MM-DD
Last reviewed: YYYY-MM-DD        # 仅在复核过且结论未变时补
```

- `ACTIVE`（当前有效）—— 执行者必须遵守。
- `SUPERSEDED`（已被后续决定取代）—— 保留历史，但**不得继续执行**。
- `DEFERRED`（已决定暂缓）—— 方向可能成立，但当前不得施工。

三条纪律：

1. **一条决定被取代时，把原条目标 `SUPERSEDED` 并新增一条，不要原地改写。** 翻转本身是信息。
2. **编号只增不重排。** 删掉一条决定就让编号留空缺，不要把后面的往前挪 —— 外部引用会断。
3. **尚未决定的内容不得占用 D 编号**，放进文末「待裁决 / Candidates」。不要写「感觉没用」「做了一半」「待考察」「以后看看」这类编辑备注 —— 那不是可执行的决定。

D1–D12 于 2026-07-27 首次登记，其中多数是此前已在执行的既有做法；正文注明了各自的来源。

---

## D1 · Windows 是当前唯一生产 owner

```text
Status: ACTIVE
Decision date: 2026-07-27
```

Windows 机长期开机充当服务器，是当前唯一生产 owner。

**当前不实现跨机生产同步。** `deployment/current.json` 与 `runtime/` 是**机器状态**，不得直接或盲目同步到另一台机器。

未来若要设计跨机能力，必须使用独立的状态复制与冲突处理契约，**不能直接复制这两个路径**。本条不封死跨机方向，只封死"照搬机器状态文件"这一种做法。

## D2 · 状态真相唯一：`docs/CURRENT_STATUS.md`

```text
Status: ACTIVE
Decision date: 2026-07-27
```

README、`CLAUDE.md`、架构文档都不写「做到哪一步 / 能不能切生产」，只链接过去。同一结论写在多处必然分叉 —— 这是本项目已经发生过的事故，不是假设。

## D3 · 合并进 `main` ≠ 批准部署

```text
Status: ACTIVE
Decision date: 2026-07-27
```

放行判据只在 `CURRENT_STATUS.md` 第五节。审计报告的结论只对它审的那个 SHA 有效。

## D4 · 单 writer；记忆链 fail-open

```text
Status: ACTIVE
Decision date: 2026-07-27
```

每份文件只有一个写入者（写入权表见 `docs/architecture/SYSTEM_OVERVIEW.md`）。同一文件出现第二个 writer 是一级腐化信号。

链路全程 fail-open：**宁可本轮失忆，不可本轮失联。**

## D5 · 候选与正式分离是全局禁区

```text
Status: ACTIVE
Decision date: 2026-07-27
```

任何路径都不许让外部直接写 `episodes.jsonl` 正式档。520 的 API 桥因此冻结了 `/api/save`、`/api/state_log`、`/api/episode_candidate`、`/api/janitor/run`、`/api/config` 五个端点。

同名单里的两个 `care` 端点是**前端未接完**，不属于本条决定；补前端时可一并解冻。

## D6 · 记忆检索用纯规则槽位，不用 embedding / 相似度

```text
Status: ACTIVE
Decision date: 2026-07-27
```

`memory-intent-classifier.js` 用正则表决定六个槽位（`identity` / `relationship` / `preference` / `project` / `pattern` / `pending_promise`），`memory-resolver.js` 据此选 `skip` / `state_only` / `targeted`。

理由是便宜、可解释、可测试。自动 Soft Retrieval、embedding 召回、BM25、reranker、GraphRAG 属 Phase 5B，**暂缓**。

`src/services/embedding-service.js` 存在且被 `app.js` 调用 —— 它与本条的边界**尚未裁决**，见文末 Candidate C1。

## D7 · 默认隐藏 ≠ 不可查询；只开放 `user_pull` 一种翻档

```text
Status: ACTIVE
Decision date: 2026-07-27
```

Episodes 及下游旧档默认不进普通对话上下文。用户明确寻找旧事时，AI 可通过 `memory_lookup` 受控查询。

AI 自己因共鸣、利害或修复需要主动翻档，**未开放** —— 必须等真实 `why_now`、查询日志与翻错案例。

（模糊检索是否加入 `memory_lookup`，见 Candidate C2。本条只批准字面查询。）

## D8 · 不许向上摸目录找根

```text
Status: ACTIVE
Decision date: 2026-07-26
```

`start-telegram.ps1` / `start-dashboard.ps1` 删除祖先回溯，`CYBERLINK_ROOT` 必填并校验；`watchdog.py` 删除 `DEFAULT_DESCRIPTOR`，`--descriptor` 必填。

来源是 R4 F4：祖先回溯让一个诱饵目录就能决定被执行的 Python 文件与密钥路径。

## D9 · Telegram 送给模型的信封是明文

```text
Status: ACTIVE
Decision date: 2026-07-27
```

`formatTelegramRuntimeText()` 产出 `<channel source="telegram" …>` 信封 + 用户原文 + `<media>` 引用。用户打的字就是模型读到的字，只转义可能提前闭合信封的序列。

**这条与 G1（memory_context 断链）耦合**：修 G1 时改的是同一段代码，必须显式决定 memory_context 拼在信封哪一侧，并配一条钉住信封格式的测试。见 `CURRENT_STATUS.md` 第四节。

（"把历史对话脱水成 Markdown"不属于本条，见 Candidate C3。）

## D10 · 旧 launch-profile plumbing / selector 分支不倒灌 `main`

```text
Status: ACTIVE
Decision date: 2026-07-27
```

该方向已被 main 的 route lanes v2 超集重写替代。仓库与工作区不存在等待集成的 launch-profile 补丁，origin 上没有对应分支。**历史分支不得 cherry-pick 回 main。**

## D11

*（编号保留，条目已移除。`/effort` 是否实现属于代码事实与 `CURRENT_STATUS.md` 的能力表，不需要作为长期决定维护。编号不重排。）*

## D12 · README 是稳定项目说明，不维护动态能力状态

```text
Status: ACTIVE
Decision date: 2026-07-27
```

**原做法（已取代）**：暂缓项清单写在 README 的「明确暂缓，不得顺手实现」一节。该清单与实际代码出现过五处冲突（语音、天气、关怀、剧场、embedding），已从 README 移除。

**现规则**：

- README 是**稳定项目说明**，不维护动态能力状态；
- 项目定位或北极星发生变化时**可以**修改 README；
- 暂缓项与能力状态只在 `CURRENT_STATUS.md` 维护。

## D13 · 普通 Chat 不采用零工具、零 MCP

```text
Status: ACTIVE
Decision date: 2026-07-27
```

主 Chat 是**人格与调度中心**，不是纯文本回复器。它必须保留：

- 首轮 Re-entry 与轻量 Current State；
- 受控的记忆访问（`memory_lookup`）；
- 少量必要的行动能力（发送、提醒、时间、日记等）。

工程 agents、skills 与与对话无关的 MCP，应通过 **profile 隔离**来分离，而不是把主 Chat 的工具全部摘掉。

**"零工具 / 零 MCP" 是已废弃的早期降本方案，不得作为降本手段重新提出。** 降本要从上下文分档、工具分组隐藏、子代理胶囊化这些方向走，**不能靠把 Chat 削成没有行动能力的机器人**。

Route 1 / Route 2 的实现仍为 `DEFERRED`。

---

## 待裁决 / Candidates

下列**尚未做出决定**，不占用 D 编号，也不得当成已定方向施工。

### C1 · 语音 / 天气 / embedding 的能力归属

```text
Status: OPEN
```

- **Known facts**：`src/services/voice-service.js`、`weather-service.js` 经 `create-project-tooling.js` 注册为工具；`embedding-service.js` 由 `src/core/app.js` 调用。三者代码存在且部分接入。
- **Decision needed**：把它们承认为当前能力（写进 `CURRENT_STATUS.md` 能力表并给出边界），还是承认越界、缩小或移除相关路径。
- **Not authorised**：在裁决前扩大这三项的功能，或把它们在任何文档里写成"完整可用"。

### C2 · `memory_lookup` 是否增加模糊检索

```text
Status: OPEN
```

- **Known facts**：D7 当前只批准字面查询。Phase 5B 的自动召回整体暂缓。
- **Decision needed**：是否在 `memory_lookup` 内增加模糊检索。
- **Not authorised**：当前不做。需要先定义召回边界、误召回证据与 `why_now` 判据。

### C3 · 历史对话脱水为 Markdown

```text
Status: OPEN
```

- **Known facts**：设想是把历史对话压缩成 Markdown、只保留简写的工具调用，供记忆提取或检索使用。
- **Decision needed**：输入来源、保真边界、工具结果的保留规则、以及如何防止脱水产物污染 canon。
- **Not authorised**：尚未定义上述任何一项，不进入当前施工。注意 D4 的写入权约束与"记忆注入块 / 工具结果不得被重新抽成 Episode"的既有红线。

### C4 · 后台 memory owner 与 nightly closeout 的边界

```text
Status: OPEN
```

- **Known facts**：调度器已接入 `app.js`；`CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED` 等三个开关在仓库内默认 `false`；生产机实际状态仓库无法判断。这是 G2 `FAIL` 的主体。
- **Decision needed**：Closeout 之后由谁持有写入权、Review 与 History writer 的交接点、nightly 三个开关何时以及在什么证据下默认开启。
- **Not authorised**：在边界裁定前把任一开关在生产机上打开。

### C5 · 子代理运行时与输出胶囊化

```text
Status: OPEN
```

- **Known facts**：子代理的输出会回到子进程 transcript，即进入主 Chat 上下文。`src/adapters/runtime/codex/` 有完整实现，但只用于主运行时切换。
- **Decision needed**：是否把 Codex 作为子代理运行时；子代理输出以什么形式胶囊化后才回主 Chat。
- **Not authorised**：在胶囊化契约确定前扩大子代理使用范围。

### C6 · 多 Bot、Route 1 / Route 2、Apple Watch、CMX

```text
Status: OPEN
```

- **Known facts**：四者当前一律 `DEFERRED`，未排期。Apple Watch 只有 5 份规格文档，代码侧零实现。
- **Decision needed**：是否以及何时排期。
- **Not authorised**：在排期前投入实现工作。
