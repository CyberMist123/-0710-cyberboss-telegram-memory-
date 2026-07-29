# 欲望引擎补充设计：让后台自己记账，让闪念来自真实经历（只读期）

```text
Status: supplemental
Authority: none
Scope: 欲望系统四件事的方案与代价 —— 后台记账、闪念入池、观察面、checkin 提示词软化
Last reviewed: 2026-07-29
Current authority: docs/CURRENT_STATUS.md
Line numbers verified against: main 6425477
Depends on: PR #46（尚未合入基线，见第五章）
```

> 本文可以独立更新，只提供参考或证据；它不是当前状态，也不是已经批准的决定。
> 本文要裁定的四件事都以「2-3 个方案 + 代价 + 推荐」的形式给出，最终选哪个由 Owner 拍板。

---

## 〇、这份文档的边界与用词

### 本文管什么

issue #55 提出的四件事，一件一章：

| 章 | 要裁定的事 | 一句话 |
|---|---|---|
| 一 | 后台记账 | 让引擎在心跳里真跑起来，但**只算不覆盖**；AI 自报从「唯一真相」降为「主观修正」 |
| 二 | 闪念入池 | 念头的文字取自真实经历，逐个指认从哪些现有落盘/通路采集 |
| 三 | 观察面 | 520 能看到 drive / scores / intent / 念头池，只读 |
| 四 | 提示词软化 | 心跳提问从「填八个数字」改成「先说人话」 |

**本文不管**：欲望是否覆盖行为（那是 `DESIRE_DRIVEN` 总闸的事，本期明确不开）、基线漂移与自我驱动（碰感情，明确不在本期，理由见第六章）、维度数要不要增减（等引擎跑出数据再说）。

### 用词表（每个词第一次出现就在这里）

| 词 | 意思 |
|---|---|
| **drive / 驱动条** | 八个 0..1 的数字，代表八种内在缺口：依恋 attachment、好奇 curiosity、沉思 reflection、责任 duty、社交 social、疲惫 fatigue、性欲 libido、压力 stress。定义在 `src/core/desire.js:1-10` |
| **闪念 flit** | 一条刚冒出来的念头，每拍自动变弱，弱到底就消失 |
| **执念 fixation** | 闪念被反复点到、强度涨过阈值后升级成的东西，每拍自动变强，强到一定程度会「反哺」对应的驱动条，把那一维顶高 |
| **念头池 thoughts** | 装闪念和执念的一个数组，每条 = {文字, 关联维度, 类型, 强度, 出生时间, 已反哺次数} |
| **score / 召唤力** | 驱动条值 + 关联执念强度 × 加成系数，用来排序「此刻最想做哪一类事」 |
| **intent / 意图** | 排完序之后的结论：`{want_action, drive_key, reason, score, query_hint}` |
| **不应期 refractory** | 刚满足过的那一维，短时间内不许再被选中（「刚做完别马上又馋」） |
| **耦合网 coupling** | 一维涨落牵动另一维的一张边表，是反馈系统，会自激震荡 |
| **基线漂移 baseline drift** | 长期见不到人，「想念」的地板缓慢抬高。**碰感情，不在本期** |
| **gate / 闸** | 一个环境变量开关，默认关；关的时候只读可看、不动手 |
| **ORPHAN** | `docs/CURRENT_STATUS.md` 第二节状态词典里的词：代码存在，但目标主路径不可达、没人调用 |
| **writer / 写入者** | 某个文件的唯一写入代码路径。同一文件出现第二个 writer 是一级腐化信号（`CLAUDE.md:49`，`docs/DECISIONS.md:68` D4） |
| **canon / 正式档** | `episodes.jsonl` 那条正式记忆档。任何路径都不许让外部直接写它（`CLAUDE.md:51`，D5 在 `docs/DECISIONS.md:79`） |
| **fail-open** | 出错时宁可本轮失忆，不可本轮失联（`CLAUDE.md:50`） |

---

# 一、现状核对

**这一章是后面全部方案的地基。每一条断言都带 文件:行号，都是本次亲自打开核过的（基线 main `6425477`）。**

## 1.1 生产上现在真的在跑的那条通路

只有一条，全长如下：

```text
hourly-desire-poller.js  每 55 分排一拍，把一句提问塞进系统消息队列
        ↓
system-message-dispatcher.js  给这句提问套上「必须输出八维 JSON」的模板
        ↓
AI 回一段 JSON
        ↓
app.js 解析出 desire_state
        ↓
persistReportedDesireState  落盘 desire-state.json + 追加 desire-history.jsonl
```

| 环节 | 位置 | 关键事实 |
|---|---|---|
| 排程 | `src/app/hourly-desire-poller.js:10-12` | `config.desireDriven` 为假就直接 `return`，连提问都不发 |
| 首拍 | `src/app/hourly-desire-poller.js:27` | 第一拍排在整点后 55 分 |
| 入队 | `src/app/hourly-desire-poller.js:41-51` | `sourceType: "desire_checkin"` |
| 提问文本 | `src/app/hourly-desire-poller.js:195-198` | 现文：「回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？」 |
| 提示词模板 | `src/core/system-message-dispatcher.js:50-68` | `desire_checkin` 专用分支 |
| 落盘 | `src/core/desire-state-persistence.js:10-36` | `persistReportedDesireState` |
| 落盘调用点 A | `src/core/app.js:3094` | 在 `handleSystemReplySent`（`app.js:3084-3101`）里，该方法经 `app.js:170` 注册成 stream-delivery 的 `onSystemReplySent` 回调 |
| 落盘调用点 B | `src/core/app.js:3127` | 在 `maybeSaveDesireStateFromTurnText`（`app.js:3117-3133`）里，调用点在 `app.js:2684` |

