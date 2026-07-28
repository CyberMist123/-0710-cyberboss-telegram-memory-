# 记忆语义修复计划

```text
Status: superseded
Authority: none
Scope: 已废弃的记忆语义修复执行计划
Last reviewed: 2026-07-28
Current authority: docs/CURRENT_STATUS.md; docs/architecture/MEMORY.md
```

> This document may change independently. It is supporting material, not current project truth or an approved decision.
>
> 本文可以独立更新，只提供参考或证据；它不是当前状态，也不是已经批准的决定。
>
> 若重启此方向须开新计划文档。


> 状态：执行计划，不是新的架构真相。  
> 权威结构仍以 `architecture/MEMORY.md` 为准；本计划完成后，应把最终规则吸收回权威文档，并将本文件标记为完成。  
> 适用分支：`impl/codex-cheap-prework-20260711-170034`  
> 建立日期：2026-07-12

## 1. 为什么要修

当前机械链已经离线跑通：

```text
Candidate
→ checkpoint Review
→ Decision 逐条落盘
→ History Writer
→ Canon
```

但实现把下面三种不同性质的东西压成了同一种 Candidate：

1. 主体 AI 在对话结束时留下的语义原稿；
2. 同人格后台 Closeout 根据材料写出的草稿；
3. Janitor 为补技术断档而提取的材料。

这会让“技术补漏”和“谁有权解释这段关系记忆”混在一起。原设计只写了 `candidates / extracted`，没有在 schema 和发布权限上把二者分开。

本轮只修这处语义和权限缺口，不重做整个记忆系统，不开启 Soft Retrieval，不迁移旧数据。

## 2. 不可破坏的原设计

### 2.1 北极星

> 记忆成功 = 主要改变下一句话的姿态；记忆失败 = 替 AI 决定下一句话的内容。

记忆是背景，不是台词。当前对话始终优先。

### 2.2 删除测试

把记忆从输入中拿掉：

- 主要改变内容、信息或话题：台词化，失败；
- 主要改变分寸、节奏、确定度、沉默或温度：姿态，成功。

删除测试属于体验抽查，不授权 Auto Review 判断“什么有意义”。

### 2.3 唯一 writer

- 原始会话：系统；
- 漏档记录 / evidence：机械补漏流程；
- semantic candidates：有语义执笔资格的 AI；
- decisions：Auto Review；
- Episode canon：History Writer；
- Re-entry / Self-note 正文：主体 AI；
- Desire：Desire service。

同一事实只能有一个正式来源；其他位置只能是证据、候选、引用、视图或修正。

### 2.4 Review 是海关，不是编辑

Review 只做：

- 来源可定位；
- 格式与长度；
- 安全；
- 去重、合并、修正关系；
- 已确认边界冲突；
- 发布权限检查。

Review 不做：

- 判断一段关系经历是否“值得记”；
- 改写主体 AI 的措辞；
- 替主体 AI 解释自己的感受；
- 替用户确认画像；
- 把 extractor 输出提升成主体记忆。

## 3. 新的分层对象

### 3.1 Gap Record

技术覆盖记录。回答：哪段原始会话没有被正常 Closeout 处理？

建议字段：

```json
{
  "gap_id": "gap-...",
  "detected_at": "...",
  "source_ref": {"file": "...", "window": "..."},
  "reason": "missing_closeout|interrupted|legacy_uncovered",
  "status": "pending|covered|ignored",
  "idempotency_key": "..."
}
```

规则：

- 可完全由确定性程序生成；
- 不表达关系意义；
- 不进入 Review → Canon 发布链；
- 不需要小模型才能发现。

### 3.2 Evidence Packet

给后续语义作者使用的干净材料。回答：这段漏档中实际说了什么？

建议字段：

```json
{
  "evidence_id": "evidence-...",
  "gap_id": "gap-...",
  "source_ref": {"file": "...", "window": "..."},
  "excerpt": "...",
  "origin": "janitor",
  "author_role": "extractor",
  "semantic_authority": "none",
  "idempotency_key": "..."
}
```

规则：

- 小模型可以协助切块、去噪、提取原话和时间索引；
- 不得写成“我学到了”“她就是怎样的人”；
- 不得直接发布 Episode、Re-entry 或 Self-note；
- 必须保留可定位的原始来源。

### 3.3 Semantic Candidate

有语义执笔者提出的记忆草稿。回答：主体 AI 或其明确标记的后台代理如何理解这段材料？

兼容现有 Candidate 主体字段，并新增：

```json
{
  "candidate_id": "cand-...",
  "type": "episode|self_note|reentry_draft",
  "body": "...",
  "origin": "live_closeout|nightly_closeout|manual",
  "author_role": "subject_ai|background_proxy",
  "author_model": "...",
  "context_scope": "active_session|daily_materials|isolated_chunk",
  "semantic_authority": "high|medium",
  "needs_subject_review": false,
  "source_ref": {"file": "...", "window": "..."},
  "idempotency_key": "..."
}
```

规则：

- `subject_ai` 可以提出 Episode、Self-note、Re-entry 草稿；
- `background_proxy` 可以提出 Episode 候选；
- `background_proxy` 的 Self-note / Re-entry 不得自动冒充主体最终原稿；
- extractor 永远不能生成可直接发布的 Semantic Candidate；
- 旧 Candidate 暂时兼容，不做全量迁移。

### 3.4 Decision 与 Canon

Decision 继续只引用 Candidate，不携带改写正文。

History Writer 只执行：

- `accepted` 且具备对应类型发布权限；
- `merged` 的幂等状态记录；
- 已落盘、可定位、未应用过的 Decision。

