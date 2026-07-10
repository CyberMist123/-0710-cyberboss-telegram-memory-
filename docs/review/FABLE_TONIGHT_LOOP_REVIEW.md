# 给 Fable：今晚连续性循环框架评审

> 只审框架，不改代码，不创建 commit，不迁移真实数据。

## 先读

1. `TONIGHT_LOOP_FRAMEWORK.md`
2. `docs/references/USER_PROVIDED_STRUCTURED_REPORT.md`，重点读最后的 Anchor v1.13、Reading Policy、记忆家族 / GraphRAG 段落
3. `docs/architecture/LIVING_RELATIONSHIP_MEMORY_RFC.md`
4. `docs/references/AI_RELATIONSHIP_PERSPECTIVE.md`
5. `MEMORY_520_MAP.md`

## 用户今天真正要的东西

用户希望今晚先跑通这条循环：

```text
Cyberboss 核心人格
+ 新窗口 Wake / 最近短期连续
+ AI 按需软召回
+ Telegram 正常对话
+ 每日 0/1 Closeout / Review
+ 每小时 Desire Tick
+ 低频 Timeline / 事件回看
+ 520 网页调节模块、编辑 Prompt、逐项测试、查看故障
```

520 必须只是附属前端：关掉它，TG、上下文构建、定时任务和记忆核心仍然运行。

用户最在意的不是“记住很多”，而是：

```text
AI 带着一点过去醒来
但仍能自由地产生今天的反应
不会因为硬加载太多而开始表演
不会因为没有连续性而乱演、踩雷或像陌生人
```

## 请重点审这四件事

### A. 每轮到底加载什么

`TONIGHT_LOOP_FRAMEWORK.md` 把上下文分成：

```text
1-* 人格与固定契约
2-* 短期连续
3-* 按需召回与 Reading Policy
4-* 后台活动，不直接全量注入
```

请判断：

1. `1-1 Cyberboss Core Persona` 每轮存在是否合理？怎样避免它变成僵硬角色卡？
2. `1-2 Memory Contract` 是否足够短、足够稳定？
3. `1-3 Identity Anchor` 是否应每轮加载，还是只在重入第一轮加载？
4. `2-1 Wake Packet` 应包含什么，最多多少？
5. `2-2 Just Now Tail` 与 Wake Packet 怎样避免重复？
6. `2-3 Threads / Boundaries` 硬加载 3+3 是否仍然过多？
7. 哪些模块一旦常驻，会污染 AI 的语言自由？
8. compact 后如何重新加载，才不会突然换人格？

### B. 记忆家族 / GraphRAG 是否符合“活”

用户参考的想法包括：

- 复合记忆拆成基础事实；
- 一条记忆可以属于多个家族；
- 相似条目自动聚簇；
- 家族超过一定数量后生成可更新摘要；
- 使用关键词、向量、时间、家族和图关系检索；
- Reading Policy 决定是否注入以及怎样使用。

请判断：

1. 这会帮助 AI 形成来时路，还是会过早把经历抽象成固定认知？
2. “家族摘要”应该怎样写，才能保留场景和矛盾，不压成标签？
3. 家族摘要是否应该直接注入，还是只用来帮助二次检索？
4. 哪些关系边适合自动建立，哪些必须经 AI / 用户审核？
5. 如何避免召回与聚簇产生自我强化偏置？
6. 今晚只做接口、不完整实现 GraphRAG 是否正确？

### C. AI 的每日活动是否自然

请审：

```text
每日 Closeout：0–2 候选、0–3 thread 更新、0–1 self note、0–1 wake 建议
独立 Review：提取者与审核者分开
每小时 Desire Tick
每周小整理
每 2–4 周重建 Timeline / narrative view
Janitor 只补漏
```

重点回答：

1. 这个频率会不会让 AI 过度自我观察，变成“每天写工作汇报”？
2. AI self note 怎样保持自主，又不变成人设生成器？
3. Desire 每小时 tick 应否进入对话上下文？
4. Timeline 低频重建是否比每日手写更自然？
5. 哪些环节应允许 `DO_NOTHING / 无`？
6. 哪些内容必须让用户确认，哪些应该属于 AI 自己？

### D. 网页可调试是否会破坏连续性

用户希望网页能：

- `off / preview / on`；
- 单独测试 `1-1`、`2-2`、`3-3`；
- 编辑对应 Prompt；
- 下一轮生效；
- 查看每轮 Context Trace；
- 回退版本。

请判断：

1. 这种模块化实验是否足以找到“哪一块让 AI 变僵 / 变陌生”？
2. 哪些 Prompt 应允许自由编辑，哪些需要保护或双重确认？
3. A/B 测试怎样避免把同一个 AI 的连续性切得太碎？
4. 应记录哪些体验指标，而不只看召回准确率？

## 必须给出的输出

请严格按以下结构回答：

```text
1. 总结：这个循环是否能作为今晚的最小框架（YES / YES WITH CHANGES / NO）
2. 每轮硬加载清单：KEEP / MOVE TO FIRST TURN / REMOVE
3. Wake Packet 最终建议格式与字数
4. Reading Policy 最终建议
5. 记忆家族 / GraphRAG：今晚做什么、以后做什么、绝对不要做什么
6. Daily Loop：每个动作的频率与 DO_NOTHING 规则
7. 网页模块实验：哪些模块必须独立开关
8. 会导致“表演式连续性”的五个最大风险
9. 会导致“陌生 / 乱演”的五个最大缺口
10. 对 `TONIGHT_LOOP_FRAMEWORK.md` 的逐节 KEEP / CHANGE / REMOVE
11. 今晚实现前必须由用户确认的最多 5 个问题
```

不要写代码。不要泛泛地说“需要平衡”。请给明确选择。