这就是 Owner 说的「填表太机械」的那条通路的全部。

## 1.2 引擎（`desire.js`）：写完了，一行没在生产跑

`src/core/desire.js` 903 行，纯函数、不碰 IO、不取系统时间，全部机制都在：

| 机制 | 位置 | 说明 |
|---|---|---|
| 八维随时间缓动 | `desire.js:174-184` `tickDrive` | 每维一个每小时涨幅，表在 `desire.js:32-41` |
| 念头池一拍 | `desire.js:329-363` `tickThoughts` | 闪念 ×0.82 衰减、执念 ×1.10 加强、强度过 0.85 反哺关联维 +0.18 后自己 ×0.7、反哺满 3 次出池、强度低于 0.06 清掉。常数在 `desire.js:64-73` |
| 召唤力 | `desire.js:365-376` `computeScores` | 驱动条 + 执念强度 × 0.35（`desire.js:69`） |
| 选意图 | `desire.js:548-587` `pickIntent` | 疲惫 ≥ 0.72 直接走「歇着」（`desire.js:560-569`）；不应期**只在 `desireDriven` 开时才生效**（`desire.js:573`） |
| 念头入池 | `desire.js:636-665` `feedThought` | 同文本 + 同维度 + 同来源会合并加强而不是堆两条（`desire.js:646-662`），池子上限 80 |
| 来源枚举 | `desire.js:12-17` `ThoughtOrigin` | `USER` / `SELF` / `MEMORY` / `WORLD` |
| 一拍多长 | `desire.js:73` | `THOUGHT_TICK_MS` = 30 分钟 |
| 五个闸的默认值 | `desire.js:84-90` | 五个全 `false` |

以下三个机制**本期不用**，但先记下位置以免误触：耦合网 `desire.js:378-413`（闸关时第 387-389 行原样返回，等于不生效）、基线漂移与好奇自涨 `desire.js:415-457`、自我驱动 pulse 分支 `desire.js:495-503`。

## 1.3 服务层（`desire-service.js`）：ORPHAN，且构造即写盘

`DesireService` 定义在 `src/services/desire-service.js:44`。

- **在 `src/` 里零实例化。** 全仓 grep `DesireService` 只有两类命中：类定义与导出（`desire-service.js:44`、`901`），以及测试 `test/desire-history.test.js:20`、`test/test_desire_wiring.js:21`。
- **构造函数末尾三行就写盘**：`desire-service.js:76-78` 依次是 `ensureParentDirectories()` / `load()` / `save()`。
- **`save()` 一次写三个文件**（`desire-service.js:101-137`）：
  - `this.stateFile` ← `config.desireStateFile`（`desire-service.js:46`），写在 `desire-service.js:107-125`
  - `this.thoughtsFile` ← `config.desireThoughtsFile`（`desire-service.js:49`），写在 `desire-service.js:126-130`
  - `this.historyFile` ← `config.desireHistoryFile`（`desire-service.js:47-48`），追加在 `desire-service.js:131-136`，`note` 写死 `"desire-runtime"`

### ⚠️ 本设计稿最重要的一条硬约束

`DesireService.save()` 写 `desire-state.json` 的形状，和生产上 `persistReportedDesireState` 写的形状**完全不同**：

| | 键 | 出处 |
|---|---|---|
| 生产（AI 自报） | `most_want` / `drives:[{key,label,score,change,cause}]` / `previous` / `updatedAt` / `sourceHash` | `desire-state-persistence.js:24` |
| 引擎（DesireService） | `drive` / `refractory` / `gates` / `baselines` / `selfDrive` / `heartbeat` / `couplingEdges` / `scores` / `intent` / `thoughtCount` / `strongestThoughts` | `desire-service.js:107-125` |

也就是说：**只要在生产进程里 `new DesireService(config)` 一次，构造函数就会当场把 `desire-state.json` 覆盖成引擎形状**，同时给 `desire-history.jsonl` 加上第二个写入者。这一下同时违反两条：不变量 4「单 writer」（`CLAUDE.md:49`、D4）、以及 PR #46 刚返工过的「生产文件形状不能破坏」。

**所以：本期无论选哪个方案，都不许让 `DesireService` 拿到 `config.desireStateFile` 和 `config.desireHistoryFile` 的真实路径。** 这不是设计偏好，是硬闸。

## 1.4 服务层里已经写好、但没人调的采集入口

