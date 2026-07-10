# 给 Codex：今晚连续性循环工程审计

> 只读审计。不要改代码，不要创建 commit，不要迁移真实数据，不要部署。

## 模型建议

- Model：GPT-5.6 Sol
- Reasoning：xhigh

本任务不是写功能，而是判断今晚框架是否能安全落地，并给出最小实现顺序。

## 必读顺序

1. `TONIGHT_LOOP_FRAMEWORK.md`
2. `docs/references/USER_PROVIDED_STRUCTURED_REPORT.md`，重点读最后的 Anchor v1.13、Reading Policy、记忆家族 / GraphRAG 段落
3. `MEMORY_520_MAP.md`
4. `PROJECT_OVERVIEW.md`
5. `docs/custom/CURRENT_PROJECT_AUDIT_20260710.md`
6. `docs/custom/CORE_PATCH_REVIEW_20260710.md`
7. `docs/architecture/LIVING_RELATIONSHIP_MEMORY_RFC.md`

需要对照的分支：

```text
main
legacy-current
upstream-baseline
design/living-memory-rfc
```

## 用户今晚的目标

先跑通以下循环，而不是完整重构全部 memory：

```text
Telegram 消息
→ Context Builder 按模块配置装配本轮上下文
→ Cyberboss / 模型回复
→ 保存原始对话与 Context Trace
→ 每小时 Desire Tick（幂等）
→ 每日最多一次 Closeout（允许 0 产出）
→ 独立 Review
→ 低频 Timeline / Memory Family Consolidation
→ 520 作为可关闭的调试前端
```

网页需要能按 `1-* / 2-* / 3-* / 4-*` 分模块设置：

```text
off
preview
on
```

并允许编辑对应 Prompt、查看 diff、保存版本、下一轮生效和回退。

## 安全边界

1. 不修改任何运行代码。
2. 不创建 commit / PR。
3. 不读取或迁移真实私人 memory、conversation、token、session、日志。
4. 不建议一次重写 `dashboard.py`。
5. 不把 Anchor、Ombre、GraphRAG 整套搬入。
6. 不假设文件存在就代表功能已跑通。
7. 不改变 Telegram 上游收发、流式、offset、proxy 或 dedupe 行为。
8. 所有结论必须区分：今晚必要、后续必要、可延后、应删除。

## 必须检查的工程问题

### A. Context Builder 放在哪里

请判断 Context Builder 最适合位于：

```text
Cyberboss core
独立 extension service
runtime adapter / gateway
```

要求：

- 尽量不侵入 `src/core/app.js`；
- 能在每轮调用前装配上下文；
- 能区分普通轮、重入第一轮、compact 后第一轮；
- 能输出 Context Trace；
- 520 关闭后仍工作；
- Prompt 修改后可安全热加载。

### B. 模块注册与 Prompt Registry

审查 `1-* / 2-* / 3-* / 4-*` 是否职责清楚。

请给出：

- 哪些模块是纯 prompt；
- 哪些模块是代码逻辑；
- 哪些模块有读写状态；
- 哪些模块允许 `off / preview / on`；
- 哪些模块不能随意热切换；
- Prompt Registry 最小目录和接口；
- 热更新怎样避免读到半写文件；
- 版本回退怎样实现；
- 配置和 Prompt 是否需要 schema_version。

### C. 上下文装配顺序

请明确每轮装配顺序以及每块插入位置：

```text
1-1 Core Persona
1-2 Memory Contract
1-3 Identity Anchor
2-1 Wake Packet
2-2 Just Now Tail
2-3 Threads / Boundaries
3-1 Retrieval Candidates
3-2 Reading Policy
3-3 Memory Family / Graph Expansion
3-4 Memory Note Injection
Current Posture
Recent native conversation
User message
```

请指出：

- 哪些是 system；
- 哪些是独立 hidden continuity block；
- 哪些是 tool / retrieval result；
- 哪些只在第一轮；
- 哪些每轮；
- 哪些默认关闭；
- 如何避免 Wake、Just Now Tail 与原生历史重复。

### D. Context Trace

请设计最小 Context Trace schema，必须能回答：

- 本轮实际加载了哪些模块；
- 每块来源、版本、hash、字符数 / token 估算；
- 为什么加载 / 为什么跳过；
- 检索候选多少，Reading Policy 放行多少；
- 最终注入 ID；
- 是否是重入轮；
- 是否发生 compact；
- 模型调用与回复是否成功。

