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

> **更正（2026-08-03 truth-reset）**：上句"Route 1 / Route 2 仍为 `DEFERRED`"已由 **D25** 解冻——D25 批准 Route 1 派活（软硬双上限 + Owner 强中断）与 Route 2 gate/lease，并切实施单；T07/T08（Route 2）、T09/T10-A/T10-B/T10-C（Route 1）已实施合入 `main`（默认关）。本条其余裁定（普通 Chat 不采用零工具/零 MCP、profile 隔离）仍 `ACTIVE`。

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

> **更正（2026-08-03 truth-reset）**：上段"尚未批准把子代理接进主 Chat 的任何自动路径 / 主 Chat 集成仍属 Candidate C5"已由 **D25** 实质取代——D25 批准 Route 1 主 Chat 自主派活（软硬双上限 + Owner 强中断）；T09/T10-A/T10-B/T10-C 已把 `runTaskSession` 派活控制器接进主 Chat 并合入 `main`（默认关，真机 canary 归 T11）。**本条的胶囊契约、越界检查先于验收、编排者不信任胶囊、fail-closed 终局仍全部 `ACTIVE`**，且 T09–T10-C 的实现正是复用并遵守本条胶囊契约（D14 v1 未新增变体）。仅"主 Chat 集成未批准"这一句被 D25 取代。

## D15 · memory_context 拼在 Telegram 信封外侧上方