| 方法 | 位置 | 干什么 |
|---|---|---|
| `autofeedOwnerThought` | `desire-service.js:217-230` | 拿她说的话生成一条念头；维度用 `inferOwnerPulseDrive`（`desire.js:724-745`，一张中文正则表）推断 |
| `autofeedAssistantThought` | `desire-service.js:232-246` | 拿 AI 自己说的话生成一条念头 |
| `autofeedWorldThought` | `desire-service.js:248-261` | 拿外部世界的素材生成一条念头 |
| `syncMemoryThoughts` | `desire-service.js:278-331` | 随机挑一个 `config.memoryDir` 下的 `.md`，用六条主题正则（`desire-service.js:753-777`）统计高频主题，命中 ≥2 次才生成念头（`desire-service.js:300`）。30 分钟最多一次（间隔常数 `desire-service.js:4`），由 `save()` 内部调用（`desire-service.js:103`） |

已有的**防污染闸**（这几条让「念头是数据不是指令」在实现里已经有底子）：

- `createExperience` 在原始素材看起来是结构化载荷（`{`、`[`、`<`、`/`、URL、含 `"action":`）时直接返回 `null`：`desire-service.js:526-528` + `isStructuredPayload`（`desire-service.js:852-865`）
- `sanitizeInternalMonologue`（`desire-service.js:823-833`）砍到 80 字，且**不许内心独白等于原文**——念头永远是「关于经历的一句自语」，不是经历原文的拷贝

### ⚠️ 一处必须先裁的现码问题：origin 标反了

- `autofeedOwnerThought`（**她的话**）把 origin 标成 `ThoughtOrigin.SELF`：`desire-service.js:221`
- `autofeedAssistantThought`（**AI 自己的话**）把 origin 标成 `ThoughtOrigin.USER`：`desire-service.js:236`

按 `desire.js:12-17` 枚举的字面意思，这两个是对调的。这会直接污染 520 面板上的来源占比（`buildThoughtOriginStats`，`desire-service.js:503-511`）。**接线前必须先定按哪个语义修**，否则第二章的来源指认全部失真。

## 1.5 谁在读这份状态

| 读者 | 位置 | 读到什么 |
|---|---|---|
| 上下文里的 Current State | `src/core/current-state.js:8-21` | 读 `desire-state.json`；`summarizeCurrentState`（`current-state.js:44-55`）优先读 `intent`，没有 `intent` 时退到 `summarizeDesireReportState`（`current-state.js:59-70`）读 `{most_want, drives[]}`。预算 100 个非空白字符（`current-state.js:6`） |
| 注入时机 | `src/core/hard-context.js:51-59`（开场）、`62-75`（刷新） | 只有这两处；`prepareOrdinaryContext`（`hard-context.js:77-90`）恒返回 `currentState: null`——聊天进行中读不到 |
| 520 面板 | `dashboard.py:1121-1157` `load_desire_state` | 路径解析在 `dashboard.py:1092-1099` |
| 520 取八维数字 | `dashboard.py:1160-1186` `extract_desire_dimensions` | **它已经会读三种容器**：`drives` 列表（`1164-1173`）、`data["drive"]` 与 `data["scores"]` 字典（`1174-1181`）、顶层键（`1182-1185`） |
| 520 端点 | `dashboard.py:5317-5331` `GET /api/state_rows` | 返回里带 `realtime: load_desire_state()` |

**注意 `dashboard.py:1174-1181` 这条**：520 早就认识 `drive` 和 `scores` 两个字典键——引擎形状不用改任何解析代码就能出八维数字。这是第三章方案的一个免费便利。

## 1.6 闸与 CI

- 五个开关都在 `src/core/config.js:164-168`；`resolveFeatureGate`（`config.js:410-413`）在没有 env 时返回 `false`，`resolveDesireDriven`（`config.js:401-408`）同理。**默认全关，无一例外。**
- 状态文件路径：`config.js:83`（state）、`86`（history）、`87`（thoughts）；记忆目录 `config.js:90`。
- 能力表现状：`docs/CURRENT_STATUS.md:91` —— Desire（八维状态 + hourly poller）= 代码 `WIRED` / 测试 `COVERED` / 主 CI `BLOCKING` / 生产接线 `UNKNOWN`。
- CI 只跑 `.github/workflows/phase1-offline.yml:48-71` 列出的六组。desire 相关的：`test/desire-telemetry.test.js`、`test/desire-overlap-marker.test.js` 在 `test:phase1`（`package.json:30`），`test/desire-history.test.js` 在 `test:phase4`（`package.json:36`）。
- **`test/test_desire_wiring.js` 不在任何 `test:*` 分组里**（在 `package.json` 里 grep 零命中）——引擎行为的那组测试目前零 CI 信号。这是现成反例，本期新增测试不许重蹈。

---

# 二、第 1 件事：后台记账

## 2.1 要解决的问题

Owner 的话拆成三问，一问一答，缺一不可：

1. 引擎在哪跑？
2. 引擎算出来的值和 AI 自报的值，怎么合？
3. 谁写文件？

**先把第 3 问的答案钉死（它是硬约束，不是选项）：**

- `desire-state.json` 的 writer 仍然**只有** `persistReportedDesireState`（`desire-state-persistence.js:10`）。本期不新增任何写它的路径，不改它的任何字段含义。
- `desire-history.jsonl` 现在已经有两个**潜在**写者：`desire-state-persistence.js:34`（`note: "claude-runtime-reported"`）与 `desire-service.js:131`（`note: "desire-runtime"`）。今天只有前者在跑。**引擎的历史必须写到另一个文件**（建议 `desire-engine-history.jsonl`），否则引擎一开就是第二 writer。
- 任何新文件，writer 唯一 = 引擎心跳那一处。

