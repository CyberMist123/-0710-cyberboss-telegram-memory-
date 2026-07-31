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

## D14 · 子代理输出必须经结果胶囊回主上下文；委派边界 fail-closed

```text
Status: ACTIVE
Decision date: 2026-07-28
```

子代理（当前指 Codex）的**完整 transcript 永不进入主上下文、长期记忆或 `CURRENT_STATUS.md`**。它只能通过一个**结果胶囊**回传：状态、简短结论、修改文件、执行的测试及结果、commit SHA、风险、以及给编排者的建议动作。

契约落在 `src/orchestration/delegation/`，是可执行、可测试的，不是文档约定：

- **任务规格**必须显式写明 `task_id`、`objective`、`allowed_paths`、`forbidden_paths`、`workspace`、`base_sha`、`acceptance_tests`、`timeout_ms`、`approval_policy`；
- **缺字段或 approval_policy 取值不认识 = 规格无效**，不套默认值。给审批策略兜底默认，正是有界委派变成无界委派的方式；
- **带 transcript 形状字段的胶囊直接拒收**（任意嵌套层级），不是"悄悄剥掉"——剥掉等于告诉调用方传 transcript 没关系；自由文本字段同时限长，堵住"把 transcript 塞进 summary"这条路；
- **越界检查先于验收测试**。已经越界写盘的运行不该再执行它产出的代码；
- **编排者不信任胶囊**。胶囊是主张不是证据：边界要拿编排者自己观察到的 diff 重新验一遍，文件清单对不上就 `stop`；
- 终局只有 `accept` / `rework` / `stop`，且**默认 fail-closed**：任何无法识别、对不上或缺失的情况一律 `stop`。

这里的 fail-closed 与不变量 5「记忆链 fail-open」**不冲突**：那条讲的是记忆链宁可失忆不可失联；委派是授权边界，授权边界只能 fail-closed。

**尚未批准**：把子代理接进主 Chat 的任何自动路径。本条只批准"胶囊契约 + 有界离线闭环 + 人工发起的 canary"。主 Chat 集成仍属 Candidate C5。

## D15 · memory_context 拼在 Telegram 信封外侧上方

```text
Status: ACTIVE
Decision date: 2026-07-29
```

修 G1 时对 D9 留下的三个问题作出裁定：

- **位置**：memory_context 是独立的 `<memory_context>` 块，拼在 `<channel>` 信封**外侧、上方**，一条记忆一行（`- ` 前缀），只转义可能提前闭合该块的序列。信封本身不动。
- **无记忆时不出块**：没有记忆行就完全不输出 `<memory_context>`，payload 与 D9 的旧格式逐字节一致 —— 本条与 D9 兼容，不取代它。
- **vision context 明确不回 Telegram 路径**：Telegram 媒体继续走信封内的 `<media>` 引用通路，不因修 G1 顺手恢复 vision context。
- **记忆解析 fail-open**：解析失败降级为空记忆继续发送，不阻断本轮（不变量 5，宁可失忆不可失联）。
- **trace 必须解释 memory_context**：`recordContextTrace()` 有记忆时在 `blocks` 记 `memory_context`（含 reason 与字数），无记忆时在 `skipped` 记原因。这是 G1 的验收结构，对所有 provider 生效。

格式由 `test/telegram-runtime-payload.test.js` 钉住，trace 由 `test/phase2-hard-context.test.js` 钉住，两者都在阻塞主 CI 的分组内。

## D16 · Closeout 后写入权归当前窗口 AI；nightly 由 520 面板手控

```text
Status: ACTIVE
Decision date: 2026-07-29
```

对 C4「后台 memory owner 与 nightly closeout 的边界」提出的三个问题作出裁定。