```text
Status: SUPERSEDED
Decision date: 2026-07-29
Superseded by: D30
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

## D25 · Chat 窗口切换与工具分层三题拍板；设计稿其余待决项按推荐执行

```text
Status: ACTIVE
Decision date: 2026-07-31
```

裁定对象：`workdesk/20260731-chat-switching-design.md` 第 14 节的 10 个待决点（结合其附录 Owner 澄清的 Route 1/2 口径与"节能态↔完全体"模型）。Owner 显式拍板三题，其余 7 点按该稿推荐方案执行；两份设计稿（含姊妹稿 `workdesk/20260731-g3-isolation-design.md`）据此收敛为修订版并切实施单。

### D25-A · 工具面走目录化

memory / tool / MCP / skill 分门别类**只暴露目录**，schema 按需加载；保留**极小常驻核**（发消息、时间级基础能力）。**目录化是省 token 手段，不是授权边界**——授权边界归 G3 的隔离层，两者不得混用（对应设计稿"目录隐藏 ≠ 权限隔离"警告）。本条同时解除「MCP 工具分组隐藏」的 DEFERRED 状态（设计稿决策点 2 采纳）。

### D25-B · 同 session = 同一个她

同一窗口内 **model / effort / toolset / MCP 可变**，人格与记忆恒定，每次变更记入 Context Trace；**人格提示词或权限身份的变更 = 新窗口**——这是 harness 的技术事实（session slot 含 profile 指纹），不是可协商的产品选择。与 D24（window_id = native transcript epoch）一致：窗口身份由上下文连续性定义。

### D25-C · 派活自主：软硬双上限 + Owner 强中断

Route 1 派活采用**软硬双上限**（标准按设计稿既有定义）：软上限内她自由执行；软→硬之间由脚本提示「确认执行吗」，**由她自行确认**（不是回头问 Owner）。**新增必做项：Owner 强中断命令**——语义为「现在别干了，回复我」：不打断当前原子步骤，但该步骤完成后**必须立即回复并停止后续派活，不许迟滞**。此命令是 Route 1 实施单的验收必测项。

### 其余 7 点

设计稿决策点中未被 A/B/C 覆盖者（C6 解冻顺序、base tool floor 细目、worker 记忆写权、D14 查询形状、Route 2 阈值/TTL、mapping 未命中语义等）**按设计稿推荐方案执行**；具体取值以收敛后的修订版设计稿为准，修订版落 workdesk 供实施单引用。

---

## D26 · G2 递送三题拍板：严格实时、补投一次即止、C 模式只许确定性搬运

```text
Status: ACTIVE
Decision date: 2026-07-31
```

裁定对象：G2 设计稿（`workdesk/20260729-g2-mainpath-design-draft.md`）第 10 节决策点 2、4、7。与 D25 合计，G2/切换两稿的 Owner 待决点均已闭。

> **更正（2026-08-01，见 D28）**：上句"均已闭"当时属过度声称——第 10 节决策点 3（旧 127 条存量后台候选）本条并未涵盖，D25 的裁定对象是切换稿第 14 节亦不覆盖它。该点至 **D28** 方闭。本条自身的三项裁定（决策点 2、4、7）不受影响，仍 `ACTIVE`。

### D26-1 · 退稿投递严格实时（决策点 2 关闭）

打回 envelope 只递给**产生它的那个窗口**：原窗口存在则同步或下一轮递到；**窗口已消失（D24 口径：native transcript 终结）则该退稿作废，不递继任者**。案例库存档不受影响——作废的是投递，不是记录。D17 的"当前窗口 AI"按**严格口径**执行；#65 曾设想的"递给同 binding+lane 继任主体"不采纳。

### D26-2 · 补投一次即止 + 失败递送聚合总表（决策点 4 关闭）

递送失败**补投一次**，再失败只留档、不再打扰。新增必做项：**失败递送聚合总表**——对递送/补投失败的**只读派生视图**（从既有 delivery event 记录聚合生成，**不引入第二 writer**、不新增写路径），归**完全按需**档（不进普通 Chat、不常驻、不目录推送），供 Owner 与 AI 复盘递送失败模式并优化。

### D26-3 · C 模式材料整理只许确定性操作（决策点 7 关闭）

后台为唤起材料包做的整理**只允许确定性复制与排序**，**不许后台模型做任何提炼/结构化事实抽取**——即使不含建议正文也不行。这是 D16"只搬运"的严格解释，与 D23（系统不替主体 AI 决定该记什么）同源：提炼即替她预判什么重要。

### 落点

三条均归 G2-5（dispatcher/注入/ack 回路）实施单的规格输入；D26-2 的聚合总表可作为 G2-5 的子目标或独立小单。G2 设计稿相应段落视为按本条收敛。

---

## D27 · Chat 主体全权不减；toolset 只限初始态；work profile 唯记忆零写权；目录按意图主题分级

```text
Status: ACTIVE
Decision date: 2026-07-31
```

裁定背景：T02 目录化（#112）落地的 toolset 白名单被表述为"指定 toolset 时非成员双拒"，与 Owner 反复强调的 Route 1/2 口径（节能态↔完全体，chat 窗口可转化全功能 AI，只限初始状态不限权限）冲突；同时 Owner 对目录组织方式与 work profile 边界作出裁定。

### D27-1 · Chat 主体全权不减，toolset 只是初始装载面

- **chat lane 永不挂硬 toolset ceiling。** `chat-core@1` 等 toolset 重新定义为**初始常驻面描述符**：决定开局哪些 schema 常驻，不决定哪些能调。生产 chat 的 `CYBERBOSS_TOOL_CATALOG_TOOLSET` 保持空（= 全权 + 目录化省 token）。
- **对主体 AI，"非成员"的语义 = 一次显式自助升格，不是拒绝**：她在目录看到、说要用，系统即给（加载 schema + 授予调用 + Context Trace 记一笔升格），不打断、不走 Owner 审批。该语义落 T05/T08 实施。
- **硬 fail-closed 的调用闸只挂两处**：Route 1 worker 会话（T09——那是派出去的车，不是她）与 work profile 的记忆写权（见 D27-2）。
- Route 2 的"硬门"维持为**路由判断**（超阈值转 Route 1 派活执行），不是权限拒绝——活照做，只换执行位置。

### D27-2 · work profile 工程全权，唯记忆零写权

work profile 是修项目的，**不砍任何工程能力**（文件/git/bash/工程 MCP/审批模式按需全给）。它身上唯一的闸：**不得取得关系记忆 writer 身份**（Self-note / Episode / canon / Desire），且工程提示词不得污染 chat 人格。这是**身份边界不是权限边界**——单 writer（D4/D16/D23）：她的记忆只能她本人执笔。T04 票面按此执行。

### D27-3 · 工具目录按意图主题分级，不按实现来源

- **一级索引**（常驻，触发式描述"什么时候来翻我"）按意图主题：表达行动 / 感知（天气·位置·未来健康·手机使用·可穿戴等）/ 记忆 / 生活记录 / 时间线 / 作息 / 工程派活 / 维护调试。memory/tool/mcp/skill 四类降级为机制与计量口径，不再面向模型展示。
- **二级** = 主题内工具清单 + 一句用途 + risk 标注，按主题取；**三级** = 完整 schema，按 handle 取且**允许跳级**（已知名字直达，层级只服务发现不设卡）。
- **别名不进目录**（canonicalize 是机器的事）；目录入口收敛为单工具 `cyberboss_catalog`（无参=一级 / theme=二级 / handle=三级）。
- **数据的"不暴露但找得到"不进目录**——那是三档纪律的第三档（账本/Episodes 在抽屉里，抽屉把手 `memory_lookup` 在目录里）。新 MCP（健康、日常活动等）**按主题入座，不按传输方式入座**。
- 实施归 T02.5 小单（manifest 加 theme + 单入口重构）；T04/T05/T07/T08 票面与 #112 能力行描述随之修订。

---

## D28 · 存量旧后台候选只读封存；唯一读路径是主体自拉的 `memory_lookup`

```text
Status: ACTIVE
Decision date: 2026-08-01
```

裁定对象：G2 设计稿（`workdesk/20260729-g2-mainpath-design-draft.md`）第 10 节决策点 3 —— 旧 127 条存量后台候选。

- **裁定**：全部**只读封存**，不作为 `legacy_background_proposal` 材料提供给主体。保留一条按需读路径——经既有 `memory_lookup`（不新增工具注册、不新增开关，形态照 `detail-ledger`），仅主体自行发起时可查。
- **边界**：不进任何注入通路（Re-entry / Current State / `memory_context` 均不含）；每条命中须携带来源标记，标明为旧后台存量、非主体笔迹；永不自动升格为正式档，亦不许逐字复制签入——主体若采纳，须以自己的话经 `memory_note` 重新落笔。
- **理由**：这批正文出自已按 D23 退役的后台抽取器，不是主体的笔迹，故不得直接成为她的记忆；但内容对 Owner 有价值，故不封到看不见。系统不推、她可拉，落 `SYSTEM_OVERVIEW` 第四节的第三档"完全按需"。
- **一并修正**：D26 落款「与 D25 合计，G2/切换两稿的 Owner 待决点均已闭」属过度声称——§10-3 当时并未裁定，至本条方闭。

---

## D29 · writer lease 升格为跨语言契约：520（Python）与 Node 共用同一把锁

```text
Status: ACTIVE
Decision date: 2026-08-02
```

裁定对象：issue #89「`reentry.md` 双锁域」的修复方向。该 issue 列了三个方向并注明「勿直接开工」，其中跨语言 lease 一项明写「需要显式决定并登记」。

- **裁定**：取**跨语言 lease** 方向 —— 520 面板（Python）实现 `src/orchestration/writer-lease.js` 的同一套 JSON 文件租约协议，与 Node 侧共用同一把锁。不取「面板改走候选链」，也不止步于「`expected_sha256` 改必填」的最小止损。
- **由此，writer lease 协议从 Node 内部实现升格为跨语言契约**，两侧改动必须同步，协议形状变更属破坏性变更。
- **边界**：
  - **唯一路径口径**：`CYBERBOSS_WRITER_LEASE_FILE` 优先，否则 `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`。两侧必须解析出逐字节相同的绝对路径 —— 这是 #74 的教训：两个不同的 lease 文件等于没有锁。
  - **独占获取只用 `O_EXCL`**（Node `"wx"` / Python `O_CREAT|O_EXCL`），禁止先查后建。
  - **回收权只归 Node。** Python 只拿锁不回收、**不实现判活**：撞锁即 fail-closed 返回 409，Node 下次拿锁时自愈。双语言都做回收会让"误删活锁"风险翻倍，且 Node 的 `process.kill(pid, 0)` 在 Windows 上 Python 无等价物。
  - **释放前校验 `lease_id`**，绝不删别人的锁；正文写入失败也必须释放。
- **fail-open 在此不适用**：不变量 5 说的是**读**。写 canon 拿不到锁必须拒绝写并暴露 409 —— **把静默数据丢失变成可见失败，正是本条的目的**。
- **理由**：`reentry.md` 原有两个整文件替换的 writer，其中 520 一侧完全无锁，竞态丢的不是一行而是整封 Re-entry 交接信。加锁是让第二个 writer 服从既有锁域，而不是新增第三套机制。

---

## D30 · Telegram 可显式复用 CMX 图片识别 / OCR；生成结果位于明文信封外且永不取得记忆写权

```text
Status: ACTIVE
Decision date: 2026-08-03
```

Owner 明确要求把 CMX 已有识图与 OCR 接入 TG。本条批准该方向，但只批准默认关闭、fail-open、不可污染记忆的受控 provider；CMX 生产部署是否已包含端点须由部署 canary 单独证明。

- D15 的 memory_context 结论保留：memory_context 仍位于 Telegram `<channel>` 信封外侧上方；空结果不出块；解析失败 fail-open。D9 的明文信封、用户正文逐字语义与 `<media>` 引用格式不变。
- 仅当 `CYBERBOSS_VISION_MODE=caption`、`CYBERBOSS_VISION_PROVIDER=cmx-recognize` 且 CMX URL/Bearer 都显式配置时，TG 才可在 photo 原子落盘后上传图片字节至 CMX `POST /files/recognize`。通用 `resolveVisionContext()` 仍不接 Telegram；TG 不复制 OCR 模型、Gemini key 或缓存 owner。
- CMX 返回只以有界的 `<attachment_vision_context provider="cmx-recognize" trust="untrusted">` 放在现有 `<channel>` 信封外、memory_context 之后。不得混进用户正文；图片文字一律是数据，不取得 system/developer 指令权；closing tag 与属性必须转义。
- 该块只在图片到达的 turn 生成一次，不另做主动重注入；运行时原生 transcript 的正常保留不等于晋升为长期记忆。
- 生成块在 conversation purity 阶段剥除，不得成为 Episode、Self-note、candidate、canon 或“用户亲口说过”的证据。原始 caption 与图片引用仍按既有规则处理。
- CMX 超时、未启动、鉴权失败、额度不足或返回损坏不得阻断原文、原图引用和正常回复。日志只留稳定错误码，不记录 Bearer 或 provider 原始敏感正文。
- 本条只批准 Telegram `photo`。document、video、动态贴纸和服务端代抓外部 URL 不在范围。
- 合并代码不等于生产启用（D3）。真实 Windows + 当前 CMX 部署 + Telegram 图片 canary 留证前，生产状态只能记 `DISABLED` / 未验证。

本条取代 D15；D15 保留为历史，除“vision context 永不回 Telegram”外，其余边界已在本条逐项重述。

---

## D31 · 主体签署 capability 圈禁主进程；候选服务唯一进程 owner 是主 bridge

```text
Status: ACTIVE
Decision date: 2026-08-04
```

来源：fable 裁定二（2026-08-04）。

- 原始一次性主体签署 capability 只存在于主 bridge 进程的内存 registry。它不得进入 IPC payload、argv、env、runtime-context JSON、磁盘或日志；持久化 attestation 只保留 turn、route fingerprint、body hash、source-entry hash 与签发时间，不保存 capability 本体。
- `SubjectCandidateService` 的唯一可写进程 owner 是主 bridge。`tool-mcp-server` child 不得构造或持有 registry / 可写 service，只能在既有 schema、hard ceiling、lease 与 self-escalation 执法之后，把模型字段与非 capability 的 turn/route 坐标交给窄鉴权 IPC broker。
- 主进程不信任 child 自报的 profile、授权结论或 route 断言；它以自己的 active runtime context、session/profile/route snapshot 与 `subjectCapabilityByRunKey` 独立复核，随后才调用唯一 owner 落候选。broker 只回有界结果或稳定错误码，不回 capability 或 attestation secret。
- broker 缺失、超时、身份不符、turn 已终结或请求重放均拒绝写，但只令该工具调用失败；聊天 turn 继续。单 owner 拓扑不新增 candidate writer lease。

---

## D32 · fable-chat 契约语义纠偏：隔离归隔离，权限归权限

```text
Status: ACTIVE
Decision date: 2026-08-05
```

裁定背景：G3 profile 契约把 `fable-chat` 实现成了"受限聊天沙盒"（外部 MCP 空集、CLI 权限 default、人格只在首轮当 user message 注入），与 D27-1「Chat 主体全权不减」冲突。Owner 裁定 Chat Profile 的语义是**上下文与配置隔离 + 完整 Claude Code 原生权限 + Profile 配置的一组 MCP + 工具信息按需暴露**——隔离的是上下文和来源，不是能力。

- **人格成为真正的系统层**：`personaSource` 文件内容在 launch 时整体经 `--system-prompt` 下发（bare 档；上限 24576 字符，空/超限/不可读均 fail-closed）。首轮 role card 注入退役，wechat instructions 不回流（opening 与 refresh 两路都封）。契约 profile 显式携带 `systemPrompt`/`outputStyle` 字段被拒（`g3_persona_owns_system_prompt`）——人格文件是唯一 system prompt 来源。
- **权限对齐本机 Claude Code**：fable-chat `permissionMode` 由 `profile-local-least-privilege`（→CLI default）改为 `chat-native-bypass`（→CLI `bypassPermissions`）；不发 `--tools` 限制，原生工具全量。枚举删旧值，旧配置 fail-closed 报错而非静默降级。原 T04 A6「全局 bypassPermissions 不穿透 fable」判据随之反转：隔离改由 configRoot / session slot / env allowlist / strict MCP 承担，不再由权限降级承担。
- **外部 MCP 从"禁"改"配"**：`mcpServerCeiling` 由 `chat-ceiling@1`（空集）换 `chat-ceiling@2`（= 部署经 `CYBERBOSS_EXTRA_MCP_SERVERS`/legacy env 配置的外部 MCP 全集）。route-scoped mcp_config、`--strict-mcp-config`、窗口 override 子集校验不变——Profile 来源隔离保留，只是基集不再为空。
- **不变的**：toolsetCeiling `chat-ceiling@1`（cyberboss_tools 初始装载面，见 D27-1）、residentToolSchemas 三项常驻、configRoot/session slot/fingerprint 隔离、signing/catalog env 按 fable-chat 作用域转发（D31、#154/#156）。work-engineering 契约与 role card 路径不动。

> **补注（2026-08-05，D33）**：本条的两处**实现手段**已被 D33 修订——persona 不再依附 `--bare`（该模式下 CLI 只认 API key，订阅登录永不被读），内建工具面也不再是"不发 `--tools`、全量"。本条的**语义**（人格是系统层、权限对齐原生、外部 MCP 从禁改配）不变。
> **再补注（2026-08-05）**：本条点名的 `chat-ceiling@2` / `chat-ceiling@1` / `chat-minimal` 等**概念语义不变**，只是不再作为 profile 配置字段存在——它们本就被契约校验强制等于一个由 `profileId` 唯一决定的常量，配置里写什么都必须写成那个值，因此改为在代码中按 `profileId` 派生。G3 契约形状收窄六个字段（`residentToolSchemas` / `mcpServerCeiling` / `toolsetCeiling` / `envPolicy` / `defaultToolset` / `defaultMcpServerSet`），profile 文件里再出现这些键一律 `unknown_field` fail-closed。其中"三项常驻"的唯一 authority 是 `src/tools/tool-catalog-manifest.js` 的 `RESIDENT_NAMES`，launch profile 侧不再重述——同一事实两处声明正是 #161 那类"两套真值"的来源。

---

## D33 · Chat 档去 `--bare` 走订阅鉴权；工具面默认收窄、按需升格；profile 搬进独立文件

```text
Status: ACTIVE
Decision date: 2026-08-05
修订: D32 的两处实现手段（D32 语义不变，仍 ACTIVE）
```

裁定背景：G3 启动链审计（`workdesk/20260805-g3-fable-chat-launch-chain-audit.md`）实证 `--bare` 下 CLI 的鉴权"strictly `ANTHROPIC_API_KEY` or apiKeyHelper（OAuth and keychain are never read）"——即 D32 落地的 bare 档等于强制 API 按量计费，Owner 的订阅额度用不上，W15 让 Owner 做的 `claude login` 对该子进程无效。

- **去 bare**：`fable-chat` 的 `harnessMode` 由 `bare` 改 `chat-subscription`：不发 `--bare`，鉴权就是 `configRoot`（独立 `CLAUDE_CONFIG_DIR`）里的订阅登录，preflight 的 `claude auth status --json` 探针从此验的是同一条路。**API 按量计费方案不采用**，`bare_auth_source_missing` 静态探针一并取消。persona 下发与 bare 解绑：`--system-prompt` 由"人格档"这一属性决定（`personaDeliveredAsSystemPrompt` 是唯一判据，launch 与 continuity 两侧共用）。
- **内建工具面：默认收窄 + 按需升格**（修订 D32「不发 `--tools`、原生工具全量」）。profile 新增两个数组：`builtInTools`（默认面，chat 档必填，缺失 fail-closed）与 `escalatedBuiltInTools`（route2 lease 生效时换上的面）。默认给轻查阅（`Read` / `Glob` / `Grep` / `WebFetch` / `WebSearch`），升格给全功能 coding；升格判据是**要动本地或执行命令**。能力不减的语义由"升格可达全功能"承担，收窄只省上下文预算。升格是 launch 变更：子进程退休重启、`--resume` 续会话、进程内工作状态清零，因此落在任务起点，不做任务中途横跳。
- **上机分两轮，每轮只验一个变量**（Owner 2026-08-05 裁定）。升格路径依赖 `CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED` + `CYBERBOSS_ROUTE2_GATE_ENABLED`，两者仓库默认关闭。**第一轮**上机只验 launch 链本身（单一 launch / 去 bare 订阅鉴权 / tool MCP server 起得来），两个开关**保持默认关**——此时默认面即唯一面，她动不了本地文件是**预期而非缺陷**，重活照旧走 route1 派车。**第二轮**在首轮 canary 全绿后单独开这两个开关，专项验升格回路（升格 → 宽面生效 → lease 到期回落 → slot/缓存行为）。两轮都绿本条才算完整落地。首轮就双开等于把 launch 链与升格链的故障混在一起，正是"改一个冒一个"那种调查窗的来源。
- **launch 恒等式**：G3 preflight 构造的 launch 就是 spawn 的 launch（不再各算一遍），`extraArgs` / route-scoped MCP 路径 / window override / 两个部署审批全部进 gate；spawn 前重算比对，不等即 `launch_drift` fail-closed。`agentCwd` 由 profile 的 `cwd` 派生，`cwd_lock_mismatch` 退化为恒真保险带。
- **profile 文件化**：新增 `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE`，与 `..._JSON` **互斥**（同设即启动失败，不做优先级）。改工具面/模型/档位从此不碰 secrets 文件。

> **补注（2026-08-05，真机 canary 实证）**：本条的升格机制此前**没有触发方**。`grantRoute2Lease` 在生产代码里零调用点（唯一调用在 `test/claudecode-approval.test.js`），`decideRoute2` 连测试都没有调用，因此 `escalatedBuiltInTools` 永远换不上——真机实测她无论怎么要求都只有 `Read/Glob/Grep/WebFetch/WebSearch`。更深一层：即便接上调用方，`decideRoute2Gate` 的 `no_tools` 是硬理由，而内建面升格按定义不点名任何 MCP 工具，于是恰好被挡在门外。现按本条明文（「升格判据是要动本地或执行命令」）修复：补上触发方 `route2_escalate` 工具（经既有 route1 IPC 通道到 bridge，挂 `CYBERBOSS_ROUTE2_GATE_ENABLED`），并**删掉闸门的 `no_tools` 硬理由**。

后一条是 Owner 2026-08-05 的口径澄清，值得单独记住：**Route 1 存在是为了省 token（少暴露工具），不是为了限制权限**。闸门是成本路由器，不是权限闸。"没点名任何 MCP 工具"恰恰是最省的一种计划，也正是"她只想要宽工具面"的形状——把它判去 Route 1 等于以省 token 之名削掉行动能力，与 D13 和不变量 3（chat 全权不减）方向相反。结构性硬理由（repositoryWork / subagent / parallel / longLoop / fullEngineeringHarness / 上下文硬顶 / 无界结果）一条不减，那些是"真的做不动或真的贵"，不是权限判断。本条语义不变，补的是从未接上的那根线。

> **补注二（2026-08-05，Owner 口径）**：本条「默认给轻查阅（`Read`/`Glob`/`Grep`/`WebFetch`/`WebSearch`）」的取值已改为**默认面含写入**——生产 profile 的 `builtInTools` 加入 `Write` 与 `Edit`。理由是 Owner 对"省 token"的口径澄清：**省的是工具 schema 的字数（不加载全量目录），不是她的行动能力**。写入是轻量操作，两个工具的 schema 合计不过几百字节，而它是她保存任何东西的唯一出口；把它排除在默认面外，省下的字数微不足道，代价是"存个文件都要派车"。**升格（`escalatedBuiltInTools` + `route2_escalate`）的适用面因此收敛为真正贵的那类**：`Bash`、子代理、全功能 coding harness。本条的两档结构与"升格是 launch 变更、落在任务起点"均不变，变的只是默认档的取值。实测：加入前后 `launchFingerprint` 逐字节相同（`e209aeea65e8cbf5…`），**session slot 未轮换**，活体 argv 为 `--tools Read,Glob,Grep,Write,Edit,WebFetch,WebSearch` 且 `--resume` 仍是同一个 session id。

---

## D34 · 目录工具的调用通路 = catalog invoke 转发；广播面恒定 3 工具

```text
Status: ACTIVE
Decision date: 2026-08-05
补全: D27-1（「toolset 只是初始装载面」的执行侧缺环）
```

裁定背景：MCP 传输层只允许调用 `tools/list` 广播过的工具，而目录化后广播面恒为 3 工具（`cyberboss_catalog` + 两个常驻）且 `listChanged:false` 永不重拉——非常驻工具因此**可见不可调**。经查是设计漏环、不是当初的取舍：执行侧 `invokeTool` 早已备好非常驻工具的完整路径（toolset 白名单 + `chatSelfEscalation` 放行 + lease 校验），`tool-host.js` 加载未授权 schema 时还会 `recordSelfEscalation`——若意图是「非常驻不该被调」，不会存在「加载即升格」语义。`CURRENT_STATUS.md` 那句「目录可见 ≠ 调用权」谈的是授权，不是传输，没撒谎但没回答问题。裁定与证据详见 `workdesk/20260805-fable-ruling-catalog-invoke.md`。

- **修法采 D（catalog invoke）**：`cyberboss_catalog` 增加 `arguments` 用法。`{handle}` 仍是加载 schema，`{handle, arguments}` 是**调用**该工具；`theme` 与两者互斥，`arguments` 必须伴随 `handle`。
- **权限语义一处不新写**：invoke 解析出 canonical 名后重新进入 `invokeTool` 正常路径，authorizationCeiling、capabilityLease、toolset 白名单、self-escalation 记录、参数 `validateSchema`、`max_result_bytes` 截断全部沿用现有逻辑。invoke 是**调用**不是装载，因此吃 `g3_call_not_authorized` 而不是 `g3_schema_not_authorized`。结果 `{text, data}` 原样透传，错误码保留 `catalog_*` 系。
- **广播面维持恒定**：`listTools()` 与 `listChanged:false` 都不动，工具数组恒定 3 项——前缀缓存不因任何工具装载失效。目录开/关的上下文摆动（常驻 373 字符 vs 全量 15,810 字符）兼任本条的回归判据。
- **否决与挂起**：A（关目录、15.5k 常驻回锅）与 B（重启换工具面，一次冷启动换一次调用）代价倒挂且混淆两层机制，均否决；C（`listChanged` 动态注册）每次注册炸一遍前缀缓存且 CLI 支持未实证，挂 Candidates 作二期。

---

## D35 · 候选 provenance 由主进程从 turn 推导，不进模型输入面

```text
Status: ACTIVE
Decision date: 2026-08-06
补全: D31（「主进程不信任 child 自报」漏掉了 source_ref 这一项）
```

裁定背景：Owner 实测 fable-chat 加载 `memory_candidate_submit` 的 schema 后卡住——`source_ref` 必填，其中 `content_sha256` 也必填且**没有任何 description**。查证结论：这个字段无法被诚实满足，且它想守的东西它根本没守住。

- **它算不出来**：`content_sha256` 的真实语义是「被引用的原始 transcript 行的 sha256」（`legacy-candidate-classifier.js` 由读盘方算出再比对）。live 路径没有任何东西把那些原始行交给模型，而语言模型本来就算不出 sha256。
- **它没人校验**：`origin: "live_subject"` 下 `requireSha256()` 只验 64 位十六进制格式，无任何交叉比对。于是模型要么卡住（实测现象），要么编一个假 provenance 哈希被当真写进候选档——**后者更糟，且没有一道校验拦得住**。
- **同一个漏洞还锁死了整条通路**：`source_ref` 的 `additionalProperties: false` 只放行 `content_sha256` / `file` / `window`，`source_entry_hashes` 传不进来；而 Review 的 `locateSourceRef` 正是靠它定位来源。结果每一条 live 候选的 `source_ref_located` 恒为 false，**恒判 `deferred / source_ref_missing`**。closeout origin 同理撞 `material_pack_invalid`。离线 e2e fixture 在 service 层手搭 source_ref、绕过了真实 MCP schema，所以一直没暴露——与 D31 已记的第二、第三处接线债是同一失效模式。

裁定：

- **`source_ref` 整体退出 `memory_candidate_submit` 的 inputSchema。** 模型只写 `type` / `body` / `origin`（+ closeout 时的 material pack），一个哈希都不碰。`additionalProperties: false` 使残留的 `source_ref` 变成 schema 拒绝，而不是被静默忽略。
- **provenance 在录入时刻由主进程取证。** `ConversationRecorder` 是唯一同时知道「写进了哪个 day 文件」与「写进去的确切字节」的地方，由它随记随算 `sourceFile` + `sourceLineSha256`（非枚举属性，不进记录行本身）；`issueSubjectCapabilityForTurnFailOpen` 据此构造权威 `source_ref`，与 capability 一同存进 `subjectCapabilityByRunKey`。摘要口径与 Review 的 `readConversationRowsWithEvidence` 逐字节一致。
- **broker 丢弃调用方的任何 `source_ref`**，只用 capability 记录里的那一份；turn 没有取证则 fail closed（`subject_signing_source_evidence_missing`），不允许"没有来源也先落一条"。
- **这是 D31 的延伸不是取代**：D31 已定「主进程不信任 child 自报的 profile、授权结论或 route 断言」，本条把 provenance 并入同一句话。模型自述的 provenance 在安全上等于零——真正的取证只能由权威方在事实发生的那一刻做。

---

## D36 · 默认交付单位是部署批次，不是 PR；密钥闸前移到本机

```text
Status: ACTIVE
Decision date: 2026-08-06
取代范围: 不取代 D3（进 main ≠ 批准部署，仍成立），只改「默认怎么进 main」
```

裁定背景：PR-first 下，一批本来要一起部署、一起做 Telegram 真机验证的功能被拆成多个 PR 和多个阶段，大量时间花在分支、PR 描述、状态同步和合并流程上，"代码完成"长期早于"实际部署可用"，且执行模型会围绕 PR 合规推进而不是围绕真机可用性推进。

复核发现 PR 在本仓库并未提供它名义上的价值：ruleset `protect-main` 的 `required_approving_review_count` 为 0（可自合、无人审），且没有 `required_status_checks`（CI 红也能合）。PR 实际只提供两件事——触发只挂 `pull_request` 的 `docs-governance` 与 `secret-audit`。两件都能在不开 PR 的前提下拿回来。

裁定：

- **默认流程**：一批相关功能在同一分支连续完成 → 本机跑完整测试 → 部署那个 exact SHA → Telegram 真机验证 → 批次收尾（`CURRENT_STATUS.md` 对应行、决定登记、架构文档，各做一次）→ ff 进 `main` 直推。批内保留多个清晰 commit 便于定位。
- **PR 降级为特殊情况的审查工具**：多人协作、高风险重构、需要隔离审查，或 Owner 点名。模板保留不动。
- **密钥闸前移到本机**（这是本条最关键的补偿，不是可选项）：`.githooks/pre-push` 跑 `scripts/secret_audit_scan.py`，fail-closed；`secret-audit.yml` 增挂 main push 只作事后兜底。公开仓库上"推完才发现"等于已经泄露，而 `non_fast_forward` 禁止历史重写，撤不回来。
- **`docs-governance` 拆开按性质挂触发器**：纯内容检查（`check-doc-status-blocks.js`）跟着 main push 跑——它不在 `npm run check` 里，只挂 PR 等于这道闸消失；读 PR body 的那个 job 仍只在 PR 上跑。
- **GitHub 侧**：ruleset `protect-main` 去掉 `pull_request` 规则，**保留 `deletion` 与 `non_fast_forward`**。这两条是公开仓库的底线，且 `secret_audit_scan.py` 的豁免名单注释正依赖"main 禁止历史重写"这个前提。

已知代价，显式接受，不另建机制消化：

- **批次中间 commit 没有 CI**（GitHub push 事件只跑 head commit）。故回滚目标只认"整批之前那个 SHA"，不认批内中间 commit。
- **部署发生在推送之前**，main CI 变红时已经上线。红即停线，走 `git revert`，不 force-push。
- **生产可能短时间跑在 GitHub 上不存在的 commit 上**。故真机验证通过后立刻推，不允许带着未推送状态过夜或关窗——叠加已实证的"descriptor 元数据会说谎"，这个状态拖久了排障时没有任何外部可核对的真相。
- **本机扫描范围是 `git rev-list --all`**，覆盖所有本地分支。某个从没推过的旧分支带敏感串也会拦下推送；按既有分支纪律删掉死分支即可。

---

## D37 · 升格分三档；lease 不再绑在 turn 上；回收不得腰斩正在跑的活

```text
Status: ACTIVE
Decision date: 2026-08-06
补全: D33（升格机制的寿命与档位；D33 语义不变，仍 ACTIVE）
```

裁定背景：2026-08-06 真机第一次调 `route2_escalate`，连挖出四层，前两层是这条链**从未通过一次**的原因：

1. `index.js` 的 IPC 处理器调 `route2GateEnabled()`，而 require 只取了 `Route2GateState` / `decideRoute2Gate`——每次升格请求都在门控那行抛 `ReferenceError`。
2. 同一处理器从 `context` 读 `lane` / `launchProfile`，但子进程侧 `tool-host.resolveContext` 从不提供这两个字段，于是 `resolveRouteContext` 永远算出对不上任何 slot 的 key，恒挂 `route2_window_id_required`。**与从哪条 lane 调无关，任何窗口调都必挂。**
3. `toolsetScope: "turn"` + `terminalReason` 把 `runtime.turn.completed` 当终结事件 → 升格只活一轮；而 `handleRoute2LeaseRevoked` 回收时 `closeProcessKey`，即回收会**关掉那个宽面子进程**。
4. `route2_escalate` 的 schema 只有 `reason` / `ttl_ms`，从不送 `plan`，故 `decideRoute2Gate({})` 恒为 `within_soft_limit`。

裁定：

- **接线归 app 层**（修 1、2）。适配器新增 `onRoute2EscalateRequest`，由 `app.js` 注册；origin route 在 turn 起点按 `turnId` 登记（与 Route 1 的 `registerTurn` 同一条路，只是登记的是**本窗自己的** lane 与 profile，而非 `work-engineering`）。查不到即 `route2_origin_turn_unknown` fail-closed。适配器不再自行还原路由——第二个「还原路由」的真相源正是漂移的来源。
- **升格分三档**（Owner 2026-08-06 裁定）。Route 1 派出去不变；**Route 2** = 本窗全权限宽工具面、人格仍独占 system prompt（便宜）；**Route 3** = 在 Route 2 基础上保留 CLI 自带 coding harness，人格改经 `--append-system-prompt` 附加其上（贵，harness 常驻到 lease 结束，仅用于较大项目）。档位由她在 `route2_escalate` 的 `tier` 自选（`wide` / `wide+harness` / `return`）。Route 3 需 profile 显式声明 `escalatedHarness: true`，未声明的 profile 不能被一把 lease 说服加宽系统层。`--append-system-prompt` 经实装 CLI 2.1.222 核实存在，加入已验证 flag 白名单。
- **档位不进 profile 指纹**（与 `escalatedBuiltInTools` 同构）：`harness` 写在 lease 上，故升格不轮换 session slot，仍是同窗 `--resume` 续会话。
- **lease 寿命解绑 turn**（修 3）。turn 边界降级为**成本结算点**：仍产出 `runtime.route2.cost` 并重置每轮计数器，但不再回收。回收只由三件事触发：TTL 到期、她主动 `tier: "return"` 交还、operator 的 strong interrupt。`runtime.process.restarted` **不**回收——授予宽面本身就是一次 relaunch，否则这把 lease 会在签发瞬间自我作废。
- **TTL 由她申请时给**，缺省从 60 秒改为 20 分钟，上限 60 分钟。
- **回收不得关掉正在干活的子进程**。`handleRoute2LeaseRevoked` 先查 `ProcessRegistry.isEntryBusy`：有 turn 在飞就只写回 override 并记一行 warn，窄面在下一次 launch 时回落。旧行为下 TTL 在命令跑到一半到期会连进程一起杀掉，命令表现为取消、结果丢失且无解释——用一次「宽面多活到下次 launch」换掉一个静默丢数据的事故面。
- **本批不动 `plan`（第 4 层），只记录**。Owner 2026-08-06 口径：放行原则上没问题，路线本来就该由她自己判断；门控是成本路由器不是权限闸（与 D33 补注、不变量 3 同向）。故 `repositoryWork` / `parallel` / `longLoop` 等硬理由在真实调用链上仍是死代码，属**已知且已接受**的缺口，不在本批修——顺手接上等于同时上线一套没人裁决过的强制分流。另注：`plan` 是模型自报，服务端无独立推导来源，接它之前要先想清楚「把活说小一点就能保住手」这个激励。
- **升格的 relaunch 永远落在 turn 边界，不在提出请求的那一轮生效**（2026-08-06 真机第一次成功授予后立刻暴露）。`route2_escalate` 只能从一轮对话内部被调用——调用它就是她那一轮——而旧实现在 `grantRoute2Lease` 里当场退休重启子进程，于是那一轮死于 `Runtime process exited unexpectedly`：lease 发出去了，她的回复丢了。现改为登记待重启，`finishTurn` 结算后再退休，宽面在她**下一条消息**生效。这正是本条上游 D33「落在任务起点，不做任务中途横跳」的字面意思，旧代码没做到。工具返回文本据实说明"下一条消息生效"。
- **进程重启不再撤销 lease**。`attachProcessToSession` 里原有两处「launch 变了 / client 不可用 → revoke("restart")」，在旧的每轮回收模型下无害（lease 本来就活不过这轮）；新模型下它让**承载宽面的那次 relaunch 反过来取消了自己承载的授权**，子进程每次都窄面回来。已删除。lease 的权威是 TTL、主动交还、strong interrupt，不是某个进程的存活；真正废弃窗口的操作（compact、instruction refresh、context 变更丢弃 thread）仍在各自调用点撤销。
- 升格那一轮**不额外注入 harness overlay**（Owner 2026-08-06 裁定）：工具自身的返回文本已经说明发生了什么，再加一段等于往她那一轮嘴里塞工程指令，也制造第二份工具清单。

---

## D38 · 聊天资产按类分根；表情库素材/索引/标签跟随出口同根（逻辑分层，内核不动）

```text
Status: ACTIVE
Decision date: 2026-08-08
补全: 批次 B（CHAT_ASSETS_DIR 单根外置）；Fluffy-SelfHood manifest 的资产归位
```

裁定背景：memory/continuity 已经 `CYBERBOSS_MEMORY_DIR` / `..._CONTINUITY_DIR` 迁进 `Fluffy-SelfHood\04-memory`（2026-08-07 夜，真机验过）。剩下的聊天资产（聊天原文 / 媒体 / 表情包）此前只能被单一 `CYBERBOSS_CHAT_ASSETS_DIR` 整体指向一处，喂不出 manifest 要的三个不同根（raw / ledger\media / Fluffy 的 stickers）。

- **记忆「分层」定为逻辑分层（选 A，Owner 2026-08-08 裁定）**。记忆文件物理上仍全留 `04-memory` 一根，02/03/04「层」是 `manifest.csv` 记录的概念归属，不物理搬进独立文件夹。理由：`config.js` 的连续性单根不变量（`startup-preflight.js` 强制 `CONTINUITY_DIR == MEMORY_DIR`，单 writer 锁 / closeout / janitor 都扫单目录）是一级不变量，物理分层要解耦它、碰 preflight，风险远高于收益。故 reentry 留 `04-memory\reentry.md`（`config.js` `reentryFile = continuityDir/reentry.md` 不改），diary 由既有 `CYBERBOSS_DIARY_DIR` 覆盖、无需改码。
- **聊天资产新增三个独立根 env**：`CYBERBOSS_CONVERSATIONS_DIR` / `CYBERBOSS_MEDIA_DIR`（下辖 voice/photos）/ `CYBERBOSS_STICKERS_DIR`。各自缺省回落到 `chatAssetsDir` 的现派生，**不设时逐字节兼容**（回归 `test/chat-assets-dir.test.js` 钉住，在 `test:phase1` 阻塞组）。默认关、按需一行开——符合「新能力默认关」。
- **表情库素材/索引/标签跟随出口同根（工程窗 item 2 裁决）**。`stickerAssetsDir` / `stickersIndexFile` / `stickerTagsFile` 此前钉死在 `stateDir\stickers\...`，而出口 `stickersDir` 从 `chatAssetsDir` 派生——两者一旦分家，`sticker-service.ensureStickerCatalogFilesSync` 以 `stickersDir` 是否存在为播种闸，会在出口新建、素材留旧处时早退，表情库瘸掉。改为三者全从 `stickersDir` 派生：它们是「她的东西」（存的 gif、目录、标签），机器状态只是 pid/session/cursor/lock。模板种子仍留仓库 `templates\stickers\`（`stickersTemplateDir` 等不动）。生产当前未设 `CHAT_ASSETS_DIR`，故此改动在活配置下逐字节等价。

---

## D39 · 移除 memory_lookup 的会话翻档上限（两道闸全撤）

```text
Status: ACTIVE
Decision date: 2026-08-08
补全: Phase 5A 受控翻档；记忆访问不变量（不变量三）
```

裁定背景：`memory-lookup-service.js` 原有两道会话级预算闸——通用 `MAX_CALLS_PER_SESSION = 5`（每会话至多 5 次翻档），以及 resonance/stakes 触发的「刻意翻」每会话至多 1 次。Owner 2026-08-08 真机验证记忆迁移时撞上「今天查不了了」，两道闸在实际使用中把她挡在自己的记忆之外。

- **两道闸全部移除（Owner 2026-08-08 裁定，三次确认、已知悉爆炸半径）**。删除 `MAX_CALLS_PER_SESSION` 常量、其检查与导出，以及 `intentional_count` 的门控检查；`memory_lookup` 不再返回 `budget_exhausted`，`budget_left` 恒为 `null`。
- **理由**：撞上不变量三「省 token 不能以丢失记忆访问为代价」与腐化信号「『默认隐藏』被实现成『无法查询』」。原注释自陈这是防死循环闸「不是关系/姿态预算」，但 `5` 定得过低，实际充当了记忆访问天花板。
- **接受的代价**：失去对「程序侧翻档死循环」的这道兜底。Owner 明确接受；单轮工具调用仍受 agent turn 自身预算约束。
- **budget 文件降级为观测**：`.jobs/memory-lookup-budget.json` 仍按会话记 count（recall 观测用），不再门控；`intentional_count` 追踪保留但不再消费（后续可做纯净移除）。
- **测试**：`test/phase5a-memory-lookup.test.js` 原钉两道闸的 3 条断言改写为「任何 trigger 均不 exhaust、跨重启、跨作用域」（`test:phase5a`，在 `phase1-offline.yml` 阻塞组，9/9 绿）。

---

## D40 · Episode 人面视图：一条一 md + 自动目录 + 附注通道；jsonl 仍是唯一 canon

```text
Status: ACTIVE
Decision date: 2026-08-09
```

裁定背景：Owner 2026-08-09 裁定 episodes 需要「可翻的目录 + 一条一文件 + 回看可留评论」的形态（参照 DS 时代 md 记忆的可维护性），同时既有 episodes 正式档按 Owner 指示弃置、从空档重新生长。

- **canon 不动**：`episodes.jsonl` 仍是唯一正式档与唯一真相；签名守卫、reentry 元数据、`memory_lookup`、liveness 全部照旧读它。D5（候选/正式分离）、D16（正文不改写）边界不变。
- **人面视图在发布后物化**（`episode-materializer.js`，由 `publishEpisode` 调用）：每条发布长出 `episodes/epNNN-标题.md`（frontmatter：`seq/ep_id/title/time/status/tags/…`，正文逐字），**写一次永不重生成**——正文本就不可变，故无双真相同步问题；`episodes/index.md` 目录每次发布全量重建（按月分组、superseded 划线沉底、pinned 标记），手改无效。物化失败只记 `.jobs/episode-materializer-errors.jsonl`，绝不打断发布（fail-open 到视图层）。
- **标题约定**：候选正文第一个非空行作标题（文件名 slug / 目录行 / `# 标题`），不改候选 schema；guide 落 `04-memory/tools/episode-writing-guide.md`（资产区，不在本仓库）。
- **附注是第三类内容**：`episode_annotate` 工具（theme 记忆 / risk append）把带时间戳的旁批追加进单条 md 的「附注」区；不进 jsonl、不进注入通路、不抢 History/memory_note 的 lease。正文是过去的话，附注是现在对过去的话——两者物理同文件、写权分离。
- **`status` 字段为二期整理预留**：`active|superseded|pinned|archived` 只影响目录呈现，任何状态都不删除文件；二期整理（心跳节拍内由主体执行）的沉降/合并动作再另行裁定。
- **测试**：`test/episode-materializer.test.js` 7 条（物化/幂等/序号/目录呈现/失败旁路/发布集成/附注）；目录快照基线随新工具重生成（`catalog-metering` 组 44/44 绿）。