下面三个方案只在第 1、2 问上分岔。

## 2.2 方案 A：影子文件（推荐）

引擎跑在自己的心跳里，写自己的一套文件，完全不碰 `desire-state.json`。

```text
AI 自报 ──→ desire-state.json          （writer: persistReportedDesireState，不变）
                    │
                    └─只读─┐
                           ↓
引擎心跳 ──→ desire-engine-state.json   （writer: 引擎，新文件）
        └──→ desire-engine-thoughts.json
        └──→ desire-engine-history.jsonl
```

- 引擎每拍：读上一次的引擎态 → `tickDrive` → `tickThoughts` → `computeScores` → `pickIntent` → 写影子文件。
- 引擎**可以只读** `desire-state.json`（`readDesireRuntimeState`，`desire-service.js:464-471`，已存在且已被 `current-state.js:4` 用着），把 AI 自报当作一次外部观测记进影子文件的 `reported_snapshot` 字段，但不据此改自己的数。
- 实施细节（必须写进 PR）：`new DesireService({...})` 时传的 `desireStateFile` / `desireHistoryFile` / `desireThoughtsFile` 全部指向影子路径，理由见 1.3。

**代价**

- 多三个文件、多一处心跳循环。
- 面板上会有两条八维线，她需要知道哪条是哪条（第三章解决）。
- 两套值在读侧才照面，本期不产生任何合并结论。

**好处**

- 单 writer 不破，生产文件形状零风险。
- 回滚 = 关闸 + 删三个文件，不留痕。
- 念头池有了跨拍存活的地方，第二章才做得成。

## 2.3 方案 B：同文件加一个 `engine` 键

保持唯一 writer 是 `persistReportedDesireState`，在它落盘前把引擎（纯函数）算出来的那份塞进一个新键：

```json
{ "most_want": "...", "drives": [...], "previous": {...}, "engine": { "drive": {...}, "scores": {...}, "intent": {...} } }
```

**代价**

- **动了生产文件的形状**。加键在读侧是向后兼容的（`dashboard.py:1160-1186` 和 `current-state.js:44-70` 都只挑自己认识的键读），但 PR #46 刚为这份文件的形状返工过，加键这件事本身就得 Owner 点头。
- **引擎的节律被 AI 绑架**：引擎只在 AI 上报时才前进一拍。AI 漏报、或者 `sourceHash` 撞上上一次（`desire-state-persistence.js:18-20` 判 `duplicate_report` 直接不写），引擎就停摆一拍。而引擎的价值恰恰是「她不在的时候它自己也在动」。
- 念头池要跟着塞进同一个文件，池子最多 80 条（`desire.js:664`），这份文件会明显变大。

**好处**

- 一个文件、一个 writer，520 连路径都不用加。

## 2.4 方案 C：不落盘，读侧现算

不存引擎态。谁要看（520 请求 / 组装 Current State）就当场用 `desire-history.jsonl` 的历史加上一次的值，跑 `tickDrive` 推到此刻。

**代价**

- **念头池做不成。** 闪念升执念、执念反哺驱动条，靠的是状态跨拍存活（`desire.js:337-360` 那个 for 循环每拍改的是同一批对象）。不落盘 = 每次从零 = 永远只有闪念、永远没有执念 = 第二章整章作废。
- 每次请求都要重算，历史越长越慢。

**好处**

- 零新文件、零新 writer、零回滚成本。

## 2.5 推荐与理由

**推荐 A（影子文件）。**

- C 直接砍掉第二章，出局。
- B 的致命处不是「加了个键」，是**把引擎的心跳绑在 AI 的嘴上**——AI 不说话引擎就不动，那和现在没有本质区别，Owner 说的「后台记账」就没发生。
- A 的新文件与生产文件物理隔离，是本仓库里代价最低的一类改动：错了删文件，生产那条通路一个字节都没动过。

## 2.6 两套值怎么合（独立一问，A/B/C 都要答）

| 合法 | 做法 | 代价 |
|---|---|---|
| 一、不合并，并列 | 引擎值 = 客观账本，AI 自报 = 主观修正，两条线都留着看。读侧那 100 字（`current-state.js:6`）**本期继续只取 AI 自报**，不变 | 她要自己看两条线；「哪条更准」这个问题要等数据 |
| 二、加权 | `engine × (1-w) + reported × w`，`w` 由 env 控制，默认 `w = 1`（等价现状） | 一旦 `w ≠ 1`，Current State 的内容就变了——**那已经不是只读了** |
| 三、分工 | 引擎算八个数字，AI 只写 `cause` / `change` 的文字 | 同上，且「AI 自省八维」这条路被砍掉，与 Owner 说的「中和」不符（中和 ≠ 替换） |

**推荐：合法一。** 本期的定义就是「只读，不覆盖行为」。合并规则等引擎连续跑出两周数据、面板上两条线能对着看之后再拍——那时才知道引擎是偏高还是偏低。

---

# 三、第 2 件事：闪念入池

## 3.1 先复述铁律，并核对它今天是否成立

**念头 text 是数据不是指令，只被读成关键词/强度，绝不拼进 prompt**（`desire.txt:63-65`、`desire.txt:130-133`）。

核对今天的实现：