- **写入权持有者：当前窗口 AI。** Closeout 之后，记忆的写入权由**产生那段对话的当前窗口 AI** 持有，**不移交给任何后台模型**。后台跑的 closeout 不因为它跑在后台就取得 writer 身份。这是不变量 4 与 D4「单 writer」在时间维度上的落法：换的是时机，不是写入者。
- **deepseek 只搬运。** 后台廉价模型（当前指 deepseek）只承担**搬运 / 传输**角色：取走、递送、落盘管线上的搬运工作。它**不拥有任何记忆写入权，也不产出记忆内容** —— 不生成、不改写、不总结出新的记忆文本。让廉价模型代笔写记忆，等于给同一份文件加了第二个 writer（一级腐化信号）。
- **Review 只拦格式。** Review 的职权边界是**只拦格式违规**：格式不合就打回，**不改写、不润色、不重写措辞**。这与 `CLAUDE.md` 列出的腐化信号「Review 开始改写措辞」是同一条线 —— Review 一旦动笔，它就成了第二个 writer。也与 D5「候选与正式分离」一致：Review 是关卡，不是产出方。
- **nightly 不自动默认开启，由 520 面板手控。** nightly closeout **不采用"默认自动跑"**；开不开由她通过 520 面板手动控制。仓库内 `CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED` 等开关**保持默认 `false` 不变**，本条不批准把任何一个开关的仓库默认值改成 `true`，也不批准在生产机上自行打开。

**本条未裁定的部分，仍留在后续：**

- **Review 与 History writer 的具体交接点**（在哪一步、以什么产物、什么失败语义交接）本条**没有裁定**。上面只定了 Review 的职权边界（只拦格式），没有定交接协议。这部分继续保留为待裁决，不得当成已定方向施工。
- **本条是决定登记，不是实现闭环。** G2 的状态不因本条改变（仍见 `docs/CURRENT_STATUS.md`）。本条也不改变生产机的实际开关状态 —— 仓库无法判断生产机状态这一事实没有变化。

---

## D17 · Review 打回走「写入时即打回、归入上下文」；打回案例存档供自学习

```text
Status: ACTIVE
Decision date: 2026-07-29
```

对 G2 决策单第 8 项「Review 打回后的补写路径」作出裁定（Owner 原话：「写入时即打回，归入上下文，并收集打回案例→优化案例，供后续自学习」）。这是 issue #47 的合并前置。

- **写入时即打回。** Review 的判定发生在写入尝试的当下，打回是**同步**结果——不设异步补写队列、不设事后批处理打回。候选要么当场过、要么当场带着原因被打回。
- **打回归入上下文。** 被打回的候选连同打回原因，回到**产生它的当前窗口 AI 的上下文**里，由在场的它决定改写重交还是放弃。**不开任何后台补写通路**——这是 D16「写入权归当前窗口 AI、后台不产出记忆内容」在打回场景的直接延伸：补写也是写。
- **打回案例要存档。** 每次打回收集为案例（候选原文 + 打回原因），沉淀成优化案例库，供后续自学习使用（例如提示词与书写习惯的改进循环，与 issue #31 的记忆质量优化 loop 同一方向）。案例库的落盘位置、writer 归属与自学习的具体形态**本条不裁定**，属实施设计。
- **对 #47 的效果。** 权限闸门收紧后滞留在候选层的条目，其出路即本条：等当前窗口 AI 在场时归入上下文处理。「合并到拍板之间正史冻结」的顾虑随本条解除，#47 可以按其验收清单合并。

**本条未裁定的部分：**

- **C4 剩余的「Review 与 History writer 交接点」不因本条关闭**——本条定的是「打回之后」的走向，交接协议（在哪一步、交接什么产物、失败语义）仍待裁决。
- 打回案例库与「归入上下文」的具体注入方式（走哪个通路、什么分寸）归实施设计，须遵守上下文预算三档纪律（`SYSTEM_OVERVIEW.md` 第四节）。

---

## D18 · Closeout 业务日 = 刚结束的前一个完整本地日；空结果不得封死业务日

```text
Status: ACTIVE
Decision date: 2026-07-29
```

裁定背景：2026-07-29 外部架构审查发现 closeout 调度存在日界线错位（04:30 取「当天」本地日期处理当天文件，而 conversation recorder 按 `Asia/Shanghai` 分日；材料为空时写 `no_output` 并被当作终态永久跳过）。该调度器生产未启用，属启用前必修。Owner 授权按工程窗建议定案。

