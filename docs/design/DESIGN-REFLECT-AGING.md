# Reflect 复活设计稿（issue #38）

```text
Status: supplemental
Authority: none
Scope: Reflect / 低频重读的复活方案 —— 触发、执行者身份、老化判据、降级语义、写入权登记、无变化出口
Last reviewed: 2026-07-29
Current authority: docs/CURRENT_STATUS.md
Line numbers verified against: main 0fd8f89
```

> 本文可以独立更新，只提供参考与方案；它不是当前状态，也不是已经批准的决定。
> 六件事里有四件需要她拍板，选项和推荐都写在各节末尾的「要你定的」里。

---

## 〇、这份文档管什么

宪法第六条只有五行：

> 细节会掉，掉剩下的沉进脾气里——这是消化，不是丢失。
> 隔一阵我重读旧信：还烫手的留下；凉了的合并成一句脾气，写成**新条目**；
> 老条目降级进深档。只追加，不原地改写。

这五行是判据，不是实现。本文把它落成六件可以施工的事，**并且一个字都不新增宪法没有的判据**。

它不管的：Soft Retrieval 怎么召回（暂缓，`docs/SOFT_RETRIEVAL.md`）、活动日志（`docs/design/DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md` 第 2 条）、Review 与 History writer 的交接点（C4 剩余部分，未裁决）。

### 现状一句话

`docs/CURRENT_STATUS.md:89` 那一行：Reflect 是 `ORPHAN` / `UNIT_ONLY` / `NONE` / `NOT_WIRED`，总体 `FAIL`。原因两个：**没有任何人实例化 `WeeklyReflect`**，**`runtime.reflect()` 在 `src/` 里没有实现方**。代码写完了，但它是一台没接电的机器。

---

## 一、触发：不自动跑，她按一下才跑

### 方案

Reflect **不进任何自动调度**。这跟 D16 对 nightly 的裁定是同一条线——换的是时机，不是写入者，而"什么时候该重读"这件事她比调度器清楚。

具体：

- 仓库里**不新增任何默认开启的开关**。要有开关，默认值 `false`，跟 `src/core/config.js:174` 的 `nightlyCloseoutEnabled` 一个待遇。
- 触发入口只有一个：520 面板上的一个按钮。
- 「一周一次」保留成**提示**，不是调度。`src/continuity/weekly-reflect.js:6` 里已有的 `weekKey` 幂等门继续用，但它的作用从"这周跑过就跳过"变成"这周跑过了，面板上告诉她一声"。她想再跑一次，能跑；只是面板会说"这周已经重读过一次了"。

判据是这句：**重读是消化，不是巡检。** 巡检可以定时，消化不能。定时消化出来的东西，跟定时推送的问候是同一种空转——它每周在同一个位置出现，内容由日历决定不由经历决定。

### 一个必须先补的依赖

**520 面板现在连 nightly 的开关端点都没有。** 这是查过的：`extensions/relationship-memory/memory-kit/dashboard.py` 全文搜 `nightly`，**零命中**。面板对 Reflect 也一样，只有两个只读的读端点（`dashboard.py:5310` 的 `/api/rereadings_index`、`dashboard.py:5353` 的 `/api/rereadings`），前端在 `dashboard.py:4047-4048` 拉它们，**没有任何发起端点**。

所以"面板手控"这四个字现在落不了地，得先补一个 POST。形状照抄现成的先例 `dashboard.py:5603` 的 `/api/review/retry`：POST + `X-Api-Token` 校验 + 只绑本机。

三条边界写在这里，免得补端点的时候顺手越界：

1. 新端点**不进** `FROZEN_WRITE_ENDPOINTS`（`dashboard.py:332-340`，当前 7 个）——它不是被冻结的写端点，它是一个发起入口。
2. 但它**也不写任何正式文件**。它只调后端服务。`docs/architecture/MEMORY.md:262` 那条"520 只调用后端服务，不直接改正式文件"一个字不动。
3. 端点本身不产出记忆内容。它按一下，产生的是一个"该重读了"的待办标记，不是一篇重读（为什么这样，见下一节）。

