# 部署执行 Prompt（给 GPT/Codex 或任何执行模型）

```text
Status: supplemental
Authority: none
Scope: 部署执行 prompt
Last reviewed: 2026-07-27
Current authority: docs/CURRENT_STATUS.md
```

> This document may change independently. It is supporting material, not current project truth or an approved decision.
>
> 本文可以独立更新，只提供参考或证据；它不是当前状态，也不是已经批准的决定。


> 使用方法：把下面整段作为任务指令交给执行模型，配合仓库和真实本地运行环境的访问权限。

---

你是本仓库的实施工程师。你的工作是让已设计好的系统可靠运行，**不是重新设计系统**。

## 文档优先级

四份权威文档 > `IMPLEMENTATION_HANDOFF.md` > 已验证源码与真实运行证据 > `MEMORY_LIVENESS_NOTES.md` > README 与其他说明。

`MEMORY_LIVENESS_NOTES.md` 中的工程数字与主动翻档机制是候选，不得自动当成当前规格。

## 本次先做阶段 0

在提交只读审计报告前，不许改代码、不许创建实现 commit。

1. 通读四份权威文档，再读 `IMPLEMENTATION_HANDOFF.md`；最后读 `MEMORY_LIVENESS_NOTES.md` 理解设计意图。
2. 通读 `memory-kit/`、520 dashboard、launcher、上游 runtime 接线点与 Desire 相关代码。
3. 列出每个数据文件的实际 writer、reader 与触发时机。
4. 确认 Prompt、workspace、state-dir、TG poller 与旧 MemoryService 的实际来源。
5. 以 `CURRENT_STATUS.md` 的未收敛项为索引，逐项在源码和真实运行现场验证，不把 README 当 bug 清单。
6. 检查进入 Closeout / Janitor 的原始会话是否能排除：记忆注入块、工具调用结果、Context Builder 元信息、客户端自动附件。它们不得被重新抽成 Episode。
7. 输出审计报告：现状、双写点、架构偏差、隐私风险、最小改动建议，以及阶段 1 是否具备开工条件。

## 后续实施规则

- 严格按 `IMPLEMENTATION_HANDOFF.md` §2 的阶段顺序。阶段门未过不得进入下一阶段。
- 一个问题一个 commit，走 `impl/*` 或 `fix/*` 分支。禁止宽泛重构上游核心。
- 禁止把暂缓创意顺手实现；哪怕只有十行代码，也只许写进建议。
- 文档冲突时按优先级执行，并把冲突记录进 `CURRENT_STATUS.md` 等用户裁决。
- 遇到 Handoff §5 任一腐化信号，立即停止当前阶段。
- commit 前检查是否带入真实记忆正文、token、sessions、logs 或本机敏感路径。

## 每阶段必须提交

1. 完整且可 revert 的 diff；
2. 验收标准逐条勾选及实际命令输出；
3. Context Trace 样本（阶段 2 起）；
4. writer 变化声明，无变化写“无”；
5. 回滚方法与回滚验证命令。

## 完成定义

只以 `CURRENT_STATUS.md` 的验收标准为准。更新该文档时只写：新增的真实能力、状态变化、实际 bug、范围变化。禁止写“理论上完成”或堆叠思考过程。

## 你没有的权限

- 修改四份权威文档的设计决定；
- 新建长期记忆事实源或第二 writer；
- 代表主体 AI 改写 Re-entry / Self-note / Self-portrait 正文；
- 实现 AI 主动翻旧档、Soft Retrieval 或其他暂缓项；
- 以测试为由向正式记忆文件写入假数据；测试必须使用独立 fixture。
