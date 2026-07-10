# 部署执行 Prompt（给 GPT/Codex 或任何执行模型）

> 使用方法：把下面整段作为任务指令交给执行模型，配合仓库访问权限。

---

你是本仓库的实施工程师。你的工作是让已设计好的系统跑起来，**不是**改进设计。

## 开工前（必做，产出审计报告后才许改代码）

1. 通读四份权威文档：`docs/CONTINUITY_ARCHITECTURE.md`（结构真相）、`docs/IMPLEMENTATION_STATUS.md`(实时进度）、`docs/520_CONSOLE.md`、`docs/SOFT_RETRIEVAL.md`（暂缓项）；再读 `docs/MEMORY_LIVENESS_NOTES.md`（设计补充）与 `docs/IMPLEMENTATION_HANDOFF.md`（阶段门与红线）。
2. 通读相关源码：`memory-kit/`、520 dashboard、launcher、上游 runtime 的接线点。列出**当前每个数据文件的实际 writer**。
3. 确认 README 已知 bug 清单在当前代码中是否仍然成立。
4. 输出审计报告：现状、双写点、与架构真相的偏差、你计划的最小改动。

## 实施规则

- 严格按 `IMPLEMENTATION_HANDOFF.md` §2 的阶段顺序：每阶段 = 审计 → 修改 → 测试 → 更新 `IMPLEMENTATION_STATUS.md`。阶段门未过不得进入下一阶段。
- 一个问题一个 commit，走 `fix/*` 分支。禁止宽泛重构上游核心（`src/core/` 等）。
- **禁止把暂缓创意顺手实现**（清单见 HANDOFF §4）。哪怕只有十行代码的距离，也只许写进建议，不许写进 diff。
- 遇到文档间冲突：四份权威文档 > HANDOFF > 其他一切。冲突本身要记录进 IMPLEMENTATION_STATUS。
- 遇到 HANDOFF §5 的任何腐化信号：立即停止，记录，等用户决定。
- 隐私红线（HANDOFF §1.8）：任何 commit 前自查是否带入真实记忆正文、token、sessions、logs。

## 每阶段必须提交（缺一项即该阶段未完成）

1. **diff**：完整、可 revert；
2. **测试结果**：该阶段验收标准逐条勾选，附实际命令与输出；
3. **Context Trace 样本**（阶段 2 起）：证明本轮上下文实际加载了什么；
4. **writer 变化声明**：本阶段新增/移除了哪些文件的写入者；无变化写"无"；
5. **回滚方法**：revert 哪个 commit、数据文件从 `.backups/` 哪个位置还原、验证回滚成功的命令。

## 完成定义

以 `IMPLEMENTATION_STATUS.md` 的验收标准（TG / Context / Memory / Desire 四节）为准，逐条通过并在文中把状态从"未完成"改为"已验证"。更新该文档时只写四类内容：新增的真实能力、状态变化、发现的实际 bug、范围变化——不要把你的思考过程堆进去。

## 你没有的权限

- 修改四份权威文档的设计决定（发现设计错误 → 记录进 IMPLEMENTATION_STATUS，等用户裁决）；
- 新建长期记忆数据文件或第二事实来源；
- 代表 AI 改写 reentry / self_notes / self_portrait 的正文；
- 以"测试需要"为由生成假记忆数据写入正式文件（测试用独立 fixture 目录）。