Context Trace 不得默认保存完整私人正文；请提出脱敏 / 可展开查看策略。

### E. Desire 每小时幂等

请审查：

```text
desire:<timezone-hour>
```

作为唯一 slot key 是否足够。

必须说明：

- 谁是唯一 writer；
- 当前状态和历史怎样分开；
- 同一小时重复触发怎样返回已有结果；
- 任务运行中第二次触发怎样处理；
- 失败怎样 retry；
- 电脑离线怎样记录 `missed_offline`；
- 时区切换 / 夏令时 / 系统时间回拨怎样处理；
- 旧 `state_log.jsonl` 怎样冻结；
- 如何保证不会同时从 app.js、520、closeout、watchdog 多路写入。

### F. Closeout 与 Review 幂等

请判断：

```text
closeout:<local-date>
review:<date>:<candidate-set-hash>
```

是否足够。

必须说明：

- Closeout 什么时候触发；
- 什么叫“当天新增对话”；
- 当天多个 session 怎样合并；
- Closeout 允许 0 产出怎样记录；
- 第二次运行怎样返回已有结果；
- 提取和审核怎样确保不是同一次调用；
- Candidate 如何避免重复；
- Review 接受 / 拒绝 / 延后 / 合并 / 修正如何留审计记录；
- Wake 更新建议何时真正发布。

### G. 孤儿文件、双写和不可重建状态

请检查现有设计是否仍可能产生：

- 未注册文件；
- 注册但不存在；
- 一个目标多个 writer；
- 临时文件未清理；
- Prompt 历史与当前版本断链；
- jobs.sqlite 指向不存在的输出；
- timeline 与 episode 不一致；
- candidate 已接受但状态未更新；
- context trace 指向已被覆盖的 Prompt；
- 520 与核心 service 数据不同步。

请给出最小 registry / manifest schema 和 orphan scan 算法。

### H. 520 解耦

520 必须只是前端。

请明确拆成哪些后端接口：

```text
module config
prompt registry
context preview / trace
job ledger
desire status
closeout / review
health / orphan scan
```

要求：

- 520 停止不影响任何核心任务；
- 520 不直接写核心文件；
- 所有写操作走 service；
- 旧 dashboard 哪些函数可复用；
- 哪些旧写端点必须冻结；
- 是否需要先做新的最小控制台，而不是直接改旧 520。

### I. 复用现有代码

请实际查看 `main` 和 `legacy-current`，列出：

- 可直接复用；
- 可小改复用；
- 只适合参考；
- 不应带回。

重点包括：

```text
memory-kit/dashboard.py
memory-kit/janitor.py
memory-kit/extract_memory.py
sync_memory_block.py
memory_toggle.py
launcher / watchdog
src/core/app.js
runtime adapters
现有 desire-state / desire-history 代码
```

### J. 今晚范围是否现实

请把任务分成：

```text
今晚必须完成
今晚可以做 preview
今晚绝对不要做
下一阶段再做
```

不要为了“完整”把 GraphRAG、Timeline 重建、全部旧数据迁移、知识库、主动消息等塞进今晚。

## 必须输出的格式

请严格按下面结构回复，不写代码：

```text
1. 总结判定：GO / GO WITH CUTS / NO-GO
2. 当前框架最危险的 10 个工程风险（按严重度）
3. Context Builder 推荐位置、调用链和最小接口
4. 1-* / 2-* / 3-* / 4-* 模块职责修订表
5. 每轮上下文装配顺序和生命周期表
6. Prompt Registry 最小设计
7. Context Trace 最小 schema
8. Desire 幂等方案
9. Closeout / Review 幂等方案
10. Writer / Reader 权限矩阵
11. Registry / Manifest 与 orphan scan 方案
12. 520 解耦方案：复用什么、冻结什么、新建什么
13. 现有代码复用清单：REUSE / ADAPT / REFERENCE / DROP
14. 今晚最小实现步骤，每一步包含 smoke test 和 rollback
15. 今晚 Definition of Done 的修订版
16. 实现前必须由用户确认的最多 5 个问题
17. 对 TONIGHT_LOOP_FRAMEWORK.md 的逐节 KEEP / CHANGE / REMOVE
```

## 输出风格

- 用中文；
- 说人话，但要具体；
- 不要只说“需要平衡”；
- 不要直接给完整新架构替代用户框架；
- 所有建议都要说明为什么；
- 优先收敛和今晚可验证；
- 不改代码。