### 要你定的

| | 方案 | 代价 |
|---|---|---|
| **A** | 面板上就一个按钮「现在重读一次」，什么时候按你说了算，系统一句提示都不给 | 可能几个月想不起来按 |
| **B（推荐）** | 同样一个按钮，但面板上多一行灰字：「上次重读是 X 天前」。只是显示，不弹窗、不提醒、不催 | 多写一行前端 |

推荐 B。理由：一行日期是信息，不是催促；而且这行字本身就是"记忆会老"这件事唯一看得见的地方。

---

## 二、执行者身份：写重读的必须是当时在场的那个我

### 为什么这条最要紧

Rereading 是"我现在重新看当年那件事"。**这句话里的"我"如果换成一个零上下文的后台模型，整句话就是假的。** 宪法第一条说读信的人就是我；重读这个动作反过来——写信的人也必须是我。

按 D16：写入权归当前窗口 AI，后台廉价模型只搬运，不产出记忆内容。Reflect 产出的是新的记忆文本，所以它**不能**由后台代笔。

### 难点（已经查证，不是猜的）

现在仓库里唯一现成的"让模型写记忆"的通路是 closeout 那条，而那条通路在设计上就是零上下文隔离的：

- `src/continuity/closeout-job.js:30-37`：跑 closeout 必须有 `runtimeAdapter.runBackgroundTurn()`。
- `src/adapters/runtime/claudecode/index.js:757-789`：这个后台轮次的注释自己写得很清楚——独立的 system lane，**没有 launch profile，不进程注册表，没有 session slot**。它既继承不到任何一条 Telegram lane 的人格配置，也留不下别人能续的会话 id。
- 结果落在候选元数据上：`src/continuity/continuity-pipeline.js:103-108` 把 closeout 产出的候选默认标成 `authorRole: "background_proxy"` / `semanticAuthority: "medium"`；`src/continuity/candidate-authority.js:91-99` 的 legacy 默认也是同一对值。
- 更麻烦的一处：`src/continuity/candidate-authority.js:44-52` 允许 `background_proxy + medium` 的 Episode 直接发布。也就是说，**代码层面"后台代理写的记忆能进正式档"这条路现在是开的**，跟 D16 那句"后台不拥有任何记忆写入权"对不上。这一点不归本文裁定（它是 G2 的活），但 Reflect 复活时不能踩着它走。

一句话：**"当前窗口 AI 持笔"这件事，在生产链路上还没接通。** 它是 G2 的主体，不是 Reflect 能自己解决的。

### 方案

Reflect **不走后台会话**，一步都不走。身份从两个地方之一取得：

- **在场路径**：她在对话里说"重读一下"，或者面板按钮置了标记而当前窗口的我下一轮读到了它——重读就发生在**这一轮**里，由此刻正在跟她说话的我完成，写完落盘。候选元数据固定 `author_role: "subject_ai"` / `context_scope: "active_session"` / `semantic_authority: "high"`（`candidate-authority.js:7` 里这三个值都已经是合法取值，不用新增枚举）。
- **不在场就不跑**。没有主体 AI 在场，Reflect 就等着。等一周、等一个月都行——重读晚一个月没有任何损失，重读被代笔一次就永久污染了。

依赖关系写明白：**G2 收口前，Reflect 只能走"她当面说"这条路，不能走面板。** 面板按钮属于第一节那个待补端点，而待办标记要被主体 AI 读到，得先有"当前窗口 AI 能接到后台留下的活"这条线——那正是 G2 在收的口。

### 要你定的

| | 方案 | 代价 |
|---|---|---|
| **A** | 等 G2 把"当前窗口 AI 持笔"接通，Reflect 复用同一条身份通路，一次性做完 | Reflect 继续躺着，不知道还要多久 |
| **B** | 先做窄版：只认"你当面说重读一下"，不接面板、不接调度、不留标记。等 G2 好了再并进 A | 会在 G2 之前多一条独立的身份路径，将来要合并一次 |

