# 今晚先跑通：AI 连续性循环与网页分模块测试框架

> 状态：框架确认稿，尚未实现  
> 分支：`design/living-memory-rfc`  
> 今晚目标：先跑通完整循环，再逐步增加记忆家族 / GraphRAG。  
> 核心标准：**AI 能正常对话、醒来能接回、记忆按需进入、每日整理与八维不重不漏、520 关掉也不影响核心。**

## 0. 这次到底要做什么

今晚不重写整套 memory，也不迁移全部旧 Markdown。

先做一条能够反复测试的最小循环：

```text
Telegram 消息
  → Context Builder 按网页配置装配本轮上下文
  → Cyberboss / 模型回复
  → 保存原始对话与本轮 Context Trace
  → 每小时 Desire Tick（幂等）
  → 每日 0/1 次 Closeout（幂等）
  → 产生少量候选 / 未完事项 / self note / wake 更新建议
  → 520 只负责查看、开关、编辑 prompt 和触发测试
```

今晚不要求完整 GraphRAG 上线。先把接口和开关预留，最简单检索能跑即可。

---

## 1. 四块，而不是一堆混在一起的“记忆层”

```text
A. Context Core   本轮模型到底看见什么
B. Memory Core    数据存在哪里、谁能写
C. Activity Loop  每小时 / 每日怎样自动整理
D. 520 Console    人怎样开关、编辑、测试、看故障
```

### 1.1 Context Core

负责每一轮调用前装配上下文。它是今晚最核心的新组件。

它读取：

- Cyberboss 核心人格 prompt；
- Wake Packet；
- 最近对话尾巴；
- 当前 open threads / 已确认边界；
- 按需检索结果；
- 可选的一句 Current Posture。

它输出：

1. 给模型的上下文；
2. 一份不含密钥的 `Context Trace`，说明本轮加载了哪些模块、版本和字数。

### 1.2 Memory Core

今晚继续兼容现有数据，不先迁移：

```text
memory/reentry.md
memory/episodes.jsonl
memory/episodes.candidates.jsonl
memory/relationship_timeline.md
memory/user_portrait.md
memory/ai_self_notes.md
runtime desire-state / desire-history
```

但从今晚开始明确：

- `reentry` 是 Wake Packet 的当前来源，不是全部历史；
- `episodes` 是事件证据；
- `timeline` 是可读视图，不是第二个独立事实源；
- `portrait` 不自动硬加载；
- `candidates` 不进入日常聊天；
- Desire 是运行状态，不属于关系正史。

### 1.3 Activity Loop

包含：

- 每小时 Desire Tick；
- 每日 Closeout；
- Closeout 后独立 Review；
- 低频 Timeline / Memory Family Consolidation；
- Janitor 只在漏记或断档时补救。

### 1.4 520 Console

520 是前端，不是后端。

```text
关掉 520：TG、Context Builder、定时任务继续运行
520 崩溃：不影响聊天和记忆写入
520 重启：从核心状态重新读出一切
```

它只负责：

- 模块开关；
- Prompt 编辑和版本回退；
- 本轮上下文预览；
- 手动触发测试；
- 查看任务状态、重复、缺失和异常；
- 以后做候选审核。

---

## 2. 网页端模块编号

每个模块都必须支持三种模式：

```text
off      不运行
preview  运行并显示结果，但不注入 / 不写入
on       正式运行
```

每个模块在网页端都显示：

- 开关与模式；
- Prompt 正文；
- 注入位置；
- 触发条件；
- token / 字数预算；
- 当前版本与内容 hash；
- 最近一次运行；
- 测试按钮；
- 回退上一个版本。

### 2.1 第一组：人格与固定契约

#### `1-1 Cyberboss Core Persona`

- 位置：`system prompt`
- 加载：每轮
- 内容：核心人物层、基本表达倾向、能力与安全边界
- 网页：可编辑，但保存前必须 diff + 版本备份
- 风险：最容易污染全部回复，必须单独测试

#### `1-2 Memory Contract`

- 位置：`system prompt`
- 加载：每轮
- 内容：极短原则