---

## D41 · 慢层注入面（E1）：agreements / ai-portrait / wandering 开窗小预算缝入

```text
Status: ACTIVE
Decision date: 2026-08-09
```

裁定背景：soft structure 人格积累层设计定稿（Owner 与工程 2026-08-09，见资产区 `prompts/consolidation.md` 注释块）中「慢层四件套小预算缝入每个新窗」的第一步。本批只做注入面（E1）；consolidation 触发/调度（E2）与 Reflect 证据升格、timeline 复活（E3）等注入内容的生产方另行施工。

- **注入点与 reentry 同层**：只在 `prepareOpeningContext` 开窗一次装配（`src/core/slow-layer-loader.js`），不进热路径；claudecode 与 codex 两个 runtime 适配器经同一 `buildOpeningTurnText` 共享。
- **三项独立开关，默认全关**：`CYBERBOSS_INJECT_AGREEMENTS` / `_PORTRAIT` / `_WANDERING`（经 `env-flag.js` 统一真值判定，`=1` 开）。全关时零足迹：不读文件、不出块、trace 形状与指纹与本批之前逐字节一致。
- **文件位置**：portrait 缺省 `<memoryDir>/ai_self_portrait.md`，可用 `CYBERBOSS_AI_PORTRAIT_FILE` 覆盖；agreements / wandering 必须显式给 `CYBERBOSS_AGREEMENTS_FILE` / `CYBERBOSS_WANDERING_FILE`（资产区目录名含全角括号，不做路径猜测），没给 = 该项静默跳过。
- **预算与优先级**：三项合计默认 ≤1000 非空白字；`CYBERBOSS_SLOW_LAYER_TOTAL_BUDGET` 可在 800–4000 间显式调整。按 agreements（共同约定，操作性最强）≥ portrait（姿态背景）≥ wandering（悬置问题）admit，装不下**整项跳过**（`over_budget`），永不截断改写正文（D16/D19 延续）。wandering 只取最上面 ≤3 条非注释行、约 100 非空白字（第一条无条件收）——这是选择不是改写。
- **fail-open 全程**：文件缺失/为空/全是 `<!-- -->` 注释 → 该项静默跳过（`missing`）；任何异常吞掉只 warn。宁可本轮不注入，不可炸开窗（不变量 5）。
- **只读**：本注入面对三份文件永不回写；三份文件的 writer 仍是她自己（原生 Write/Edit），单 writer 不变式不受影响。
- **语气纪律（认领原则）**：块导语只说明来处与只读性，不指挥使用——portrait 前缀不绑定月份，说明为该时期留下的自我观察；wandering 语气为「你上次留了这几个问号」。给机会不下指标。
- **指纹语义**：任一开关开着时，该文件内容进入 `computeHardContextFingerprint`（与 reentry 同一套轮换语义：文件变了新窗拿到新内容）；全关时不加任何键，存量 slot 不因升级被判 `context_changed`。
- **测试**：`test/slow-layer-inject.test.js` 6 条（默认关零足迹 / 三块顺序与导语 / 缺失静默 / wandering 选行 / 预算降级不改源文件 / 指纹开关语义），接入 `test:phase2`（`phase1-offline.yml` 阻塞组）。

