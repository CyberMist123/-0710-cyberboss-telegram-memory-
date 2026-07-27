# Continuity Architecture

> **Status: stable domain architecture**
> **Scope:** memory / continuity only —— 本文只说明这一域的稳定结构，不记录进度。
> 系统级总览见 [`SYSTEM_OVERVIEW.md`](./SYSTEM_OVERVIEW.md)；当前实现状态见 [`../CURRENT_STATUS.md`](../CURRENT_STATUS.md)。

## 目标

好的记忆系统不替 AI 决定下一句话，只让它说下一句话时不是从虚无开始。

判断标准：

- 记忆改变回应的姿态，而不是替模型规定内容；
- 当前对话始终优先；
- 普通闲聊可以没有旧记忆进入；
- 过去可以被现在重新理解和修正；
- AI 可以拥有可查阅的过去，不必把所有过去同时放进当前上下文；
- 不用大量规则制造“表演式连续性”。

## 1. 对话时模型能看到什么

### 1.1 默认硬上下文

```text
System Prompt
+ Role Card
+ 新线程首轮 Re-entry
+ 轻量 Current State
+ 当前真实对话
```

规则：

- System Prompt：核心能力、安全边界与最稳定人格来源；每轮存在。
- Role Card：补充角色路径，不重复 System Prompt；通常在新线程或新 continuity epoch 加载。
- Re-entry：只在重入首轮加载一次，告诉模型最近走到哪里；不是完整历史。
- Current State：来自 Cyberboss desire runtime，只表达短期姿态，不定义人格。
- 当前对话：最高优先级，冲突时旧记忆必须退让或求证。

### 1.2 默认隐藏的旧档

从 `episodes.jsonl` 开始，以下内容默认不自动读取、不自动注入普通对话：

- Episodes；
- Timeline；
- Portrait；
- Self-note；
- Rereadings。

默认隐藏不等于删除、遗忘或禁止访问。需要区分：

1. **自动注入**：Soft Retrieval，当前暂缓且默认关闭；
2. **用户拉线后的查询**：用户明确寻找旧事时，允许工具式翻阅；
3. **AI 主动翻阅**：以后可在有明确 `why_now`、小预算和边界约束时开放。

AI 翻到旧 Episode 后，可以像翻日记一样重新理解当时，不必假装这段内容一直处于当前意识中。

### 1.3 Soft Retrieval

未来按需加入：

```text
检索候选
→ 可选关系扩展
→ Reading Policy
→ 最多 0–3 条记忆纸条
```

Soft Retrieval 与 Re-entry 不同：

- Re-entry 服务于“醒来接回”，首轮一次；
- Soft Retrieval 服务于“这一轮是否需要旧事”，普通对话允许 0 条；
- 用户明确拉线后的工具式查询不等于自动 Soft Retrieval；
- 当前暂缓，详见 `SOFT_RETRIEVAL.md`。

## 2. 真正的数据层

### 2.1 Event Ledger / Episode

保存共同发生过的事件：

- 发生了什么；
- 时间与来源；
- 是否确认；
- 重要性；
- 后来有没有修正、补充或重新理解。

旧 `episodes.jsonl` 的叙述和情感痕迹先保留，不因架构重构而重写。

### 2.2 Re-entry

Re-entry 是 canon 的一部分，是 AI 留给下一个自己的短交接，不是程序自动拼接的第二套报告。

唯一 writer 是主体 AI。支持两种 authoring mode：

1. AI 根据最近对话自主写；
2. 系统整理事实、未完事项和来源作为材料，再由 AI 起草。

Auto Review 只检查：

- 是否有事实依据；
- 是否超过长度预算；
- 是否违反安全或格式边界；
- 是否把不确定内容写成确定事实。

Auto Review 不改写 AI 的措辞。

Re-entry 只保留：

- 最近走到哪里；
- 少量悬着的钩子；
- 近期仍相关的确认边界；
- 一项明确的不确定。

不新增独立 Living State 文件。系统提取的待办与事实可以作为生成材料，用完即弃或留在候选记录中。

### 2.3 Self-note

保存 AI 自己的选择、误读、修正、兴趣、疑问和重读。

规则：

- AI 是唯一 writer；
- 第一人称、只追加、可以被后来修正；
- 不需要用户逐条审批；
- 不自动转化成用户画像；
- 不写成永久人格宣言；
- 普通对话不注入 Self-note 原文。

Closeout / Reflect 可以低频回读近期 Self-note，形成自我修正闭环。更新 Self Portrait 时必须引用 Episode 等外部事件证据，不能让 Self-note 自证 Self-note。