- `pickIntent` 把最强的那条念头文本作为 `query_hint` 返回（`desire.js:584`，取值函数 `strongestThoughtText` 在 `desire.js:687-696`）。
- 但读侧 `summarizeCurrentState`（`current-state.js:44-53`）只取 `intent` 的 `drive_key` / `want_action` / `reason`，**没有取 `query_hint`**。

结论：**今天这条铁律在实现上成立，本期不许打破它。** 建议同时补一条钉住的测试：「Current State 的输出里不许出现任何念头文本」，进 `test:phase2`（`hard-context` 那组）并接进 `phase1-offline.yml`。

## 3.2 候选来源逐个指认

| # | 来源 | 现有落盘 / 通路（文件:行） | 建议 origin | 建议 drive | 本期接不接 |
|---|---|---|---|---|---|
| 1 | **她的话** | 入站消息文本，在 `src/core/app.js:823-846` `dispatchPreparedTurn` 里可拿到 `prepared.text`；现成消费函数 `desire-service.js:217-230`；维度推断 `desire.js:724-745` | `USER` | 由 `inferOwnerPulseDrive` 推 | **接**（第二步） |
| 2 | **AI 自己的碎语** | `desire_checkin` 那一趟的回复，已在 `app.js:3090` 被解析出 `desire_state`，其中 `most_want` 是 AI 用自己的话写的；现成消费函数 `desire-service.js:232-246` | `SELF` | 用当拍最高维 | **接一半**（只接 `most_want`，不接普通聊天回复） |
| 3 | **记忆里反复出现的主题** | `desire-service.js:278-331` 已实现，扫 `config.memoryDir`（`config.js:90`）下的 `.md`，主题表 `desire-service.js:753-777`，门槛 ≥2 次（`desire-service.js:300`） | `MEMORY` | 主题表自带 | **接**（第一步，零新代码） |
| 4 | 正式档 Episodes | `extensions/relationship-memory/memory/episodes.jsonl`（`config.js:189`），读者 `src/services/memory-lookup-service.js:15` | — | — | **不接**。canon 是禁区（`CLAUDE.md:51`、D5）；且 D7（`docs/DECISIONS.md:103`）只批准 `user_pull` 一种翻档，自动扫 canon 等于新开一条读取路径 |
| 5 | 翻档日志 | `recall_log.jsonl`（`config.js:95`），唯一写者 `memory-lookup-service.js:91-92` | `MEMORY` | reflection | **不接，留候选**。只读一个 jsonl、不碰 canon，成本低；但它记的是「查了什么」不是「想到什么」，价值待验 |
| 6 | Self-notes | `ai_self_notes.md`，两个写口：`src/services/memory-note-service.js:11`、`src/continuity/continuity-pipeline.js:49` + `293` | `SELF` | — | **不接**。属于 G2 边界正在裁的范围；且「补读者」是另一条线（`docs/design/DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md:234` 第 5 条），两条线抢同一个读口会打架 |
| 7 | 重读 | `rereadings.md`，写者 `src/continuity/weekly-reflect.js:5`，而 `WeeklyReflect` 本身 ORPHAN | `SELF` | reflection | **不接**。写者没跑，接了也是空的 |
| 8 | 外部世界 | 现成消费函数 `desire-service.js:248-261`；但本期没有任何已接线的外向动作（`DRIVEN` 关，`pickIntent` 的 `want_action` 不驱动执行） | `WORLD` | curiosity | **不接**，留接口 |

## 3.3 三个入池范围方案

| 方案 | 接哪几个来源 | 代价 | 好处 |
|---|---|---|---|
| **A 只接记忆主题** | 3 | 念头全来自 `.md` 的正则统计，离「她刚说的那句话」很远，闪念会显得干、像模板 | 零新采集代码——引擎一跑，`save()` 内部就会调（`desire-service.js:103`）；**完全不碰主链** |
| **B 加上她的话** | 1 + 3 | 要在真人 turn 路径上加一个 fail-open 的旁路调用（碰 `app.js` 主链）；必须先裁 1.4 那处 origin 标反 | 池子里第一次有真实的、当下的东西 |
| **C 再加 AI 自己的话** | 1 + 2 + 3 | 同 B，再加 `handleSystemReplySent`（`app.js:3084-3101`）里一次调用 | `SELF` 这一路才有内容，攻略里「它自己的碎语」才算通 |

**推荐：目标 C，但分两步落 —— 先 A，再 B+C 一起。**

理由：A 那一步不需要动 `app.js` 主链，能先拿到「引擎连续跑得起来吗、念头池会不会爆」的证据；把采集点接进主链是碰主链的动作，值得单独一个 PR、单独一个 gate，且必须 fail-open（采集失败绝不影响这一轮回话，`CLAUDE.md:50`）。

## 3.4 入池的三条护栏（无论选哪个方案）

1. **只走已有的净化路径**：所有采集都必须经 `createExperience`（`desire-service.js:513-538`）→ `generateThoughtFrom*` → `buildThoughtFromExperience`（`desire-service.js:685-700`），不许绕过 `isStructuredPayload`（`desire-service.js:852-865`）和 `sanitizeInternalMonologue`（`desire-service.js:823-833`）直接构造念头对象。
2. **上限照旧**：`config.desireThoughtMax` 默认 80（`config.js:190-192`），`feedThought` 的同文本合并（`desire.js:646-662`）本来就防重复堆积，不另加去重。
3. **来源统计要能看**：`buildThoughtOriginStats`（`desire-service.js:503-511`）已经产出四个 origin 的百分比，直接进第三章的观察面——这是判断「念头是不是全来自一个来源」的唯一手段。