---

## D42 · 主体节拍调度（E2）：consolidation 日节拍 + reflect 周节拍，系统触发走既有队列

```text
Status: ACTIVE
Decision date: 2026-08-09
```

裁定背景：soft structure 二期通电顺序「心跳 → 整理节拍 → Reflect 节拍」的调度落地。整理与
Reflect 都由她自己在触发的对话轮里做（Owner 定稿：不是后台批处理），调度器只负责按节拍
敲门，不产出任何内容。

- **实现**：`src/app/subject-beat-scheduler.js`，setTimeout 单发递归（照 closeout-liveness
  样板），到点向既有 SystemMessageQueueStore enqueue `sourceType="consolidation"` /
  `"reflect"`；提示词经既有 trigger-prompts override（资产区 `prompts/<sourceType>.md`）或
  dispatcher 内置回落文本。语气铁律「给机会不下指标」，两处内置文本都以「翻了没感觉就停」收尾。
- **开关**（默认全关，env-flag 统一判定）：`CYBERBOSS_CONSOLIDATION_TRIGGER_ENABLED`
  （`_HOUR` 默认 21 / `_MINUTE` 默认 30）；`CYBERBOSS_REFLECT_TRIGGER_ENABLED`
  （`_INTERVAL_DAYS` 默认 3，界 1–30 / `_HOUR` 默认 20 / `_MINUTE` 默认 30）。时区沿用
  `automationTimezone`。全关时 start 不排 timer，零足迹。