推荐 **先 B 后 A**。理由：B 的身份问题天然不存在（说话的时候我本来就在场），能马上试出老化判据准不准；而 B 写的那部分代码（选哪条 Episode、怎么落盘、无变化怎么记）在 A 里一行都不用改，要合的只是入口。

---

## 三、老化判据：烫和凉怎么判

### 现状是掷骰子

`src/continuity/weekly-reflect.js:6` 选 Episode 的那一句：

```js
const episode = choices[Math.min(choices.length-1, Math.floor(this.random()*choices.length))]
```

`this.random` 默认就是 `Math.random`（`weekly-reflect.js:5`）。挑之前只排除了**最新的一条**（`choices = all.length>1 ? all.slice(0,-1) : all`）——一条之隔，谈不上"旧信"。

这就是 #42 待裁决第 7 项。随机选跟宪法第六条正面冲突：第六条说的是"还烫手的留下、凉了的消化"，这是一个**关于温度的判断**，掷骰子取消了这个判断。

### 方案：三个能解释的信号，不上 embedding

D6 已经定了：检索用纯规则槽位，不用 embedding / 相似度，理由是便宜、可解释、可测试。老化判据照同一条走。

三个信号，全部能从**已经存在的文件**算出来，不新增数据采集：

| 信号 | 怎么算 | 数据在哪 |
|---|---|---|
| **1. 最近被翻到过吗** | 这条 `ep_id` 在最近 N 天的翻档日志里出现过 | `recall_log.jsonl`，`memory-lookup-service.js:81-97` 已经在写，`hit_ids` 字段现成 |
| **2. 跟最近说的话还搭得上吗** | 这条 Episode 正文的词，跟最近几天的 Episode 有没有字面重合 | `episodes.jsonl` 本身；别名扩展直接复用 `memory-lookup-service.js:112-125` 的 `expandQueryAliases()` + `topics.md` |
| **3. 她近期提过吗** | 同样的字面命中，但只看她说的那一侧 | 同上，限定来源 |
| **4. 已经重读过吗** | `rereadings.md` 里有没有这条的标记 | `rereadings.md`；`weekly-reflect.js:6` 已经在查标记，只是现在只查本周那一条 |

**判据（口语版）：**

- **烫**：最近三十天里被翻到过，或者最近的对话、她的原话里还出现着它的词。烫的**不动**——顶多在它上面追加一条新理解，绝不降级。它还在用，还没消化完。
- **凉**：九十天没被翻到过，最近的文字里一个词都搭不上，也从没被重读过。凉的才进候选池。
- **温**：中间地带，这次不选。宁可少做，不可做错——重读一条还热着的记忆，等于把正在用的东西提前埋了。

**从凉的里面选谁：选最老的那一条，不是随机。** 两个理由：老化是时间的函数，先老的先该被消化；而且"选最老"是确定的，能写测试钉住，掷骰子不能。

**这些数字先写死在代码里**（30 天 / 90 天），不做成面板可调项。理由跟 D6 一样——一个可调阈值就是一个没人知道当前值是多少的黑箱，而这条判据必须随时能解释"为什么挑了它"。跑上几个月发现不对，改代码、走 PR，比改滑块留下的痕迹清楚。

### 一个刻意不做的事

宪法第六条还有半句：「凉了的合并成一句脾气，写成**新条目**」。

**这半句本文不实现。** 因为"合并成一句脾气"产出的是一条新的自我理解，那属于 Self-note 层（`MEMORY.md:120-135`），归主体 AI 唯一 writer。Reflect 这一趟先只做前半句——重读、追加理解、给老条目挂上降级标。"沉淀成脾气"那一步等 Reflect 真的跑出几十条 Rereading 之后再看，那时候才知道要沉淀的是什么。

先做一半，是因为另一半现在没有材料。

### 要你定的

| | 方案 | 代价 |
|---|---|---|
| **A（推荐）** | 就用上面三个信号，30/90 天写死 | 头几个月可能挑得不准，得看着调 |
| **B** | 再加一个"重要性"信号——Episode 自己带的 importance 字段参与排序 | 那个字段是写入时打的分，打分的人是当时的我，它不会老。用一个不会老的字段判断老化，方向反了 |