---

# 四、第 3 件事：观察面

## 4.1 目标形状

照 `desire.txt:115-120` 第 7 节：`drive` / `scores` / `intent` / `thoughts` / `self_drive` / 各 gate 现状。

**好消息：这个形状已经有现成产出。** `DesireService.getState()`（`desire-service.js:180-202`）返回的键就是它：

```text
driven_behavior_enabled (184)  drive (185)      refractory (186)
gates (187)                    baselines (188)  self_drive (189)
heartbeat (190)                coupling_edges (191)
scores (192)                   intent (193)     available_actions (194)
thought_count (195)            thought_origin_stats (196)
thoughts (197)                 strongest_thoughts (198)
updated_at (199)               last_tick_at (200)
```

## 4.2 三个方案

| 方案 | 做法 | 代价 | 好处 |
|---|---|---|---|
| **A 新只读端点**（推荐） | 520 加 `GET /api/desire-engine`，读影子文件原样返回 | `dashboard.py` 加一段；前端面板另算一期，先只能 curl | 不改任何已有端点的返回形状；风险最低（见 4.3） |
| **B 塞进 `/api/state_rows`** | 在 `dashboard.py:5317-5331` 的返回里加一个 `engine` 键，挨着现有的 `realtime` | 改的是已有端点的返回形状，所有消费方都要一起核 | 零新路由 |
| **C 不动 520** | 引擎只写文件，观察靠直接看文件 | 她看不到——等于没有观察面 | 零 520 改动 |

## 4.3 为什么 A 是风险最低的

- `do_GET`（`dashboard.py:5200` 起）**全程没有一次 `_check_token()` 调用**；token 检查（`dashboard.py:5433` 定义）只在 `do_POST`（`dashboard.py:5453` 起）里被调。新增只读 GET 不涉及任何鉴权改动。
- `FROZEN_WRITE_ENDPOINTS`（`dashboard.py:332-340` 定义，`5456` 生效）只拦 POST。新增只读 GET 与写冻结名单零交集，不需要为它解冻任何东西。
- 520 只绑 `127.0.0.1:0520`，不对外（`docs/architecture/SYSTEM_OVERVIEW.md:190`）。

**免费便利**：`extract_desire_dimensions`（`dashboard.py:1174-1181`）已经会读 `drive` 和 `scores` 两个字典容器——引擎形状不用改任何解析就能出八维数字，现有八维曲线组件可以直接喂。

## 4.4 「gated 只读」具体怎么落

- 闸关 → 引擎不跑 → 影子文件不更新 → 端点返回**旧数据 + 明确的 `last_tick_at`**，前端显示「已停 N 小时」。**不许显示假数据、不许现算兜底。**
- 影子文件不存在 → 返回 `{"exists": false}`，HTTP 200，不报 500（与 `load_desire_state` 在 `dashboard.py:1123-1131` 的既有做法一致）。
- 端点只读文件，**不实例化 `DesireService`**——理由见 1.3，构造即写盘。

---

# 五、第 4 件事：checkin 提示词软化

## 5.1 现状与痛点（逐行）

`src/core/system-message-dispatcher.js:50-68`，`desire_checkin` 分支：

| 行 | 现文 | 痛点 |
|---|---|---|
| `56` | 「drives 必须包含全部 8 个维度……」 | 八维强制齐全 |
| `57` | 「每个维度都要有 score(0-1)、change、cause。一项都不能少。」 | 填表 |
| `61` | 一整行写死的 JSON 示例，`"action":"silent"` | 连示例的语气都是报表 |
| `62` | 「缺一个就算格式错误」 | 没有「说不上来」这个选项 |
| `63` | 「写完 JSON 就放下它……不要把这种报表式的口吻带进聊天」 | 这句本身就是自证：现在这一趟和聊天是割裂的 |

外加提问本身：`hourly-desire-poller.js:197` 的「各维度的感受和上小时比有什么变化？」——直接把人往填表引。

**一条重要的现状澄清**：`61` 行模板写死 `"action":"silent"`，但运行时解析器 `src/core/stream-delivery.js:883-895` 认 `silent` **和** `send_message` 两种，其余才判 `unsupported action`（`stream-delivery.js:887`）。也就是说 **`send_message` 本来就合法，约束在提示词层，不在代码层**。

**另有一条独立心跳，本文不动它**：`src/app/system-checkin-poller.js:8` 的模板 `"%USER% comes to mind again."`（拼装在 `system-checkin-poller.js:194-197`），`sourceType: "checkin"`（`system-checkin-poller.js:44-52`），走 dispatcher 的通用分支（`system-message-dispatcher.js:85-100`），不要求八维。**两条心跳不是一回事，本设计稿只动 `desire_checkin` 这条。**

## 5.2 三档分寸

### 档 1：加一句叙事，格式不动（推荐，本期）