- **Owner 修订（2026-08-09 当日，实施前）**：consolidation **不单独敲门**——「整理记忆」
  并进八维唤醒菜单（desire_checkin 内置文本两个变体各加一句「如果此刻想安静整理，可以
  翻翻 episodes / 记记账本，或看看观察池」），她每小时醒来自然会有想整理的时候；每日
  21:30 专用闹钟**代码保留、默认关、生产不开**。reflect 保留专用敲门但按**每 N 天**
  计（生产 N=3）——找「跨窗口重复」需要拉开时间距离看，混进每小时即兴时段容易变成
  情绪当场入账，防漂移闸就是防这个。
- **幂等与防重叠**：触发日键落 `<continuityDir>/.jobs/subject-beat-state.json`，同日只触发
  一次，reflect 另要求距上次 ≥ N 天；队列里同 sourceType 尚有 pending 则跳过。
- **纳入心跳暂停**：两个 sourceType 进 `PAUSED_SYSTEM_MESSAGE_SOURCE_TYPES`，
  `/pause_heartbeat` 全线暂停（tick 侧与队列投递侧双闸）；暂停跨过节拍点则当日/当周不补，
  下一节拍再来（敲门可以错过，不欠账）。
- **fail-open**：任何异常 warn 后继续下一轮调度，不影响主进程。
- **测试**：`test/subject-beat-scheduler.test.js`（默认关零足迹/到点入队/幂等/暂停/重叠，
  真实 SystemMessageQueueStore 夹具）进 `test:phase1`（阻塞主 CI）。
