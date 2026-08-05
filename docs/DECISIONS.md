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

> **补注（2026-08-05，真机 canary 实证）**：本条的升格机制此前**没有触发方**。`grantRoute2Lease` 在生产代码里零调用点（唯一调用在 `test/claudecode-approval.test.js`），`decideRoute2` 连测试都没有调用，因此 `escalatedBuiltInTools` 永远换不上——真机实测她无论怎么要求都只有 `Read/Glob/Grep/WebFetch/WebSearch`。更深一层：即便接上调用方，`decideRoute2Gate` 的 `no_tools` 是硬理由，而内建面升格按定义不点名任何 MCP 工具，于是恰好被挡在门外。现按本条明文（「升格判据是要动本地或执行命令」）修复：闸门新增 `builtInFace` 这条轴（不点名工具不再等于无效计划，其余结构性硬理由——repositoryWork / subagent / parallel / longLoop / fullEngineeringHarness——一条不减），并补上触发方 `route2_escalate` 工具（经既有 route1 IPC 通道到 bridge，挂 `CYBERBOSS_ROUTE2_GATE_ENABLED`）。本条语义不变，补的是从未接上的那根线。

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