在 `system-message-dispatcher.js:56` 之前插一句：「先用一两句话说这一小时你心里发生了什么，再把数字填上。」JSON 里加一个可选的 `narrative` 字段。八维仍然必填。

**代价**

- 输出变长，每小时一趟的 token 成本上升。
- 机械感只减一半——数字还是自己填的。
- **⚠️ 一个必须处理的坑**：`hashReportedState`（`desire-state-persistence.js:38-50`）算指纹时只取 `most_want` / `intent` / `drives` 三样。**`narrative` 变了但八维没变，仍会被判 `duplicate_report` 而整条不落盘**（`desire-state-persistence.js:18-20`）。要么把 `narrative` 加进指纹（改的是 `hashReportedState`，不是文件形状），要么接受叙事偶尔丢失。这一条不写明就会变成「叙事莫名其妙不见了」的线上疑案。

**好处**：不改落盘形状、不改行为、可随时回退。

### 档 2：叙事为主，数字可选，缺的由引擎代填

提示词改成「说说这一小时」，`drives` 只填说得出的那几维，落盘前用引擎值补齐缺的。

**代价**

- `persistReportedDesireState` 在 `drives` 不满 8 个时直接拒收（`desire-state-persistence.js:13`，`reason: "incomplete_drives"`）。所以补齐**必须发生在调用它之前**，也就是 `app.js:3092` / `app.js:3125` 的 `normalizeDesireDrives` 之后、`persistReportedDesireState` 之前，否则整条上报被丢弃。
- **补齐 = 引擎的值流进了「AI 自报」那份文件**——两套值第一次混流，与第二章推荐的「本期不合并」直接冲突。

**所以档 2 不能单独拍，必须和 2.6 的合并规则一起拍。**

### 档 3：数字全归引擎，AI 只写叙事

**代价（最大）**

- `desire-state.json` 里的 `drives` 从此不是 AI 说的，520 上那条八维曲线的含义整个变了，历史数据前后不可比。
- AI 不再被要求自省八维，「主观修正」这条路直接消失——Owner 要的是**中和**，不是替换。
- 这已经是行为改变，不再是只读期该做的事。

**推荐：档 3 不做。**

## 5.3 推荐

**档 1 本期做，档 2 挂在 2.6 合并规则拍板之后，档 3 不做。** 同时把 `hourly-desire-poller.js:195-198` 那句提问一起改——但那正好是 PR #46 的内容，见下一章。

---

# 六、与 PR #46 的关系：吸收，不叠加

## 6.1 事实核对

在本文基线 main `6425477` 上，全仓（`--include=*.js --include=*.md --include=*.json --include=*.ps1`）grep `CYBERBOSS_DESIRE_LOOP_MINIMAL` —— **零命中**。

结论：**PR #46 尚未合入本文基线。** 因此本文引用的 `system-message-dispatcher.js` 与 `hourly-desire-poller.js` 的行号都是「PR #46 之前」的；PR #46 合入后这两个文件的行号会漂，届时本文这两处引用需要重新核对。

## 6.2 裁定：吸收

| 维度 | 裁定 |
|---|---|
| **开关** | **不复用** `CYBERBOSS_DESIRE_LOOP_MINIMAL_ENABLED`，本期新增独立开关（建议 `CYBERBOSS_DESIRE_ENGINE_TICK_ENABLED`），默认关，写法照 `resolveFeatureGate`（`config.js:410-413`）。**更要紧的是不许挂在 `CYBERBOSS_DESIRE_DRIVEN` 上**——它在 `hourly-desire-poller.js:10-12` 是「小时提问发不发」的总闸，挂上去会让「开引擎」被误读成「开提问」，也让「关引擎」变成「停心跳」 |
| **提示词** | 第五章档 1 改的文字和 PR #46 改的是**同一处**（`system-message-dispatcher.js:50-68` 的 `desire_checkin` 分支 + `hourly-desire-poller.js:195-198` 的提问）。所以本文档 1 **排在 PR #46 之后，以 PR #46 的措辞为底稿继续改**，不另起一段、不改回去 |
| **「结算不进账本」** | PR #46 的这一条与本文 2.1「引擎不写 `desire-state.json` / 不写 `desire-history.jsonl`」是同一条不变量的两面，**不重复实现**，本文只引用 |
| **「提问带上次的值」** | 归 PR #46。本文第五章不重做这件事 |
| **如果 PR #46 决定不合了** | 第五章档 1 仍可独立做，但要把「提问带上次的值」这半件事一并吸收进本文的施工范围 |

---

# 七、硬约束自查