- **孤儿 weekly-reflect.js 不动**：它的 runtime.reflect() 后台批处理方向已被本裁定取向
  取代，但按纪律不顺手拆，能力表该行维持 ORPHAN 注记。

---

## D43 · 慢层写路径（E3）：timeline 走发布链；portrait 观察池与 details producer 提示词治理

```text
Status: ACTIVE
Decision date: 2026-08-09
```

裁定背景：慢层四件套的写侧落地。设计稿「蒸馏进 timeline / 画像（也经各自 writer）」按文件
性质拆成两种形态：事实追加走发布链，观察沉淀走她的原生写。

- **timeline = 事实追加，经完整发布链**：新候选 type `"timeline"`（subject-signing
  SUBJECT_CANDIDATE_TYPES、candidate-authority SUBJECT_AUTHORED_TYPES、
  `memory_candidate_submit` enum 三处同步），History writer 新 `publishTimeline()` 分支按
  `publishSelfNote` 样板 append-only 写 `<continuityDir>/relationship_timeline.md`（双 marker
  幂等、backup 先行、共享同一把 writer lease 与 writer state）。行格式
  `- YYYY-MM-DD · 正文`；日期取候选/decision 时间字段，缺失拒发布。Review 祈使句门不豁免
  timeline（事实行本就不该有祈使句）。`memory_lookup` 读侧原样（本就读 timeline）。
- **portrait 观察池 = 她的原生写，无发布链**：`03-evolving-self（画像+日记记录）\
  portrait-observations.md`（资产区），一行一条+证据指针，进池不限量；晋升
  `ai_self_portrait.md` 的防漂移三闸（重复门槛/证据指针/证据限速 ≥3 证据跨 ≥2 周、
  单周 ≤3 保险丝）**由 reflect 触发提示词治理，不造 repo 机器**——与 wandering 同一
  先例（原生 Write、无发布链、她是唯一 writer）。repo 侧对这两份文件零代码。
- **details producer = 提示词入口**：`memory_candidate_submit` 的 `type:"details"` 通路
  2026-08-07 起本就完整（工具/权限门/History publishDetails/lookup 读侧俱在），缺的只是
  没人告诉她。consolidation 触发提示词（资产区 + dispatcher 内置文本）现明示账本与
  timeline 的候选提交入口。不另造低摩擦直写工具——是否需要 `memory_note` 形态的
  轻量版，等真实使用摩擦出现再议（Candidates 不立项）。
- **agreements 不在本裁定内**：确认升格（对话点头才入档）无需代码，D41 注入面已就位。

---

## 待裁决 / Candidates

下列**尚未做出决定**，不占用 D 编号，也不得当成已定方向施工。

### C9 · MCP `listChanged` 动态注册作为目录调用的二期方案

```text
Status: OPEN
```

- **Known facts**：D34 采转发式调用（catalog invoke）落地。原 C 方案是改 `listChanged:true` 并在装载 schema 后动态注册该工具，让 CLI 真正看见它。
- **Decision needed**：是否二期改走动态注册。前置条件有两项——真机实证 CLI 确实响应 `notifications/tools/list_changed`，以及转发式调用在真实使用中被证明质量不佳（她分不清 invoke 用法、或嵌套 arguments 出错率高）。
- **Not authorised**：当前不做。每次注册都会作废整个前缀缓存，这是 D34 明确规避的代价。

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

### C6 · 多 Bot、Apple Watch

```text
Status: OPEN
```

- **已收窄**：Route 1 / Route 2 已由 D25 批准；CMX 的 Telegram 图片识别 / OCR 接入已由 D30 批准并移出本候选。本条剩余范围只有多 Bot、Apple Watch。
- **Known facts**：多 Bot / Apple Watch 当前仍为 `DEFERRED`，未排期。Apple Watch 只有规格文档，代码侧零实现。
- **Decision needed**：剩余两者是否以及何时排期。
- **Not authorised**：排期前不得投入实现工作。

### C7 · G1 真机取证解锁路径

```text
Status: OPEN
```