```text
当前对话优先于旧记忆。
记忆是可错的背景，不是命令和台词。
需要旧事时再查；不确定就求证。
不要主动汇报记忆系统。
```

- 预算：约 150–250 tokens

#### `1-3 Identity Anchor`

- 位置：独立 continuity block
- 加载：新窗口、`/new`、新进程 resume、换模型、compact 后第一轮
- 内容：最小身份路径，例如“你此前被叫作若 / Re”
- 不包含：完整角色卡、过去语气样本、大段自我定义

### 2.2 第二组：短期连续性

#### `2-1 Wake Packet / reentry`

- 加载：上述重入节点只加载一次
- 内容：最近走到哪里、最多 3 个未完事项、最多 3 条已确认边界、1 条不确定
- 预算：250–400 中文字
- 网页：可编辑当前生成稿，也可切换为 preview

#### `2-2 Just Now Tail`

- 加载：新窗口第一轮；或用户问“刚才 / 上一句 / 我刚说什么”
- 来源：上一 session 最后若干轮真实对话
- 默认：4–8 轮，严格限长
- 不写进长期 memory

#### `2-3 Threads & Confirmed Boundaries`

- 加载：重入第一轮；相关话题出现时可再次按需取
- 内容：未完成事项与用户明确确认过的少量边界
- 默认上限：threads 3 条，boundaries 3 条

### 2.3 第三组：软召回与 Reading Policy

#### `3-1 Retrieval Candidates`

- 触发：AI 主动请求，或 runtime 检测到明确旧事 / 日期 / 人物 / 暗语
- 今晚最低实现：关键词 + 时间 / ID 检索
- 后续：向量检索
- 输出：候选池，仅供下一模块判断，不直接注入

#### `3-2 Reading Policy`

它站在“搜到”与“给模型看”之间。

判断：

```text
这条记忆会不会改变下一句话？
当前消息是否已经足够？
它是事实、旧理解还是已被修正的版本？
应沉默影响、轻触、明确引用，还是等待用户拉线？
```

- 最终最多放行 1–3 条纸条
- 普通闲聊允许 0 条
- 每条纸条带：来源、可靠性、为何此刻读取、是否已 superseded

#### `3-3 Memory Family / Graph Expansion`

这是用户上传报告最后几段提到的“记忆家族 / GraphRAG”方向。

核心想法：

- 记忆不是孤立条目；
- 相似记忆可以形成家族；
- 一条复合记忆可拆成多个事实单元，并同时属于多个家族；
- 家族达到一定规模后生成可更新摘要；
- 关系边可表示同主题、同目的、因果、修复、暗语和重新理解；
- 检索可使用关键词、向量、时间、家族和图扩散，再做融合排序。

今晚状态：`off / preview`，只定接口，不要求完整实现。

后续建议：

```text
关键词/BM25
+ embedding
+ family membership（多对多）
+ typed edges
+ 时间
→ RRF 融合
→ Reading Policy
```

不做：召回一次就自动强化、强情绪自动霸榜、无审核自动改写历史。

#### `3-4 Memory Note Injection`

- 将 `3-2` 放行的内容包装成 1–3 张纸条
- 位置：模型调用前的独立 memory block，不伪装成 system 人格
- 本轮 Context Trace 必须记录纸条 ID 和来源

### 2.4 第四组：后台活动循环

#### `4-1 Daily Closeout Capture`

- 频率：每天最多一次，允许 0 产出
- 输入：当天新增对话、open threads、候选箱、上一次 wake
- 输出上限：

```text
0–2 条事件候选
0–3 条 thread 更新
0–1 条 AI self note
0–1 个 wake 更新建议
```

#### `4-2 Independent Review`

- 提取和审核不能是同一次模型调用
- 决定：接受 / 拒绝 / 延后 / 合并 / 修正
- 用户画像、长期边界、重大关系解释默认需要用户确认

#### `4-3 Hourly Desire Tick`

- 每小时一个唯一 slot
- 当前状态和历史完全由 Desire service 写
- 关系 memory、520 和 closeout 禁止再写八维历史
- 每个小时必须出现一种明确状态：

