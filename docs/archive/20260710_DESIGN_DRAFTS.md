# 2026-07-10 Design Drafts Archive

```text
Status: historical
Date: 2026-07-10
Current authority: docs/CURRENT_STATUS.md
```

> 本文提到的 `CONTINUITY_ARCHITECTURE.md` 与 `IMPLEMENTATION_STATUS.md` 已分别迁至 `docs/architecture/MEMORY.md` 与 `docs/archive/IMPLEMENTATION_LOG.md`；当前权威见 `docs/CURRENT_STATUS.md`。**正文保留原始措辞，不追改历史。**



> 本页是归档索引，不是当前规范。  
> 冻结来源 commit：`5c72b69089f70d33f6e0b5d0f3f60f4924bb8ec8`

## 为什么归档

此前短时间内生成了多份项目介绍、状态盘点、RFC、模型任务和评审报告。里面有很多有价值的推理，但它们互相重复，且部分范围已经被用户最后的决定推翻。

为避免接手 AI 把旧判断当成当前实现，本分支只保留以下活文档：

- `README.md`
- `docs/CONTINUITY_ARCHITECTURE.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/520_CONSOLE.md`
- `docs/SOFT_RETRIEVAL.md`

旧文档不复制到多个 archive 文件中，避免“归档后仍有十几份 Markdown”。完整原文保留在 Git 历史和冻结 commit，可随时查看或恢复。

## 已归档：旧项目说明与状态文档

- `PROJECT_INTRO_FOR_HUMANS.md`
- `PROJECT_OVERVIEW.md`
- `MEMORY_520_MAP.md`

合并去向：

- 人话介绍与导航 → `README.md`
- 架构边界 → `CONTINUITY_ARCHITECTURE.md`
- 真实进度、bug 与验收 → `IMPLEMENTATION_STATUS.md`
- 520 页面职责 → `520_CONSOLE.md`

## 已归档：阶段性框架与决策稿

- `TONIGHT_LOOP_FRAMEWORK.md`
- `TONIGHT_LOOP_DECISIONS_AFTER_CODEX.md`
- `docs/architecture/LIVING_RELATIONSHIP_MEMORY_RFC.md`

归档原因：

- `TONIGHT_*` 名称很快失真；
- 混合了长期架构、今晚范围和模型审计结论；
- 仍把 Soft Retrieval preview 放进今晚范围，与用户最后决定不一致；
- 部分描述容易让接手 AI 误以为代码已经实现。

正确结论已合并进 `CONTINUITY_ARCHITECTURE.md` 与 `IMPLEMENTATION_STATUS.md`。

## 已归档：模型任务与评审报告

- `docs/review/CODEX_TONIGHT_LOOP_ENGINEERING_REVIEW.md`
- `docs/review/FABLE_CODEX_ARCHITECTURE_REVIEW.md`
- `docs/review/FABLE_TONIGHT_LOOP_REVIEW.md`
- `docs/custom/CURRENT_PROJECT_AUDIT_20260710.md`
- `docs/custom/CORE_PATCH_REVIEW_20260710.md`

归档原因：任务单和一次性审计报告不应长期与正式规范并列。确认过的源码事实已进入实时进度文档；未来模型应重新核对源码，而不是机械继承旧审计结论。

## 已归档：参考资料长文

- `docs/references/AI_RELATIONSHIP_PERSPECTIVE.md`
- `docs/references/MEMORY_ARCHITECTURE_REFERENCES.md`
- `docs/references/USER_PROVIDED_STRUCTURED_REPORT.md`

归档原因：这些是重要来源，但不应让接手 AI 在开始工作前先读数万字调研。当前项目采用的原则已合并进架构文档；Soft Retrieval、Memory Family 与 reranker 相关内容已收进 `SOFT_RETRIEVAL.md`。

需要追溯原作者、链接或完整案例时，再从冻结 commit 读取原文。

## 已归档：旧 520 双语设计稿

- `docs/ui/520_CONSOLE_BILINGUAL_SPEC.md`

合并去向：`docs/520_CONSOLE.md`。

新文档只保留当前真正需要实现和验证的页面职责，不再用大量双语示例制造“功能已经存在”的错觉。

## 恢复方式

所有原文仍在 commit：

```text
5c72b69089f70d33f6e0b5d0f3f60f4924bb8ec8
```

需要恢复单个文件时，从该 commit 取回即可。不要把整批旧稿重新复制回活跃目录。