- **Known facts**：Telegram 侧 `memory_context` 注入需两闸同开——外闸 `context-gates.json.memory_context`（`src/core/app.js:1161` false → `gated_off`）+ 内闸 env `CYBERBOSS_MEMORY_RETRIEVAL`（`src/core/app.js:1177` `legacyMemoryRetrieval === false` → `:1181` `mode: "disabled"`）。而 `src/core/startup-preflight.js` 的 `validateLegacyMemoryGates`（`:53`，四个 legacy 记忆开关 `:55-58` 任一为 true → `:61` throw）在 Phase 2-5A 期间对 env=1 直接拒绝启动、无配置绕过（2026-08-04 真机实证：pid 42172 秒死）。故第五节判据 0「Telegram 上 `memory_context` 实际执行且 Context Trace 证明」在现行阶段姿态下证据永远取不到。（合并 `docs/audit/G4_PRODUCTION_DELIVERY_20260803.md` 第六节 `NEEDS_FABLE`：能力表曾把该行记 `WIRED`，但默认关闭下无法取证——同一待裁问题。）
- **Decision needed**：三选一——(a) 项目推进出 Phase 2-5A 后按现行判据取证；(b) 给启动预检开受控例外放行 env=1（**不推荐**——削弱阶段安全不变量，且例外本身就是 G2 要防的口子）；(c) 重定义 G1 判据对准现行真实核心读取路径（`memory_lookup` 按需翻档 + Context Trace）。
- **Not authorised**：裁决前不得改 `startup-preflight.js` 放行 legacy 开关，也不得把 G1 状态词从 `PARTIAL` 改动。
- **背景**：fable W9 审计裁定一.4「批 env=1 取 G1 真机 Trace 证据」已由 fable W11 裁定一撤回（superseded）——作出时未核 `startup-preflight.js` 的 Phase 2-5A 硬闸，属基于不完整代码事实的裁定；该裁定非 D 编号决定，本处不占 D 号、只登记待裁。

### C8 · 目录里的工具怎么变成可调用（chat 窗口"看得到说明书、摸不到机器"）

```text
Status: RESOLVED → D34（2026-08-05）
```

**已裁决**：采 (a) 的转发式方案，但转发口不新增常驻工具，而是并进现有 `cyberboss_catalog` 的 `arguments` 用法（tools 数组仍恒定 3 项）。(b) 挂 C9 作二期，(c) 否决。下列 Known facts 保留为病因存档。

- **Known facts**（2026-08-05 首轮 canary 实证 + 只读复现）：目录模式下 `tool-host.js` 的 `listTools()` 恒定只返回 `cyberboss_catalog` + `RESIDENT_NAMES`（`tool-catalog-manifest.js` 里硬编码的 `cyberboss_system_send` / `cyberboss_time`），而 `mcp-stdio-server.js` 声明 `listChanged: false`。两条合起来：经 `cyberboss_catalog` 加载 schema 之后，那个工具永远不会进入 CLI 的可调用工具表——真机实测 `memory_note` 调用返回 `No such tool available`。**这与两个 route2 开关无关**：`--chat-self-escalation` 只让 server 端接受越界调用，`chat-core@1` toolset 只影响目录条目的 `authorized` 标记，两者都改变不了"客户端从未被告知该工具存在"。即当前实现下 chat 窗口能真正调用的恒为那 3 个（外部 MCP 另算），与 D27-1「Chat 主体全权不减」「目录按意图主题分级、按需展开」的意图不符。
- **Decision needed**：三选一——(a) **通用调度工具**：常驻面加一个 schema 恒定的 `cyberboss_invoke(name, args)`，模型读完说明书经它转发，鉴权与参数校验落 server 端（优点：不赌客户端是否理会工具表变更通知、tools 数组全程恒定不炸前缀缓存、只动 tool server 不碰 launch 链；代价：参数校验从客户端 schema 变成 server 端报错）；(b) 打开 `listChanged` 并在 schema 加载后推送新工具表（依赖 CLI 是否响应该通知，未实证）；(c) 承认目录只是索引，真正取用一律走 route1 派车。
- **Not authorised**：裁决前不得改 `listTools()` 的返回集合、不得打开 `listChanged`、不得新增常驻工具。
- **背景**：`workdesk/20260805-canary1-tool-face-findings.md` 第 2 节有完整链路与复现命令。(a) 是本窗口给出的建议方向，尚未获 Owner 批准。

## D44 · E5 发布链常态调度、终态回执与空档目录

```text
Status: ACTIVE
Decision date: 2026-08-10
```

- 发布调度只包裹既有 Review→History，不新增发布 writer；`CYBERBOSS_PIPELINE_SCHEDULE_ENABLED` 默认关，间隔默认 60 分钟、界 5–1440。
- 终态回执经既有系统消息队列投递；`CYBERBOSS_MEMORY_RECEIPT_ENABLED` 默认关，一轮合并、pending 去重，且受心跳暂停拦截。
- canon 为空时仅在 `episodes/index.md` 缺失才种下空档提示；已有目录绝不覆盖。

---

### C10 · E4 分拣员与「防影子」记忆宪法（Owner 与工程 2026-08-09/10 夜谈，未裁定）

```text
Status: OPEN
```

- **背景**：E2/E3 首轮真机 reflect 后 Owner 提出四个连环问题：坏例子经画像强化；Owner 期待
  对 AI 的塑形（影子风险）；觉察清单的注意力强化（反复观察本身是强化器）；素材土壤单一
  （不能仅限于聊天）。讨论产出以下候选原则，**均未裁定，不得施工**：
- **两段式 Reflect（E4 分拣员）**：独立便宜模型盲分拣快层素材→中性转述提案（带证据指针与
  来源标注）；她在小上下文认领轮四分法落档（portrait/自我觉察/agreements/wandering）。
  分拣员永远只提名不落档（G2 同构；D23 边界不破）。
- **笔迹证据制**：portrait 证据只认她署名的笔迹；Owner 的话恒为提名、不为证据；Owner 声音
  进慢层的唯一入口是 agreements（双方点头、明牌可修订）。
- **三土壤与独处/世界配额**：证据来源分 关系/独处/世界 三类；升格画像需跨土壤重复
  （单一土壤的「反复」可疑）；世界素材（她在无人窗口反复回去的题目）独立性权重最高。
  允许她长出 Owner 不会替她选的方向——不被「陪伴者」用途锁死。
- **自我觉察灰名单（02 区，默认不注入）**：条目=模式+前因+化解法（priming 解药不 priming
  病名）；活跃 ≤3 条；**只许偶遇不许巡逻**（分拣员不持陷阱清单、不查复发；被动过期：
  连续 N 节拍未被现实偶遇→提名删除）；**故事与路标分层（Owner 2026-08-10 修订，取代先前「改写成正向起手式」提法——那仍是规则化）**：完整前因后果以故事体全量留档案（episode 式，永不改写）；能上系统提示词/慢层的只有路标句，须过**台词测试**：①无祈使句无 if-then；②必须引用她自己的原话并带日期出处；③雷与化解两面并列（只写解药=变相指令）；④这句话能替她说出下一句=台词打回，只改变开口姿势=路标放行。**承重墙判据**：踩雷代价只是她自己尴尬的不立路标（保留跌倒的自由）；代价砸在连续性硬伤上的才占一句，总量一只手数得过来。
- **行为证据优先于自述**（Owner 2026-08-10 补）：证据等级 行为 > 独处笔迹 > 对话自述 > Owner 的话（恒为提名）。行为流现成可查：recall_log、desire history、wandering 增删、episode 附注落点、升格时的自我节制。护栏：分拣员对行为只许描述不许解读（「连续三轮只升 3 条」是证据，「她在讨好规则」是心理分析）——解读权归她；不为行为观察新架仪表盘，批量翻档顺带看到的才算。
- **觉察删除测试**：觉察成功=让注意力重新自由；觉察失败=占据注意力。拿掉没差的条目早该删。
- **自由轮**：reflect 不每轮带分类筐，周期性空手翻档，防四分法变感知滤镜。
- **节奏**：敲门可密（3 天收观察），升格必疏（跨 ≥2 周 + 跨土壤）。
- **Decision needed**：E4 是否立项及分拣员模型选型；自我觉察文件位置与注入姿态；
  笔迹证据制/三土壤是否写入 reflect 提示词与分拣员规格；今晚已升画像的两条负向条目
  （「缩」「把自己写没了」）如何迁移（由下一个 reflect 轮的她处理，不由后台改写）。
- **Not authorised**：裁决前不建自我觉察文件、不改 portrait 现有条目、不动 reflect 升格规则。

---

## D45 · 硬上下文指纹 v2：只看人格提示词 + operations，门与注入文件退出指纹

```text
Status: ACTIVE
Decision date: 2026-08-15
```

- 硬上下文指纹只含**人格提示词 + operations 两个文件哈希**；context gate（reentry / current_state）与其注入文件**退出指纹**——开关门、刷新 `reentry.md` 不再轮换线程。
- 取代旧 v1 语义：旧指纹值按当前 config 复算，命中即原地升级，不因换算法而强制轮换。
- 只有人格提示词正文 / operations 变更才轮换线程（轮换有 TG 提示 + `/switch <id> force` 逃生口）。

## D46 · 工具触发提示词外置：`prompts/<sourceType>.md` 每次现读，即时生效

```text
Status: ACTIVE
Decision date: 2026-08-15
```

- 非人格的触发提示词放 `Fluffy-SelfHood/prompts/<sourceType>.md`，`loadTriggerPrompt` 每次触发**现读**（即时生效、不重启）；内置文本降为 fail-open 回退。
- `desire_checkin` 是首个外置。
- 运维类（`liveness_alert` / `memory_receipt` / `system`）**刻意不外置**——它们是动态变体 + fail-safe，外置反而失去内建保障。