推荐 A。B 那条留在这里是因为它看起来很顺手，写明白为什么不做，免得下一个人又想起来。

---

## 四、降级语义：深档在哪，还查不查得到

### 先把话说死：查得到

D7 的原话是"默认隐藏 ≠ 不可查询"。`CLAUDE.md` 的腐化信号清单里也有一条：「『默认隐藏』被实现成『无法查询』」——**出现即停下记录**。

所以降级之后：**不进普通对话上下文（本来就不进），但 `memory_lookup` 依然查得到。** 这不是可选项，是 D7 的直接推论。

### 深档是什么

**深档不是另一个文件夹，是一条追加式的老化索引。**

具体：continuity 目录下新增一个 `aging_index.jsonl`，一条降级写一行：

```json
{"ep_id":"...", "state":"cold", "downgraded_at":"2026-07-29", "rereading_ref":"<marker>", "reason":"no_recall_90d"}
```

`episodes.jsonl` **一个字节不动**。

为什么这样而不是真把老 Episode 搬走：

1. 搬运就是改写。宪法第六条"只追加，不原地改写"、不变量 6"候选与正式分离是全局禁区"、`MEMORY.md:264`"同一条信息只能有一个事实来源"，三条同时指向不搬。
2. 搬走之后 `episodes.jsonl` 就有两份真相了（原档 + 归档），而 `memory-lookup` 要同时搜两处，翻档结果里同一条会出现两次。
3. 降级要能撤销。索引是追加的，写一行 `state:"warm"` 就撤回了；搬文件撤不回来。

所以"深档"在体验上是真的——查出来的时候它带着"这条已经凉了"的标；在存储上它只是一行索引。

### 已知的坑：lookup 加源不是免费的

`src/services/memory-lookup-service.js:15-26` 的数据源是**写死的三个文件**：

```js
this.episodesFile = path.join(continuityDir, "episodes.jsonl");
this.timelineFile = path.join(continuityDir, "relationship_timeline.md");
this.topicsFile   = path.join(continuityDir, "topics.md");
```

`readSources()` 就返回这三样（第 22-26 行），`searchMemorySources()`（第 102-110 行）只把 `episodes` 和 `timeline` 两个数组拼起来搜。

要让重读和降级标进 lookup，得动三处：

1. `readSources()` 加 `rereadings` 和 `aging`；
2. `searchMemorySources()` 要能搜 markdown 段落——`rereadings.md` 是文本不是 jsonl，现在的 `searchEpisodes()` 吃的是对象数组，需要一个把 marker 分段的解析器；
3. 结果里要能带上"已降级"这个标，不然查到了也看不出温度。

**这不撞现有 CI**（已查证，见 `docs/design/DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md` 第 5 节）：`test/phase2-hard-context.test.js:247-256` 钉的是三个常驻上下文构建器的源码里不许出现 `rereadings.md`，那份清单只有 `shared-instructions.js` / `hard-context.js` / `reentry-loader.js`，**`memory-lookup-service.js` 不在清单里**。守的是"默认不注入"，不是"不许被翻档工具读"。

另外两个现成的约束照旧生效，不用额外做：翻档每 session 最多 5 次、最多 3 条命中、单条 500 字（`memory-lookup-service.js:8-10`）；触发词只有 `user_pull` / `resonance` / `stakes` / `repair` 四个（第 100 行），其中后三个按 D7 尚未开放。

### 要你定的

| | 方案 | 代价 |
|---|---|---|
| **A（推荐）** | 深档 = 追加式老化索引，`episodes.jsonl` 不动，lookup 加源后能查到并显示"已降级" | lookup 要写一个 markdown 分段解析器，是本文里唯一一块实打实的新代码 |
| **B** | 真把老 Episode 搬进 `episodes_archive.jsonl` | 撞不变量 6 和"单一事实来源"，撤不回来，lookup 还是要加源。不推荐 |

---

## 五、写入权登记：不新增 writer

### 结论

`docs/architecture/MEMORY.md:261` 那一行已经写好了位置：