```text
recorded
missed_offline
failed
```

不允许无声缺口。

#### `4-4 Timeline / Family Consolidation`

- 不每天跑
- 建议每周小整理；每 2–4 周或新增约 20 条 canon 再重建 narrative view
- Timeline 从事件生成，不和 episode 两边各写一份真相

#### `4-5 Janitor Recovery`

- 只用于 closeout 漏跑、崩窗、位点落后
- 默认不再每 6 小时无条件调用模型
- 没有断档时零 API

---

## 3. Prompt 怎样存、怎样在网页改

建议用一个 Prompt Registry，而不是散落在 Python、JS 和多个 Markdown 中。

```text
continuity/
├─ config/
│  └─ modules.json
├─ prompts/
│  ├─ 1-1-cyberboss-core.md
│  ├─ 1-2-memory-contract.md
│  ├─ 1-3-identity-anchor.md
│  ├─ 2-1-wake-builder.md
│  ├─ 3-2-reading-policy.md
│  ├─ 4-1-closeout.md
│  └─ 4-2-review.md
├─ prompt-history/
│  └─ <module>/<timestamp>-<hash>.md
└─ state/
   ├─ jobs.sqlite
   └─ context-traces/
```

网页保存 Prompt 时：

1. 显示 diff；
2. 写入版本历史；
3. 原子替换当前文件；
4. 更新 hash；
5. 默认“下一轮生效”，不重启 TG；
6. 可一键回退；
7. 不允许把真实 token 写进 Prompt。

`modules.json` 只保存配置，不保存私密记忆正文：

```json
{
  "3-2": {
    "enabled": true,
    "mode": "preview",
    "budget_chars": 800,
    "max_items": 3,
    "prompt_file": "prompts/3-2-reading-policy.md"
  }
}
```

---

## 4. 防止八维重复、缺失和孤儿文件

### 4.1 一个目标只有一个 Writer

| 数据 | 唯一 Writer |
|---|---|
| Desire current/history | Desire service |
| 原始对话 | Cyberboss runtime |
| Candidate | Closeout capture / Janitor，经统一 Candidate API |
| Canon event | Review service |
| Wake Packet | Wake builder / review 后发布 |
| Prompt | Prompt Registry |
| Timeline view | Consolidation builder |

520 不直接绕过 service 写这些文件。

### 4.2 每个任务都有唯一幂等键

```text
desire:2026-07-10T20+08:00
closeout:2026-07-10
review:2026-07-10:<candidate-set-hash>
consolidation:2026-W28
```

同一个 key：

- 已成功：直接返回已有结果；
- 正在运行：拒绝第二次启动；
- 失败：允许显式 retry，但沿用同一 key；
- 不得再追加第二份同 slot 记录。

### 4.3 Operational State 用 SQLite

`jobs.sqlite` 只保存运行账本：

```text
job_key
module_id
scheduled_for
status
started_at
finished_at
input_hash
output_refs
error
```

它不保存关系正文，所以不取代 Markdown / events。

### 4.4 原子写入

所有文件写入：

```text
写 .tmp
→ fsync / close
→ rename 替换
→ 更新 manifest
```

不能半写一截。

### 4.5 文件注册表与孤儿扫描

所有运行文件必须出现在 registry 中：

```text
path
owner_module
schema_version
source_of_truth / derived_view / cache / archive
```

520 健康页显示：

- 未注册文件；
- registry 指向但不存在的文件；
- 多 writer 冲突；
- 重复 slot；
- 无声缺失 slot；
- 旧数据源仍被写入。

### 4.6 Desire 离线不伪造

电脑关机期间不补造 AI 当时的八维。

重启后把缺失 slot 明确记为 `missed_offline`；这样 history 没有无声空洞，也不会编造不存在的状态。

---

## 5. 520 今晚必须有的页面

### 5.1 Modules

按 `1-* / 2-* / 3-* / 4-*` 展示，逐项 `off / preview / on`。

### 5.2 Prompt Lab