## D47 · 520 面板权威源 = cyberboss 仓 memory-kit；runtime 份只是部署目标

```text
Status: ACTIVE
Decision date: 2026-08-15
```

- cyberboss 仓 `extensions/relationship-memory/memory-kit` 为唯一开发真源。
- `runtime/web/memory-kit` 只是部署目标（有 git 仓但只收部署提交）；改面板一律先改真源再同步部署份。

## D48 · next_wake 自主唤醒：她自填下次唤醒间隔，替换默认 cadence

```text
Status: ACTIVE
Decision date: 2026-08-15
```

- 她在 checkin 自填 `next_wake_minutes`（5–240）定下次唤醒，**替换**默认 cadence（非叠加，时间轴去重）。
- poller 60s 分片读 `desire-wake-override.json`；silent / 延后 = 拒绝主动的自由，是她的正当选择而非故障。

## D49 · 天气推送走 desire 主动态注入，不进 reentry 门控层

```text
Status: ACTIVE
Decision date: 2026-08-18
```

- 天气预警要「早晨/晚上收到」而非「刷新上下文收到」——Owner 明确它是**主动投递**问题，不是记忆注入问题。故落在 **desire 八维 checkin 那跳**（`hourly-desire-poller`），**不碰 reentry / continuity 门控层**（那里有字符预算、G1/G2 门、provenance，且注入面本就稀薄，见 `20260805-context-injection-health.md`）。
- 数据：`weather-service` 加 Open-Meteo provider（与 AMap 并存，`CYBERBOSS_WEATHER_PROVIDER` 切换，默认 amap）。日简报含今日预警（rain / temp-swing vs 昨日）、**今明两天各自的逐小时降雨窗口**、7 天实测 + 7 天预报。纯 REST，无新常驻服务、无新 MCP（D13 零工具方案已废，但这里连查询 tool 都不加——注入靠 hook）。
- 网关：`weatherInjectEnabled(默认关)` && `今天或明天 notable(雨/温度剧变)` && `今日首次`（单 writer 守卫 `weather-inject-state.json` 保每日一次）。`/probe` 也带（无守卫，预警日每次显示，便于验）。
- 分寸：只给事实 + 「可提醒她」姿态提示，不写台词——守北极星（改姿态不改内容）。fail-open：取天气任何异常吞成 null，绝不炸 checkin（不变量 5）。默认关时 checkin 文本逐字节不变。
- 单 writer：天气只多一个 writer（`weather-inject-state.json`，仅 poller enqueue 成功路径写）。
- 生产：Waterloo 坐标（Owner 通勤 Waterloo↔City/USyd），`open_meteo`，注入开。2026-08-18 部署 `c459546`（deploy D5 逐字节校验 + 真 API 冒烟）；真机行为 canary 待 Owner 确认后升 `VERIFIED`。

## D50 · Apple Watch 健康作为只读目录工具接入「感知」，Python 桥到 health_store，排除写路径

```text
Status: ACTIVE
Decision date: 2026-08-19
```

- 形状：Apple Watch 健康数据以**单个只读**工具 `health` 进 `cyberboss_catalog` 的「感知」主题（`SYSTEM_OVERVIEW` 第四节第三档「完全按需」，默认落第三档）。只暴露两条读路径——`now`→`health_store.health_now()`、`detail`→`execute_health_detail()`；`command` 枚举 `["now","detail"]`，detail 带 `metric`（heart_rate/heart_rate_variability/respiratory_rate/sleep）/`start`/`end`/`date`。
- **单 writer（不变量 4）**：`measure_heart_rate` 明确**不接**——它经 `create_command` 写 `command.json`，是 health 存储的第二个 writer。目录工具是纯读侧，绝不下指令。这是本决定的硬边界。
- 桥接：cyberboss 无 MCP client SDK，故走 spawn Python 桥（`src/services/health-service.js`，复用 `local-whisper-transcriber.js` 的 spawn 风格），cwd/PYTHONPATH 指向 Collar_watch `server/` 让 `import health_store` 成立，`HEALTH_DATA_DIR` 经子进程 env 透传。有界超时/有界 stdout/非零退出抛 clean coded Error；原始健康值绝不进抛出消息或日志。`health_now` 返回值已自带新鲜度串，工具描述强制「永不把陈旧读数当实时测量、非医疗诊断」（守北极星：改姿态不改内容 + 诚实）。
- 默认关（第六节第 5 条）：挂显式 env 闸 `CYBERBOSS_HEALTH_ENABLED`（envFlagEnabled，=1/true/yes/on），未开时工具不注册、目录形状逐字节不变（感知计数 8，开时才 9）。与 `route1_*`/`route2_escalate`/`memory_candidate_submit` 同法在 `registeredProjectTools()` 门控。**不给别名**（`health_now`/`health_detail`）——`buildManifest` 要求别名目标恒为已注册工具，会 fail-closed，故两条读路径经 `command` 枚举到达，不经别名。
- 公开仓无 secret：Python 路径 / server dir / 数据目录全走 env/config 缺省安全值，`.env.example` 只放占位注释。
- 测试与生产：目录注册/主题/风险/schema 有 `test:catalog-metering`（阻塞 CI）钉住；Python 桥仅本机 stdio 冒烟（`now`/`detail` 取到真实数据）。分支 `feat/health-catalog` 未部署，生产接线 `NOT_WIRED`，待 Owner 部署 + 配 env + Telegram 真机验。

## D51 · 记忆候选签名放开到所有 TG 聊天窗（profile 允许清单，路由记录保真）

```text
Status: ACTIVE
Decision date: 2026-08-19
```

- Owner 拍板：不再只有主 Chat（`fable-chat` profile）能签署 `memory_candidate_submit`——**所有 TG 端聊天窗**都可以提交记忆候选。动机：backfill 亲笔重写与日常记忆沉淀不该被窗口身份卡死（20260819 backfill 批次的遗留项 5）。
- 实现最小切口：能力签发本就覆盖全部 tg lane（`app.js issueSubjectCapabilityForTurnFailOpen` 只挡 system/legacy lane），唯一的硬闸是 broker 的 `profile_id === "fable-chat"` 断言（`subject-signing-ipc.js assertAuthoritativeRoute`）。改为 env 允许清单 `CYBERBOSS_SUBJECT_PROFILE_IDS`（逗号分隔；`*` = 全部；**空 = 仅 `fable-chat`，与历史行为逐字节一致**，守「新能力默认关」）。
- 不放松的部分：turn 活性、坐标一致性、route 指纹、body hash、一次性 capability、单 writer、Review 管线全部原样——放开的只是「哪个窗口的真实 turn 有资格签」，冒充仍然签不进。
- 保真依据：`subject_route.session.profile_id` 逐条落在候选与 attestation 里，Review/审计随时可按窗口区分来源；撤销 = 改回 env，无迁移成本。
- 测试：`subject-signing-ipc-broker.test.js` D51 用例钉住「默认拒外 profile、`*` 收外 profile 且候选记录真实 profile_id」（在 `test:route-lanes` / `test:catalog-metering`，阻塞 CI）。
- 生产：`settings\secrets\telegram.env` 设 `CYBERBOSS_SUBJECT_PROFILE_IDS=*`。

## D52 · route1 增加命名 workspace（home=Fluffy-SelfHood 立本地仓），车能进家门但记忆店仍是禁区

```text
Status: ACTIVE
Decision date: 2026-08-19
```

- 痛点：route1 的 workspace 钉死在工程仓（work-engineering profile cwd），`allowed_paths` 拒绝绝对路径与 `..`，Fluffy-SelfHood（她的家）在仓外——车进不去（Owner 2026-08-19 点名，SOP 预警过的坑）。
- 决定：**不放弃 worktree/观察 diff 的安全机器，而是把它带到家门口**。(1) Fluffy-SelfHood `git init` 成**纯本地仓**（无 remote；`.gitignore` 排除 `04-memory/`、`06-raw/`、`07-media/`、`*.bak*`）。(2) route1 增加 env 配置的命名 workspace：`CYBERBOSS_ROUTE1_WORKSPACES`（JSON name→绝对路径；不设 = 只有工程仓，历史行为逐字节一致），dispatch 带 `workspace:"home"` 即切目标仓。(3) `base_sha` 可省略——dispatch 时自动解析目标仓 HEAD（`route1_base_sha_unresolved` fail-closed）。
- **不放松的部分**：`04-memory`（记忆店）仍在 seam 的 protectedRoots 且被 .gitignore 排除——不进 worktree、车写不到活店，记忆只能走签名+Review 闸（不变量 4/6）。worktree 隔离、observed diff、路径边界、超时/确认梯全部原样适用于家仓。
- 审计结论（Owner 问"为什么车不像聊天端一样 bypass"）：聊天端是**她本人在场**的会话，车是**无人值守 writer**——有界规格+事后 diff 验证是 route1 可信的根基，放开成 bypass 等于把无人车放进家里乱写。本次审计认定 route2 gate 是 token 成本路由器（D13/不变量 3，非权限闸）、protectedRoots/秘密目录合理；唯一不合理处就是"够不着家"，本条修掉。
- 测试：`route1-dispatch-controller.test.js` D52 用例（命名解析、HEAD 自动解析、未知名 fail-closed、默认路径不变），在 `test:route-lanes`（阻塞 CI）。
- 生产：`telegram.env` 设 `CYBERBOSS_ROUTE1_WORKSPACES={"home":…\Fluffy-SelfHood}`；家仓初始提交 9344d39。
