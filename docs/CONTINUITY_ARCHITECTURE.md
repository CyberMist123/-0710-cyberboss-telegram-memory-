# Continuity Architecture

> 状态：唯一架构真相  
> 最后更新：2026-07-10  
> 本文只说明稳定结构，不记录每天进度。

## 目标

好的记忆系统不替 AI 决定下一句话，只让它说下一句话时不是从虚无开始。

判断标准：

- 记忆改变回应的姿态，而不是替模型规定内容；
- 当前对话始终优先；
- 普通闲聊可以没有旧记忆进入；
- 过去可以被现在重新理解和修正；
- 不用大量规则制造“表演式连续性”。

## 1. 对话时模型能看到什么

### 1.1 硬上下文

```text
System Prompt
+ Role Card
+ 新线程首轮 Re-entry
+ 轻量 Current State
+ 当前真实对话
```

规则：

- System Prompt：核心能力、安全边界与最稳定人格来源；每轮存在。
- Role Card：补充角色路径，不要重复 System Prompt；通常在新线程或新 continuity epoch 加载。
- Re-entry：只在重入首轮加载一次，告诉模型最近走到哪里；不是完整历史。
- Current State：来自 Cyberboss desire runtime，只表达短期姿态，不定义人格。
- 当前对话：最高优先级，冲突时旧记忆必须退让或求证。

### 1.2 Soft Retrieval

未来按需加入：

```text
检索候选
→ 关系/家族扩展
→ Reading Policy
→ 最多 0–3 条记忆纸条
```

Soft Retrieval 与 Re-entry 不同：

- Re-entry 服务于“醒来接回”，首轮一次；
- Soft Retrieval 服务于“这一轮是否需要旧事”，普通对话允许 0 条；
- Soft Retrieval 当前暂缓，详见 `SOFT_RETRIEVAL.md`。

## 2. 真正的数据层

只把以下内容当成需要保存的长期数据。

### 2.1 Event Ledger / Episode

保存共同发生过的事件：

- 发生了什么；
- 时间与来源；
- 是否确认；
- 重要性；
- 后来有没有修正、补充或重新理解。

旧 `episodes.jsonl` 的叙述和情感痕迹先保留，不因架构重构而重写。

### 2.2 Living State

保存仍然活着的事项：

- 未完成任务；
- 正在讨论的问题；
- 当前承诺；
- 等待决定的事项；
- 已确认但仍需要近期注意的边界。

它比 Timeline 更接近下一次醒来真正需要知道的内容。

### 2.3 Self-note

保存 AI 自己的选择、误读、修正、兴趣、疑问和重读。

规则：

- 使用第一人称；
- 有来源；
- 可以被后来修正；
- 不自动转化成用户画像；
- 不写成永久人格宣言。

### 2.4 Boundary / Task

边界和任务可以作为独立事件类型或 Living State 的结构化节点保存，但不能在 Role Card、Re-entry、Self-note、Timeline 中重复抄写同一句话。

## 3. 阅读视图，不是第二套真相

### Re-entry

从 Event Ledger、Living State 和必要的 Self-note 生成。

内容只保留：

- 最近走到哪里；
- 少量未完事项；
- 近期仍相关的确认边界；
- 一项明确的不确定。

### Timeline / Long View

低频整理事件的发展过程，方便人和 AI 回看。

- 不进入普通对话热路径；
- 不与 Episode 两边各写一份真相；
- 不需要每天重建；
- 原始事件和修正关系始终可追溯。

### Portrait

若继续保留，只能是有证据的当前理解视图：

- 写“反复在意什么”，少写“她是什么人”；
- 用户画像 claim 默认需要确认；
- 被纠正时保留修复史，不静默覆盖。

## 4. 后台过程

### Closeout

每天最多一次，允许无产出。

只提出候选：

- 0–2 条事件；
- Living State 变化；
- 0–1 条 Self-note；
- Re-entry 更新建议。

### Independent Review

与 Closeout 分开运行，负责：

- 接受；
- 拒绝；
- 延后；
- 合并；
- 修正；
- 判断是否需要用户确认。

自动流程不应直接覆盖用户确认过的长期边界、重大关系定义或修复解释。

### Reflect / Consolidation

低频运行，有足够新证据时才做：

- 重新理解旧 Episode；
- 建立修正、因果、同主题等关系；
- 更新 Timeline、Family summary 或 Long View。

无变化是正常结果。

### Janitor

只负责断档补漏，不是正常的高频记忆作者。

- 扫描漏掉的会话；
- 只写 candidates / extracted；
- 没有断档时不调用模型；
- 不直接写正式 Episode、Timeline、Portrait 或 Re-entry。

## 5. Desire 状态

Desire 属于 Cyberboss runtime，不属于关系正史。

- 只有一个 writer；
- `state_log.jsonl` 作为旧历史冻结；
- 520、Closeout、Janitor、关系记忆都禁止写 Desire；
- Current State 可以轻量进入上下文，但不能把数值变成人格规则。

## 6. 520 的位置

520 是可关闭的前端与调试台：

- 查看模块状态；
- 查看 Context Trace；
- 管理 Prompt 版本；
- 查看后台任务；
- 审核 candidates；
- 显示运行健康。

520 不能成为第二个记忆后端，也不能在页面代码中直接发明新的历史、写 Desire 或绕过 Review 修改 canon。

## 7. 写入权与防重复

- 原始会话：系统自动写，唯一事实来源。
- candidates：Closeout / Janitor 等自动流程写。
- canon：唯一 Review / History writer 写。
- Desire：唯一 Desire service 写。
- Re-entry、Timeline、Portrait：由 canon 生成或在受控流程中更新。
- 520：只调用后端服务，不直接改正式文件。

同一条信息只能有一个事实来源。其他文件若出现，只能作为引用或生成视图。

## 8. 当前实施边界

今晚优先跑通硬上下文、后台写入与状态链，不实现 Soft Retrieval、reranker、Memory Family 或 GraphRAG。

架构不要求旧 Episodes 立刻迁移。先保证旧数据可读、来源不丢、运行不双写，再考虑统一 schema。