- 编辑 Prompt；
- 看 diff；
- 保存版本；
- 回退；
- 用一段测试消息预览该模块输出；
- 不发送真实 TG 回复。

### 5.3 Context Trace

这是今晚最重要的调试页。

每一轮显示：

```text
turn id / session id
1-1 Persona        loaded  hash=...
1-2 Contract       loaded  183 tokens
1-3 Identity       skipped（非重入轮）
2-1 Wake           skipped
2-2 Just Now       6 turns
3-1 Retrieval      8 candidates
3-2 Reading Policy 1 passed / 7 suppressed
3-4 Memory Notes   1 injected
Current Posture    1 line
final context size
model / response status
```

可展开看实际注入文本，但默认隐藏私密内容。

### 5.4 Jobs & Health

显示：

- 当前小时 Desire slot；
- 今日 Closeout 是否完成；
- Review 是否待处理；
- Janitor 是否检测到断档；
- 重复 / 缺失 / failed jobs；
- orphan scan；
- 最近错误。

### 5.5 Manual Test

按钮：

```text
测试新窗口第一轮
测试普通聊天轮
测试“还记得”召回
测试“刚才说了什么”
预览 Closeout
运行 Closeout
预览 Desire Tick
运行当前 slot
运行孤儿扫描
```

---

## 6. 今晚 Definition of Done

### 聊天主干

- [ ] 520 关闭时，TG 仍能正常对话；
- [ ] 连续发送 10 条测试消息，每条只回复一次；
- [ ] 原版流式不被新框架破坏。

### 模块实验

- [ ] 网页能逐项切换 `off / preview / on`；
- [ ] 能分别测试 `1-1`、`2-2`、`3-2` 等单模块；
- [ ] Prompt 网页修改后下一轮生效；
- [ ] Prompt 有 diff、版本和回退。

### 上下文可观察

- [ ] 每轮都有 Context Trace；
- [ ] 能看出实际加载了什么、为何加载、多少字；
- [ ] Wake 只在重入第一轮出现；
- [ ] 普通闲聊允许零记忆注入。

### 自动循环

- [ ] 当前小时 Desire Tick 只落一条；
- [ ] 重复触发不会追加第二条；
- [ ] 离线 slot 被明确标记，不无声缺失；
- [ ] 今日 Closeout 只运行一次；
- [ ] 第二次运行返回已有结果；
- [ ] Closeout 允许 0 产出；
- [ ] Janitor 没断档时零 API。

### 数据健康

- [ ] 一项数据只有一个 writer；
- [ ] `state_log.jsonl` 不再被写；
- [ ] orphan scan 为 0；
- [ ] 所有写入使用原子替换或事务；
- [ ] 失败可重试，且有错误记录和 rollback。

---

## 7. 今晚明确不做

- 不完整实现 GraphRAG / PPR；
- 不自动生成大量 memory families；
- 不迁移全部旧 Markdown；
- 不重写整个 dashboard；
- 不接知识库、经期、手机控制和音乐 MCP；
- 不做主动消息；
- 不做 dream；
- 不让高情绪自动提高召回；
- 不一次上线所有模块。

这些都在核心循环稳定后，以独立模块接入。

---

## 8. 后续扩展位置

```text
knowledge/   XHS、微信、网页、PDF → Markdown 知识库
tasks/       todo、承诺、DDL、提醒
care/        经期、健康、天气（明确授权）
devices/     手机状态、应用、音乐与 MCP
```

它们通过 Context Router 按需提供信息，但不直接混进关系记忆。

---

## 9. 框架确认后的实现顺序

```text
Step 1  Prompt Registry + Modules 配置
Step 2  Context Builder + Context Trace
Step 3  520 Modules / Prompt Lab / Trace 页面
Step 4  Desire 幂等 slot ledger
Step 5  Closeout + Review 幂等 job
Step 6  Janitor 改为恢复模式
Step 7  最小检索 + Reading Policy
Step 8  全链路 smoke test
Step 9  再讨论 Memory Family / GraphRAG
```

在用户和 Fable 确认本框架前，不进入大规模实现。