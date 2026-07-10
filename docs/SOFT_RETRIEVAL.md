# Soft Retrieval

> 状态：暂缓 / 未接运行链  
> 当前决定：今晚不实现，也不为了展示而做假的 preview。

## 为什么单独留这份

Soft Retrieval 是“这一轮是否需要旧事”的读取过程，不是 Re-entry，也不是一种新的记忆文件。

将它单独记录，是为了保留已经想清楚的方向和旧 Episodes 的现状，避免以后重新调研；它不属于当前实施主线。

## 当前已有基础

- 本地已有正式 `episodes.jsonl`；
- 已有 relationship timeline、AI self notes 等叙事材料；
- Janitor 已能从新增会话写 `episodes.candidates.jsonl`；
- 旧 Episodes 的叙述方式和情感痕迹整体值得保留；
- 当前主要缺口是审核、去重、合并、来源与修正关系，不是“没有记忆数据”。

暂时不要：

- 重写旧 Episodes；
- 为了新 schema 丢掉原文感；
- 把 Timeline 或 Portrait 当作并行检索真相；
- 在旧数据未经整理前直接做全量 embedding。

## 未来读取链

```text
当前消息
→ 初始候选检索
→ 可选的 Memory Family / Graph 扩展
→ Reading Policy
→ 最多 0–3 条 Memory Notes
→ 独立 memory block 注入
```

普通闲聊允许 0 条。当前对话已经足够时，不应为了证明“有记忆”而召回。

## 初始候选检索

未来可组合：

- 关键词 / BM25；
- embedding 相似度；
- 时间邻近；
- Episode ID、人物、地点和暗语；
- 当前 Living State；
- Family membership 与显式关系边。

人机关系闲聊经常是“欸最近怎么样”这类模糊表达，BM25 的作用有限，因此不应简单固定 50/50 融合。

已有值得保留的实验思路：

```text
dynamic alpha
= vector confidence 的函数
= confAbs × confMargin 等置信度信号
```

含义：向量结果非常明确时提高向量权重；向量结果模糊时再让关键词、时间和结构信息补位。

公式尚未定稿，未来必须用真实关系闲聊 query 做离线评估，不直接凭直觉上线。

## 是否需要 LLM reranker

当前不决定。

只有满足以下条件才考虑加入：

- 候选池已经稳定；
- 现有融合排序经常把“语义相似但此刻不该读”的记忆排在前面；
- Reading Policy 无法只靠规则和轻量模型解决；
- 有可复现评测集，能证明 reranker 提升的是回应适配，而不是只提升关键词命中；
- 延迟、费用和错误模式可接受。

更可能的顺序：

```text
先做好数据与来源
→ 轻量混合检索
→ Reading Policy
→ 观察失败案例
→ 再决定是否加 LLM reranker
```

不要因为架构图看起来更“完整”就多加一层模型。

## Memory Family / Graph

保留的核心思路：

- 记忆不是孤立条目；
- 相似事件可以自然形成家族；
- 一条复合事件可以拆成多个事实单元；
- 一个事实可以属于多个家族；
- 家族达到一定规模后生成可更新摘要；
- 边可以表达同主题、因果、修复、暗语、冲突和重新理解；
- 家族摘要是阅读辅助，不覆盖原始 Episode。

未来可能使用：

```text
关键词 + embedding + 时间 + family + typed edges
→ RRF 或动态融合
→ Reading Policy
```

禁止：

- 一次召回就自动强化；
- 强情绪事件永久霸榜；
- 相似度超过单一阈值就自动改写正史；
- Family summary 变成新的唯一事实源；
- 图扩展结果绕过 Reading Policy 直接注入。

## Reading Policy

最终放行前至少判断：

- 这条记忆会不会改变下一句话的姿态；
- 当前消息是否已经足够；
- 它是事实、旧理解、Self-note 还是已被修正的版本；
- 是否有可靠来源；
- 此刻应该沉默影响、轻触、明确引用，还是等待用户拉线；
- 是否会让 AI 变成背台词、翻旧账或过度亲密。

每条放行内容至少带：

```text
memory_id
source_refs
reliability
why_now
superseded_by
family / relation hints
```

## 开始实现前的门槛

Soft Retrieval 只有在以下条件满足后再开工：

1. 硬上下文与 Re-entry 已稳定；
2. Episode / candidate / Review 的数据边界清楚；
3. 旧 Episodes 保留来源并能表示修正关系；
4. Context Trace 已能记录注入和跳过原因；
5. 有一组真实模糊闲聊 query 与预期结果；
6. 520 能显示检索结果，但不控制检索后端；
7. 用户确认开始这一阶段。

## 当前下一步

无。

先完成 `IMPLEMENTATION_STATUS.md` 中的硬上下文、后台循环、Desire 和 520 收口。以后重新启动本模块时，再在本文末尾记录实验数据和明确决策。