- **业务日定义**：nightly closeout 在计划时刻（默认 04:30，`automationTimezone`）运行时，处理**刚结束的前一个完整本地日**的材料，不处理当天。
- **全链同一时区**：recorder 分日、closeout 取日、ledger 键、candidate 时间戳必须使用同一 `automationTimezone` 与同一业务日函数；`Asia/Shanghai` / 硬编码 `+08:00` 残留随实施清除（`conversation-recorder.js`、`continuity-pipeline.js` 的 `T23:59:59+08:00`、`weekly-reflect.js`、`diary-service.js`）。
- **`no_output` 语义拆分**：处理窗口尚未关闭时的空结果是**可重试状态**，不得作为终态封死该业务日；只有窗口确实关闭后才允许记为 sealed 终态。
- 实施与测试（DST、跨午夜、晚到材料、重启补跑、同日幂等）归实施 issue；是 #65 / #68 实施的前置。

---

## D19 · Review 硬闸门只做机器可判定检查；语义疑虑走 D17 打回，不得代行终局否决

```text
Status: ACTIVE
Decision date: 2026-07-29
```

裁定背景：D16 定了 Review「只拦格式」，但 `auto_review.py` 当前还在判断事实不确定、用户边界冲突、是否需要确认，拥有超出格式闸门的语义否决权——决策表述与实现冲突。Owner 授权按工程窗建议定案：**收窄实现，D16 表述不变**。

- **硬闸门（可机器判定，允许直接拦）**：格式、长度预算、source_ref 可定位、权限（authority gate）、安全红线。
- **语义疑虑（事实存疑、边界冲突、需用户确认）不得由后台模型终局否决**：只能记为 deferred 并按 D17 打回给产生该候选的主体 AI，由在场的它决定改写重交还是放弃。后台模型的语义意见随打回原因一并带回，作为参考，不作为判决。
- Review 依旧**永不改写正文**（D16 不变）。

---

## D20 · G3 与 G5 是切生产硬门

```text
Status: ACTIVE
Decision date: 2026-07-29
```

裁定背景：`CURRENT_STATUS.md` 把 G3 / G5 列为 Gate，但第五节放行判据未显式要求它们通过，存在靠缩小「放行范围」绕开隔离与恢复演练的解释空间。Owner 授权按工程窗建议定案，并另有明确要求：**Telegram 陪伴线与工程线彼此独立**。

- **G3（profile 隔离）是硬门**：切生产前必须有真实的 `fable-chat` profile 绑定与隔离证据——工程 `CLAUDE.md`、CC 工程记忆不得穿进聊天人格；Telegram 与工程工作区互相独立。
- **G5（备份恢复）是硬门**：切生产前必须完成一次真实备份恢复演练并留证，不接受「脚本存在」替代演练。对一个记忆系统，不能证明记忆可恢复就不算能上线。
- `CURRENT_STATUS.md` 第五节判据随本条补全。

---

## D21 · G1 检索数据源接 Episodes 正史的受控 adapter；不启用 legacy MemoryService 文件组

```text
Status: ACTIVE
Decision date: 2026-07-29
```

裁定背景：`memory_context` 打开检索后调用的旧 `MemoryService` 读取 `facts.md` / `preferences.md` / `7-day-memory.md` 等 legacy 文件组，而当前 memory 目录中这些文件不存在——直接打开开关只会创建一套空文件，接不到 `episodes.jsonl` 正史。Owner 授权按工程窗建议定案。

- **G1 的数据契约是 Episodes 正史**：为 memory_context 建立对正式 canon（episodes 等）的**只读受控 adapter**，遵守 D6（纯规则槽位，不用 embedding）、D7（翻档边界）与 Context Trace 规则。
- **不启用 legacy MemoryService 文件组**：不得以「打开旧开关 + 自动创建空文件」的方式让 G1 通过；G1 真机验收必须证明 Trace 中的来源 ID 指向正式数据源，不接受 manual override 或刚创建的空文件。
- adapter 的具体设计（触发条件、槽位、预算）归实施设计，与 #42 的读者线合并推进。