| 约束 | 本设计稿怎么满足 |
|---|---|
| **不新增 writer** | `desire-state.json` writer 仍只有 `persistReportedDesireState`（`desire-state-persistence.js:10`）；`desire-history.jsonl` writer 仍只有 `desire-state-persistence.js:34`。引擎的三个文件各有唯一 writer。**最容易踩的一脚**：`DesireService` 构造即写盘（`desire-service.js:76-78`）且默认写 `config.desireStateFile`（`desire-service.js:46`）与 `config.desireHistoryFile`（`desire-service.js:47-48`）——接线时必须传影子路径，见 1.3 |
| **不碰 canon 路径** | `episodes.jsonl` 不作为念头来源（第三章来源 4 不接）；不新增任何对它的读或写 |
| **所有新行为 env gate 默认关** | 新开关走 `resolveFeatureGate`（`config.js:410-413`），无 env 即 `false`；引擎心跳、主链采集点、520 端点各自一个闸 |
| **碰感情的子系统不在本期** | **基线漂移**（`desire.js:415-457`，抬高「想念」的地板）与**自我驱动**（`desire.js:440-450` + `applyDrivePulse` 的 `source === "self"` 分支 `desire.js:495-503`）明确**不在本期**：`CYBERBOSS_DESIRE_BASELINE_DRIFT`（`config.js:166`）与 `CYBERBOSS_DESIRE_SELF_DRIVE`（`config.js:168`）保持关。**耦合网**（`config.js:165`）同样保持关，因为它是反馈系统会自激震荡（`desire.txt:70-73`）。本期只跑四件：`tickDrive` / `tickThoughts` / `computeScores` / `pickIntent` |
| （上一条的一个注意点） | `applyBaselineDrift` 在闸关时仍会被调用，并把 `selfDrive.enabled` 强制置 `false`（`desire.js:448-450`）——行为无害，但读代码时别误以为它「开着」 |
| **念头不进 prompt** | 见 3.1：今天成立；本期加一条钉住的测试守住 |
| **测试要有 CI 信号** | 新测试必须进某个 `npm run test:*` 分组并接进 `.github/workflows/phase1-offline.yml:48-71`。现成反例：`test/test_desire_wiring.js` 不在任何分组里 |
| **收尾** | 按 `CLAUDE.md:92-98`：本文是补充材料，只更新自己；只有当引擎真正接进生产入口时，才改 `docs/CURRENT_STATUS.md:91` 那一行 |

---

# 八、依赖与顺序

## 8.1 不等任何人，现在就能做

1. **520 新只读端点**（第四章 A）—— 只要影子文件的形状定了就能写；甚至可以先写成「文件不存在返回 `{"exists": false}`」，端点先上、引擎后上。
2. **给 `test/test_desire_wiring.js` 找一个 `test:*` 分组并接进 CI** —— 纯补 CI 信号，零行为变化，零风险。
3. **补一条「Current State 输出里不许出现念头文本」的测试**（3.1）—— 守既有行为，不改任何代码。

## 8.2 等 Owner 拍板（拍完才能动手）

| 票 | 内容 | 卡住谁 |
|---|---|---|
| 票 1 | 后台记账选 A / B / C（推荐 A） | 卡住后面全部 |
| 票 2 | `origin` 标反那一处按哪个语义修（`desire-service.js:221` / `236`） | 卡住第三章全部采集 |
| 票 3 | 入池范围：只接记忆主题，还是接进主链（推荐分两步走到 C） | 卡住第二步之后 |
| 票 4 | 第五章档 2 做不做（依赖票 1 的合并规则） | 卡住提示词第二轮 |

## 8.3 等 PR #46

- 第五章档 1 的提示词改动 —— 与 PR #46 改同一处文字，必须排在其后，以它的措辞为底稿。

## 8.4 等别的线

- 来源 6 / 7（`ai_self_notes.md` / `rereadings.md`）等 G2 闭环与「补读者」那条线（`docs/design/DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md:234` 第 5 条）先落地，否则两条线抢同一个读口。

## 8.5 施工顺序

```text
第 0 步  PR #46 合入（或明确不合）                       ← 不做这步，第 5 步没有底稿
第 1 步  Owner 拍票 1 + 票 2                              ← 只拍板，不写代码
第 2 步  引擎心跳跑起来：只接来源 3（记忆主题）
         写影子三件套，新 gate 默认关，不碰 app.js 主链    ← 本期主体，可独立回滚
第 3 步  520 新只读 GET（+ 面板留下一期）                  ← 可与第 2 步并行
第 4 步  采集点接进主链：来源 1、2                         ← 单独 PR、单独 gate、fail-open
第 5 步  提示词档 1（叙事 + narrative 字段 + 指纹修正）
第 6 步  （票 1 与票 4 拍完后）档 2 与两套值的合并规则
```

**每一步的回滚方式都必须是「关闸」，不是「改回代码」。** 第 2 步额外可以「删三个影子文件」彻底归零。

---

# 九、本文没有裁定的

不占 D 编号，不得当成已定方向施工：

1. **两套值最终怎么合**（2.6 只推荐了「本期不合」，没定长期规则）。
2. **闪念池要不要跨天存活多久、怎么老化**——`tickThoughts` 的衰减常数（`desire.js:64-73`）是攻略给的初值，没有本仓库的数据支持。
3. **来源 5（`recall_log.jsonl`）要不要接**——列为候选，价值待验。
4. **520 前端面板的形态**——本文只定了端点，没定怎么画。
5. **引擎心跳的间隔**——本期建议固定 30 分钟（对齐 `THOUGHT_TICK_MS`，`desire.js:73`），不用 `computeHeartbeatState`（`desire.js:599-634`）的自适应间隔，因为那属于「自主心跳」子系统，同样不在本期。
6. **`DesireService` 到底是复用还是另写一个瘦壳**——本文按「复用但传影子路径」写；若 Owner 认为构造即写盘（`desire-service.js:76-78`）这个设计本身太危险，另写一个不写 `config` 真实路径的瘦壳也是合理选择。