## 4. 目标数据流

### 4.1 正常对话收尾

```text
原始会话
→ 主体 AI / 同人格 Closeout 阅读干净材料
→ Semantic Candidate
→ Review
→ Decision
→ History Writer
→ Canon
```

### 4.2 技术断档补漏

```text
覆盖账本发现漏档
→ Gap Record
→ Evidence Packet
→ 等待主体 AI 或明确标记的后台代理处理
→ Semantic Candidate
→ Review
→ Canon
```

Janitor 到 Evidence Packet 为止，不跨越语义执笔边界。

### 4.3 Nightly

Nightly 是调度与整理器：

- 检查覆盖；
- 聚合相邻碎片；
- 标记重复、冲突、更新关系；
- 排队等待语义处理；
- 可以启动同人格后台 Closeout，但必须标记 `background_proxy`。

Nightly 不是默认自动发布者。

## 5. 分步实施

### S0 — 已通过机械基线

现有能力保持冻结：

- Review 每条 Decision 立即落盘；
- 中断后续跑；
- Candidate → Decision → Canon 虚构链通过；
- accepted / merged / deferred 行为通过；
- 重跑字节不变；
- 时间显示为 `YYYY-MM-DD HH:mm`。

回滚基线：以项目更新日志中最新已验证 SHA 为准。

### S1 — 本计划与语义合同

只新增本文件，不改运行行为。

验收：

- 与 `architecture/MEMORY.md` 不冲突；
- 找到并吸收 Fable 的 F2 工程门、F4 体验门与三层长期评估；
- 不增加第五份架构真相。

### S2 — Janitor Evidence 化

改动：

- Janitor 只生成 Gap Record / Evidence Packet；
- 不再创建可直接发布的 Episode Candidate；
- 无断档时不调用模型；
- 旧 Janitor Candidate 兼容读取，但冻结发布。

验收：

- 临时目录测试；
- 不调用真实模型；
- 不读取真实 119 条 Candidate；
- Janitor 不写 decisions、episodes、Re-entry、Self-note；
- 同一漏档重跑不重复。

### S3 — Candidate 来源与权限

改动：

- schema 增加 origin / author_role / context_scope / semantic_authority；
- 建立旧 Candidate 兼容映射；
- extractor 不能进入发布链。

验收：

- subject_ai Episode 可发布；
- background_proxy Episode 可进入 Review；
- extractor 被机械权限门 deferred；
- background_proxy Self-note / Re-entry 默认 deferred；
- Decision 不含改写正文。

### S4 — Review 权限门

改动：

- 权限检查进入本地确定性 checks；
- 权限不足先 deferred，不调用语义模型；
- Review 继续不做重要性判断。

验收：

- 权限矩阵全部 fixture 化；
- Review 不改 body；
- accepted canon body hash 与 Candidate body 相同；
- 旧行为不回归。

### S5 — Nightly 模式门

加入：

```text
manual | shadow | auto
```

默认 `manual`：

- 可以做覆盖扫描和 Evidence Packet；
- 不自动 Review；
- 不运行 History Writer；
- 不自动发布 Canon。

`shadow` 只生成候选和拟决策证据，不发布。`auto` 必须显式开启，并等待语义与体验验收。

### S6 — 520 展示

页面区分：

- 漏档；
- 证据材料；
- 主体候选；
- 后台代理候选；
- 待审 / deferred / accepted / merged；
- 已发布。

520 不直接修改正式记忆，不绕过 Review。

### S7 — 收口

- 虚构数据完整回放；
- 更新 `architecture/MEMORY.md`；
- 更新 `CURRENT_STATUS.md` 和 `PROJECT_CHANGELOG.md`；
- 本计划标记完成；
- 再决定是否部署。

## 6. Fable 原有验收门

### 6.1 F2 工程门

必须保持：

1. 同日重跑全链，产物字节相同；
2. 注入块、工具结果、旧 Episode 回声不会生成新候选；
3. accepted canon 正文与 Candidate 正文 hash 相同；
4. 第二 writer 被 lease 拒绝；
5. 旧 memory 与 Desire 冻结文件无意外变化；
6. `no_output` 是成功；
7. 命令式措辞只 warning，边界冲突按合同处理；
8. correction 不覆盖或删除原 Episode。

### 6.2 F4 体验门

最终只允许：

- `EXPERIENCE-GO`
- `EXPERIENCE-REVISE`
- `EXPERIENCE-ROLLBACK`

GO 要求：

- 删除测试主要只改变“怎么说”；
- Re-entry 是交接，不是用户画像或设定加载；
- 首轮不过满、无命令感；
- “我记得”有当前来源；
- lookup 诚实说是翻记录；
- 查无此事时照实说没找到；
- 当前对话始终优先；
- Trace 可以解释每一块上下文。

### 6.3 三层长期评估

1. 即时惊喜只打折参考，负例更可信；
2. 反事实检查：不介入是否同样好；
3. 长窗才是真正指标：用户是否更少重复解释、是否自然默认共同历史、纠错是否减少。

禁止按单轮奖励优化记忆行为；那会把系统推向表演式召回。

## 7. 本轮硬边界

- 不处理真实 119 条 Candidate；
- 不调用真实 Fable / DeepSeek / Claude API；
- 不部署 Runtime；
- 不重启 Telegram；
- 不迁移旧记忆；
- 不实现 Soft Retrieval、embedding、reranker、GraphRAG；
- 不把设计笔记中的主动 recall 候选顺手上线；
- 每一步一个可回滚 commit，测试通过后再进入下一步。