---

## D22 · Review→History 交接采用持久化 publication intent（outbox）

```text
Status: ACTIVE
Decision date: 2026-07-29
```

裁定背景：C4 剩余的「Review 与 History writer 交接点」——在哪一步交接、交接什么产物、失败语义。G2 主路径设计稿（workdesk 2026-07-29）给出两个候选：方案一「Review 返回 success + History 全局扫描」（接近现状，交接物不可审计，全量扫描易重复消费旧 accepted）；方案二「持久化 publication intent/outbox」。Owner 2026-07-29 裁定采用**方案二**。

- **交接产物**：Review writer 在 decision 及必要 artifact（envelope / 案例）全部物化完成后，追加 publication intent 记录（含 candidate、effective decision、lineage root、artifact digest 的稳定 ID）；落盘 `continuity/decisions/publication-intents.jsonl`，**Review writer 唯一写**。
- **消费方**：History writer 只读 intent，验证 effective head 与 digest 后按 lineage publication key 幂等发布；写 canon 与自己的 writer state。单 writer 格局不变（Review 不写 canon，History 不写 decision/envelope/case/intent）。
- **失败语义**：decision 已写而 intent 未写 → 不发布，Review writer 按稳定 ID 幂等补写；intent 已写而 History 崩溃 → 重试时重新验证后幂等发布；decision 被后续 supersede 使 intent 变陈旧 → History 记 `stale_intent` 不发布，新 effective accepted head 产生新 intent。
- **实施顺序**：本条只裁协议，不改变 G2 分单依赖——G2-4 解锁，但仍依赖 G2-0（#73）与 G2-3（envelope/case 物化）先行。

---

## D23 · 退役 legacy 自动抽取写入链；系统不替主体 AI 决定该记什么

```text
Status: ACTIVE
Decision date: 2026-07-31
```

裁定背景：修红孤儿测试时发现 `open_loops` 抽取器函数体被掏空、不在分发循环里、全仓零调用点，而配套 helper 实现完整却无人引用，同时上游闸门仍把「提醒我 / 记得 / 待办」判为值得记 —— 判定与执行在同一个文件里打架（issue #90）。追查发现这不是孤例，而是**整条 legacy 自动抽取写入链**的状态。Owner 2026-07-31 裁定**整条退役**。

**裁定理由（Owner 原话要点）**：AI 是写作主体；**在 AI 已经有独占写权时，系统不应该再替 AI 决定它想写什么**。并且「**如果模型有漏记的，那是系统出 bug，而不是写这种没必要的补丁；漏了就漏了**」。这与 D16（写入权归当前窗口 AI）一致，也与 `CLAUDE.md` 北极星「记忆失败 = 它替 AI 决定下一句话的内容」一致：一个正则分桶器正是那句话描述的失败模式。

- **退役范围**：`src/core/memory-candidate-extractor.js`（正则分桶抽取器）、`src/core/memory-background-pipeline.js`（post-response 自动写入 pipeline）、`CyberbossApp` 的 `maybeRunLegacyMemoryBackgroundPipeline()` 与 `recordAssistantReplyForMemory()` 及其全部调用点，以及两者的测试。**不得重新引入**，由 `test/phase1-offline-config.test.js` 的守卫钉住。
- **不在退役范围（明确保留）**：`src/services/memory-service.js` 本身。它仍是 memory_context 读取通路（`app.js` 的 `readSevenDayMemory` / `readPendingPromises` / `resolvePreResponseMemory`）与 `/memory` 命令的实现方。按 **D21**，该读取端最终要换成对 Episodes 正史的受控 adapter，那属 #42 的范围，**本条不动读取侧**。
- **保留 `CYBERBOSS_MEMORY_BACKGROUND_WRITE` 开关与启动期守卫**：它是四个 legacy 记忆开关的共用 fail-closed 机制的一员，且 `continuityDir == memoryDir` 的现行生产布局正是靠「四个全关」才被放行。退役后该开关背后已无实现，**永远不得再有实现**。
- **对既有决定的关系**：本条把 D21「不启用 legacy MemoryService 文件组」的隐含结论在**写入侧**显式化并执行；D21 本身不变，其读取侧结论仍待 #42 落地。
- **已知代价（接受）**：主体 AI 若在对话里漏记某件事，不再有任何后台机制替它补记。这是**有意为之** —— 按上述理由，补记机制本身就是要消除的东西；漏记应作为系统缺陷去查，不用补丁掩盖。

