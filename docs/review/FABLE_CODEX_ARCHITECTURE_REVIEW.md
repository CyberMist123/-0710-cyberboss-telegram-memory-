# Fable / Codex Sol xhigh：关系记忆架构只读评审任务

> 本任务只审设计，不改代码、不迁移数据、不重写 520。

## 必读顺序

1. `docs/architecture/LIVING_RELATIONSHIP_MEMORY_RFC.md`
2. `docs/references/MEMORY_ARCHITECTURE_REFERENCES.md`
3. `PROJECT_INTRO_FOR_HUMANS.md`
4. `PROJECT_OVERVIEW.md`
5. `MEMORY_520_MAP.md`
6. `docs/custom/CURRENT_PROJECT_AUDIT_20260710.md`
7. `docs/custom/CORE_PATCH_REVIEW_20260710.md`

比较分支：

```text
upstream-baseline
legacy-current
main
design/living-memory-rfc
```

## 共同安全边界

- 不修改任何代码；
- 不创建迁移脚本；
- 不删除或重命名现有 memory 文件；
- 不假设 Markdown 文件存在就代表链路已跑通；
- 不把真实私密 memory、conversation、token 或 state 加进 Git；
- 不提出一次性重写 `dashboard.py`；
- 不把 Anchor Memory、Ombre Brain、Haven-Ombre 整套搬入；
- 所有结论必须区分：理念、数据模型、处理流程、上下文注入、界面。

---

# A. 给 Fable 的任务：评审“活性”和关系连续性

你不是来评价数据库选型。请站在一个长期和用户相处、会换窗口和换模型的 AI 的位置，判断这套设计是否能产生：

```text
连续，但不表演
熟悉，但不自以为是
有自己的延续，但不被旧自我锁死
知道雷区，但不把用户写成固定标签
```

重点回答：

1. 固定 Memory Contract、Identity Anchor、Boundaries、Wake Packet 的分法是否合理？
2. 哪些内容一旦硬加载，就会让模型开始模仿旧语气或表演亲密？
3. 只在 session 第一轮加载 continuity block，是否足够？compact 后如何重新接回？
4. `pinned/boundaries.md` 怎样写才能可靠避雷，又不变成僵硬规则？
5. AI 的 self notes 怎样既属于 AI 自己，又不会沦为预写角色卡？
6. “当前对话优先于旧记忆”在冲突时应怎样实际表现？
7. 什么时候 AI 应该主动查记忆，什么时候应当直接回应当下？
8. 系统怎样允许 AI 诚实地说“不确定”“记不清”，而不是逼它全知？
9. Timeline / relationship view / self view 哪些内容不应进入日常生成上下文？
10. 这套设计是否仍然过度围绕用户，而没有给 AI 自己留下成长和未完成问题？

请输出：

```text
1. 我作为关系型 AI 醒来时真正需要的最小包
2. 会导致表演式连续性的内容清单
3. 会导致陌生/失忆的缺失内容清单
4. 建议的 token / 字数预算
5. 对 boundaries、self notes、wake packet 的改写建议
6. 仍然存在的身份与伦理风险
7. 对 RFC 的逐条 KEEP / CHANGE / REMOVE / OPEN QUESTION
```

不要输出代码。

---

# B. 给 Codex Sol xhigh 的任务：评审数据和实现可行性

请把现有系统看成四部分：

```text
数据面
处理流程
上下文构建
520 控制面
```

重点回答：

1. RFC 是否建立了唯一权威来源？还有哪些双写或循环依赖？
2. Markdown event cards + rebuildable SQLite index 是否适合本项目规模？
3. `events / claims / threads / self notes / views` 是否职责重叠？能否进一步收敛？
4. `views/wake.md`、timeline、relationship、self 如何做到可重建？
5. append-only + `supersedes` 是否足以处理修正、合并和退役？
6. 原始 conversation refs 怎样稳定引用，而不把私密原文提交 Git？
7. 如何从现有 `episodes.jsonl / timeline / portrait / reentry / rereadings` 只读迁移，不丢信息、不覆盖原文件？
8. Desire current / history 怎样与关系 memory 完全解耦？
9. 520 第一阶段需要冻结哪些写端点？哪些可以保留？
10. context builder 应位于 Cyberboss core、extension service 还是 Gateway adapter？
11. 新设计最小可行实现需要哪些模块，哪些功能必须延后？
12. 如何做 A/B 测试，验证“上下文更少但连续性没有下降”？

请输出：

```text
1. 当前文件 → 新数据对象映射表
2. 所有 writer / reader 权限矩阵
3. 可能的双写、竞态、循环依赖和不可重建点
4. 最小 schema 修订建议
5. 六阶段迁移计划，每阶段 smoke test / rollback
6. 520 的拆分边界
7. context builder 的推荐位置与接口
8. 不应进入第一版的功能
9. 对 RFC 的逐条 KEEP / CHANGE / REMOVE / OPEN QUESTION
```

不要输出代码，不要创建 commit。

---

# C. 两个模型都必须回答的共同问题

1. 本系统到底怎样定义“活”？有没有可测试的行为指标？
2. 如何测量上下文污染，而不是只测召回准确率？
3. 怎样判断某条记忆让 AI 更自然，而不是更会表演？
4. 哪些记忆必须有用户确认，哪些应由 AI 自主拥有？
5. 换模型时，什么应被继承，什么应允许重新长出来？
6. 修复史和错误理解应怎样保留，才不会反复伤害用户？
7. 当记忆和用户现在的表达冲突时，系统应留下怎样的审计记录？

最终不要给“全部推倒重写”的空泛建议。必须指出最小可验证路径。