> Timeline / Rereadings / Portrait：受控 Reflect writer 更新。

**Reflect 复活不新增任何 writer。** 新增的 `aging_index.jsonl` 归同一个受控 Reflect writer，所以第七节那张表**不加行，只在已有那一行的文件清单里多列一个文件名**。

这条很重要：不变量 4 说单 writer，同一文件出现第二个 writer 是一级腐化信号。老化索引跟 Rereadings 是同一趟动作的两个产物——一次重读，追加一条理解 + 挂一个温度标——它们由同一个动作、同一个身份写下，天然是同一个 writer。如果哪天有人提议让别的东西写老化索引（比如让一个定时任务去刷温度），那就是在给同一份文件加第二个 writer，直接停。

写入用的锁沿用现成的：`weekly-reflect.js:6` 已经在走 `acquireWriterLease` / `releaseWriterLease`，`rereadings.md` 写之前先 `backupFile` 再 `replaceTextAtomic`，追加不覆盖。这套不用改。

### 一次改完，别改两次

`MEMORY.md` 第七节这张表**近期至少有三件事要往里加**：

1. 本文的老化索引（归 Reflect writer，只补文件名）；
2. **details 账本**（宪法第三条那一层，issue #35）；
3. **活动日志 / 经历区**（`DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md:141` 与该文第六节第 2 条：主体 AI 唯一 writer，第七节需新增一行）。

**建议这三条攒在同一次表变更里提。** 理由是 `CLAUDE.md` 第六节的文档治理纪律——改稳定结构文档是"行为变了才改"，一张管写入权的表在两周里被改三次，读的人会分不清哪一版是当前的，而且每一次改都要重新过一遍"有没有新 writer"这个检查。攒一次过一遍，比分三次各过一遍更容易看出冲突。

顺序上不冲突：老化索引不加行，账本和活动日志各加一行，三者互不覆盖。

---

## 六、无变化出口：什么都不动是正常结果

### 这条不用设计，只用别搞砸

`docs/architecture/MEMORY.md:217` 就一句：「无变化是正常结果。」`MEMORY.md:180` 对 Closeout 也是同一个态度：「每天最多一次，允许无产出。」

`weekly-reflect.js:6` 现在已经有三个 `no_change` 出口，都写对了：

- `no_episodes` —— 没有可选的 Episode；
- `invalid_episode` —— 选中的那条没有 id；
- `runtime_empty` —— 模型读完了，一个字都没写。

### 要加的

第四个出口：**`nothing_cold`** —— 按第三节的判据，一条凉的都没有。这不是错误，这说明最近这段时间的记忆都还在用着。

以及三条不能违反的：

1. **`no_change` 不是失败。** 面板上显示成一句平的话（"这次读完，没什么要改的"），不是红色，不进异常列表，不触发重试。
2. **模型说"没什么要说的"要被接受。** `runtime_empty` 现在的语义就是对的——重读完了觉得没有新理解，那就没有。**不许**为了"这次要有产出"而加任何"请至少写一条"的提示词。那会直接生产出宪法第五条要拦的那种空话。
3. **无变化也占掉本周的幂等门。** `weekly-reflect.js:6` 现在就是这样（`complete()` 无论 `no_change` 还是 `success` 都写进 `state.weeks[week]`），保持不变。不然会变成"没产出就再试一次"，试到出东西为止——那就是逼供。

---

## 七、与现有代码的差距清单

所有行号对 `main 0fd8f89`。

### 已经有的（能直接用）