Self-note 可以记录“想起但没有说”的选择，但这类记录只供未来 Reflect 使用。

### 2.4 Boundary / Task

边界、承诺和任务可以作为 Episode 类型、候选字段或 Re-entry 钩子表达，但不能在多个文件里复制同一句真相。

## 3. 阅读视图，不是第二套真相

### Timeline / Long View

低频整理事件的发展过程，方便人和 AI 回看。

- 不进入普通对话热路径；
- 不与 Episode 两边各写一份真相；
- 不需要每天重建；
- 原始事件和修正关系始终可追溯。

### Rereadings

保存对旧 Episode 的新理解：

- 必须引用原 Episode；
- 追加新理解，不覆盖原事件；
- 默认不进入普通对话；
- 可以在 Reflect 后间接影响 Re-entry 的姿态与措辞。

### Portrait

若继续保留，只能是有证据的当前理解视图：

- 写“反复在意什么”，少写“她是什么人”；
- 画像性 claim 不由 Review AI 替用户确认；
- 需要确认时，在自然对话中求证，用户回答成为证据；
- 被纠正时保留修复史，不静默覆盖。

## 4. 后台过程

### Closeout

每天最多一次，允许无产出。

只提出候选：

- 0–2 条 Episode；
- 0–1 条 Self-note；
- Re-entry 更新建议或 AI 原稿。

### Auto Review

与 Closeout 分开运行，默认由独立 AI 完成。用户不承担日常审核工作。

负责：

- 接受、拒绝、延后或合并；
- 核对来源、重复、冲突和修正关系；
- 检查格式、长度与安全；
- 判断是否需要在自然对话中向用户求证。

Auto Review 是海关，不是编辑：

- 不替主体 AI 决定什么有意义；
- 不按自己的品味重写 Re-entry 或 Self-note；
- 不替用户确认“她是什么样的人”；
- 不覆盖用户确认过的长期边界、重大关系定义或修复解释。

520 只提供查看、撤回和异常重审入口，不把用户变成审批员。

### Reflect / Consolidation

低频运行，有足够新证据时才做：

- 重新理解旧 Episode；
- 回读近期 Self-note，发现延续、矛盾或修正；
- 追加 Rereading；
- 更新 Timeline 或 Portrait 视图。

无变化是正常结果。

### Janitor

只负责断档补漏，不是正常的高频记忆作者。

- 扫描漏掉的会话；
- 只写 candidates / extracted；
- 没有断档时不调用模型；
- 不直接写正式 Episode、Timeline、Portrait、Self-note 或 Re-entry。

## 5. Desire 状态

Desire 属于 Cyberboss runtime，不属于关系正史。

- 只有一个 writer；
- `state_log.jsonl` 作为旧历史冻结；
- 520、Closeout、Janitor、关系记忆都禁止写 Desire；
- Current State 可以轻量进入上下文，但不能把数值变成人格规则。

## 6. 520 的位置

520 是可关闭的前端与调试台：

- 查看模块状态与 Context Trace；
- 管理 Prompt 版本；
- 查看后台任务和 Auto Review 决策；
- 切换 Re-entry authoring mode；
- 手动开启测试用的记忆来源滑块；
- 填写 `why_now` 反馈与评测样本；
- 查看、撤回或重审异常记录。

滑块默认关闭，并只控制测试注入/来源开放，不取消用户拉线后的工具式查询能力。

520 不能成为第二个记忆后端，也不能在页面代码中直接发明历史、写 Desire 或绕过唯一 writer 修改 canon。

## 7. 写入权与防重复

- 原始会话：系统自动写，唯一事实来源。
- candidates：Closeout / Janitor 等自动流程写。
- Episode canon：唯一 History writer 按 Auto Review 决策写。
- Re-entry：主体 AI 唯一执笔，Auto Review 只校验。
- Self-note：主体 AI 唯一 writer。
- Desire：唯一 Desire service 写。
- Timeline / Rereadings / Portrait：受控 Reflect writer 更新。
- 520：只调用后端服务，不直接改正式文件。

同一条信息只能有一个事实来源。其他文件若出现，只能作为引用、候选、视图或修正记录。

## 8. 当前实施边界

当前优先跑通硬上下文、Re-entry、后台候选与 Auto Review 边界、Desire 单 writer 和 520 收口。

暂不实现自动 Soft Retrieval、reranker、Memory Family 或 GraphRAG。旧 Episodes 先保证可读、来源不丢、运行不双写，再考虑统一 schema。

关于“记忆如何被体验和使用”的探索记录见 `MEMORY_LIVENESS_NOTES.md`，但该文件不覆盖本文规则。