---

## D24 · `window_id` 采用运行时原生会话口径：同一上下文 = 同一窗口

```text
Status: ACTIVE
Decision date: 2026-07-31
```

裁定对象：G2 设计稿决策点 6（`subject_route.session.window_id` 的定义）。候选有三：runtime process epoch（按进程）、native transcript epoch（按运行时会话）、显式 continuity epoch（按 closeout 划的"一天"）。

**Owner 裁定：按同一个窗口 session 看——上下文一样（即 native transcript epoch）。** 判据是上下文连续性本身：打回交接要递回"写它的那个她"，而"那个她"的边界就是她当时看得见的上下文；会话（transcript）延续则上下文延续，即同一窗口。

- **实现口径**：`window_id` 从运行时原生会话身份派生（claudecode 为 session slot 持有的 native session 身份，codex 为其 session store 身份），取稳定不透明值（原 ID 或其哈希）。进程重启但会话 resume → 同一 `window_id`；会话重开（新上下文）→ 新 `window_id`。
- **拿不到就缺席**：无法取得原生会话身份时，`window_id` 字段缺席并按 G2-1 状态机记 `RECORDED_PARTIAL` / ambiguous，**不许编造或退化成进程 ID / 时间戳**。
- **不选另两案的理由**：按进程太脆（重启即"换人"，与 2026-07-31 停机事故同款场景冲突）；按"一天"（continuity epoch）语义上与北极星呼应但引入系统自造的第四套身份，违反 G2 设计稿"复用 canonical 值，不另造身份"的原则。
- **解锁**：G2-1（recorder route snapshot 与 `subject_route` 权威 schema）自本条起可施工；G2-3 登记的 `subject_route` 可选字段欠账（改必填 + 历史行迁移）随 G2-1 一并处理。

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
Status: CLOSED — 全部子问题已裁定
```

- 写入权持有者、后台模型的角色、Review 的职权边界、nightly 是否默认开启：2026-07-29 由 **D16** 裁定。
- 剩余的 Review 与 History writer 交接点：2026-07-29 由 **D22** 裁定（publication intent/outbox）。本条不再有未决部分。
- 仍然有效的约束：按 D16，仓库开关默认值保持 `false`，nightly 只由 520 面板手动控制，不得在生产机上自行打开。

### C5 · 子代理运行时与输出胶囊化

```text
Status: OPEN
```

- **已收窄**：胶囊化契约本身已在 2026-07-28 由 **D14** 裁定，本条不再涵盖那部分。
- **Known facts**：`src/adapters/runtime/codex/` 有完整实现，但只用于主运行时切换。委派协议与离线闭环已落在 `src/orchestration/delegation/` 并进主 CI；真实 Codex canary 跑通一次。但**主 Chat 仍直接回流子代理输出**，仓库内也没有把 Codex adapter 绑进委派 runner 的代码。
- **Decision needed**：是否、以及在什么触发条件下，让主 Chat 自动发起子代理任务；由谁持有发起权与预算；胶囊回到主 Chat 后以什么形式进入上下文分档。
- **Not authorised**：在上述边界裁定前，把子代理接进主 Chat 的任何自动路径。人工发起、按 D14 有界执行的 canary 不受此限。

### C6 · 多 Bot、Route 1 / Route 2、Apple Watch、CMX

```text
Status: OPEN
```

- **Known facts**：四者当前一律 `DEFERRED`，未排期。Apple Watch 只有 5 份规格文档，代码侧零实现。
- **Decision needed**：是否以及何时排期。
- **Not authorised**：在排期前投入实现工作。