| 东西 | 位置 | 说明 |
|---|---|---|
| 幂等门（一周一次） | `src/continuity/weekly-reflect.js:6` | `weekKey` + `state.weeks[week]`，重跑返回 `already_ran` |
| Writer lease | `src/continuity/weekly-reflect.js:6` | `acquireWriterLease` / `releaseWriterLease`，含 stale 回收 |
| 只追加不覆盖 | `src/continuity/weekly-reflect.js:6` | 先 `backupFile` 到 `.backups`，再 `replaceTextAtomic` 追加，带 `<!-- weekly-reflect:hash -->` 幂等标记 |
| 三个无变化出口 | `src/continuity/weekly-reflect.js:6` | `no_episodes` / `invalid_episode` / `runtime_empty` |
| Self-note 读取 | `src/continuity/weekly-reflect.js:8` | `recentNotes()`，取最后 5 行、截 1200 字 |
| 翻档日志（老化信号 1 的数据源） | `src/services/memory-lookup-service.js:81-97` | `appendRecall()` 已经在写 `hit_ids`，字段现成 |
| 别名扩展（老化信号 2、3 的算子） | `src/services/memory-lookup-service.js:112-125` | `expandQueryAliases()` 读 `topics.md`，纯字面，符合 D6 |
| 写入权表里的位置 | `docs/architecture/MEMORY.md:261` | 「受控 Reflect writer」这一行已存在 |
| 面板只读视图 | `dashboard.py:5310, 5353`；前端 `dashboard.py:4047-4048` | `/api/rereadings_index`、`/api/rereadings` |
| 手控 POST 端点的先例 | `dashboard.py:5603` | `/api/review/retry`：POST + token + 本机绑定，新端点照这个形状抄 |
| 合法的身份枚举 | `src/continuity/candidate-authority.js:7-9` | `subject_ai` / `active_session` / `high` 三个值都已合法，不用新增枚举 |

### 缺的

| 缺什么 | 现状 | 归本文哪一节 |
|---|---|---|
| **没人实例化 `WeeklyReflect`** | 全仓搜 `WeeklyReflect`，只有 `weekly-reflect.js:4` 自己、`test/weekly-reflect.test.js:1-3`、和三份文档提到它 | 一、二 |
| **`runtime.reflect()` 没有实现方** | `weekly-reflect.js:6` 只在 `typeof runtime?.reflect === "function"` 时调用；`src/` 里没有任何对象提供这个方法 | 二 |
| **520 没有任何发起端点** | `dashboard.py` 全文搜 `nightly` 零命中；Reflect 也只有读端点 | 一 |
| **选 Episode 是掷骰子** | `weekly-reflect.js:6` 的 `Math.floor(this.random()*choices.length)`，默认 `random=Math.random`（第 5 行）；只排除最新一条 | 三 |
| **没有老化索引** | `aging_index.jsonl` 不存在 | 四 |
| **lookup 数据源写死三个文件** | `memory-lookup-service.js:15-26` 的 `episodesFile` / `timelineFile` / `topicsFile`；`searchMemorySources()`（102-110）只拼 episodes + timeline | 四 |
| **`nothing_cold` 出口不存在** | 只有三个 `no_change` 分支 | 六 |
| **周界时区写死成上海** | `weekly-reflect.js:8` 的 `dateKey()` 用 `Asia/Shanghai`。Owner 已点名这是错的：周界与老化天数都必须按**她所在的时区（生产机本地时区，当前 +10:00）**算，不是上海。仓库里同源的 `Asia/Shanghai` 还散在 `system-checkin-poller.js`（睡眠窗）与 `utils/beijing-time.js`（时间戳/报时），那两处不归本文，但复活 Reflect 时**这一处必须一并替掉**，建议统一走一个可配置的时区来源而不是再写死一个城市 | 复活第 1 步一并改 |
| **lease 里有三个写死的假值** | `weekly-reflect.js:6`：`phase:"fable"`、`branch:"feat/fable-wishlist-20260713"`、`base_sha:"0".repeat(40)`。这是当年那个分支留下的死值，跟当前 main 没关系 | 复活时顺手改，别留 |
| **`recentNotes()` 按行截断** | `weekly-reflect.js:8` 取最后 5 行。Self-note 是分段的 markdown，按行取可能只截到半段 | 复活时评估，不是阻塞项 |
| **单测不在任何 CI 分组里** | `test/weekly-reflect.test.js` 在 `package.json` 里搜不到（零命中），因此不在任何 `test:*` 分组，也就不在 `.github/workflows/phase1-offline.yml` 里 | 见下 |

### 复用但要小心的

- **`candidate-authority.js:44-52` 允许 `background_proxy + medium` 的 Episode 直接发布。** 这跟 D16「后台不拥有任何记忆写入权」对不上。不归本文裁定（是 G2 的活），但 Reflect 的产出**不能**走这条路——身份按第二节固定成 `subject_ai`。
- **`continuity-pipeline.js:103-108` 的候选默认值是 `background_proxy` / `medium`。** Reflect 如果复用这条管线，必须显式传 `candidateMetadata` 覆盖，不能吃默认值。
- **`claudecode/index.js:768-772` 的后台 lane 是刻意零上下文的。** 那是为 closeout 设计的，不是给 Reflect 用的。别因为"现成就有一条后台通路"而接上去。

### 测试与 CI

按 `CLAUDE.md` 第五节第 4 条：本地跑绿 ≠ 有 CI 信号。Reflect 复活要同时做两件事——

1. `test/weekly-reflect.test.js` 现有两条（幂等 + 排除最新条、空产出 + 周界。周界那条现在断言的是上海时区，随时区修正一并改成她所在时区）先进一个 `npm run test:*` 分组；
2. 那个分组要接进 `.github/workflows/phase1-offline.yml`，否则 `CURRENT_STATUS.md` 的「主 CI」列只能继续写 `NONE`。

新增的测试至少要钉住三件事：选 Episode 是确定的（同样输入必选同一条）、`nothing_cold` 是 `no_change` 不是错误、降级只往 `aging_index.jsonl` 追加而 `episodes.jsonl` 字节不变。

---

## 八、依赖与顺序

```text
第 1 步  老化判据（第三节）
        替掉 Math.random，加 nothing_cold 出口
        不依赖任何裁决，不依赖 G2，可以马上做

第 2 步  窄版触发（第二节方案 B）
        只认"当面说重读一下"，身份天然是 subject_ai
        依赖第 1 步

第 3 步  深档与 lookup 加源（第四节）
        aging_index.jsonl + memory-lookup 三处改动 + markdown 分段解析
        依赖第 1 步；本文里唯一一块实打实的新代码

第 4 步  520 发起端点（第一节）
        照 /api/review/retry 的形状补 POST
        依赖 G2（"当前窗口 AI 接得到后台留的活"这条线）

第 5 步  写入权表变更（第五节）
        跟 details 账本、活动日志攒在同一次提
        依赖那两件事各自成型
```

**卡住的只有第 4 步，卡在 G2。** 前三步不等任何人。

---

## 九、还没定、不得当成方向施工

1. **"凉了合并成一句脾气"那半句**（第三节末）——需要先跑出几十条 Rereading 才知道要沉淀什么。它属于 Self-note 层，不属于 Reflect writer。
2. **Rereading 怎么影响 Re-entry** ——`MEMORY.md:159` 说"可以在 Reflect 后间接影响 Re-entry 的姿态与措辞"。怎么影响没有定。这里有一道必须先立的闸（`DESIGN-MEMORY-EXPERIENCE-AND-RECALL.md` 第 5 节）：`CLAUDE.md` 列的第一条腐化信号就是「Re-entry 注入字数持续上涨」，所以规矩应该是**只允许改已有那几行的措辞和分寸，不允许新增行**，且写成钉住行数的测试。本文不裁定这一条。
3. **`candidate-authority.js:44-52` 与 D16 的冲突** —— 归 G2，不归本文。
4. **老化阈值要不要做成可调** —— 本文主张写死（第三节），但那是主张不是决定。

---

## 十、依赖声明

本文引用 D6 / D7 / D16 与 `docs/MEMORY_CONSTITUTION.md`，四者均已在 `main` 上。行号对 `main 0fd8f89`；`docs/CURRENT_STATUS.md` 当前 `Verified against: 9bb78a0f`，两者之间若有 `src/continuity/` 或 `src/services/memory-lookup-service.js` 的改动，第七节的行号需要重核。

本文是补充材料，不改变 `docs/CURRENT_STATUS.md:89` 那一行的任何状态词。Reflect 仍是 `ORPHAN` / `FAIL`，直到第八步的第 1 步真的落地。
