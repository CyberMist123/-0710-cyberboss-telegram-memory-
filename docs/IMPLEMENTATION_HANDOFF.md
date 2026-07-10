# Implementation Handoff — 实施交接

> 状态：临时交接文档，**不是第五份架构真相**。
> 权威文档仍然只有四份：`CONTINUITY_ARCHITECTURE.md`（结构）、`IMPLEMENTATION_STATUS.md`（进度）、`520_CONSOLE.md`（前端边界）、`SOFT_RETRIEVAL.md`（暂缓项）。设计补充见 `MEMORY_LIVENESS_NOTES.md`。
> 本文与权威文档冲突时，以权威文档为准。首次端到端跑通后，本文大部分内容应被吸收或作废。
> 配套：`docs/prompts/DEPLOY_EXECUTION_PROMPT.md`（执行者入口）、`docs/prompts/ARCH_REVIEW_PROMPT.md`（阶段复核）。

## 1. 不可破坏的设计意图

这些不是偏好，是系统存在的理由。任何实现冲突时，砍实现，不砍意图。

1. **北极星判据**：记忆成功 = 改变下一句话的姿态；记忆失败 = 改变下一句话的内容。
2. **上游 Cyberboss 是运行基线**，记忆是外挂插件。不宽泛重构 `src/core/`。
3. **写入权唯一**：原始会话（系统）、candidates（Closeout/Janitor）、canon（唯一 Review writer）、Desire（desire service）、Re-entry 正文（AI 本人执笔，系统提取物只是草稿材料）。同一条事实只有一个来源。
4. **自动流程只写 candidates**，永不直写 canon；Review 是海关不是编辑——只查证据、长度、安全、去重、祈使句，不按"重要性"筛选，不改写 AI 措辞。
5. **默认上下文只有**：System Prompt + Role Card + 首轮 Re-entry（≤300 字）+ 轻量 Current State + 当前对话。episodes/timeline/portrait/self-notes 默认不注入。
6. **默认隐藏 ≠ 不可查询**：cued recall（她拉线或 AI 按四触发翻档，见 MEMORY_LIVENESS_NOTES §2/§8.1）是工具调用，始终放行；被禁的是自动注入（Soft Retrieval，暂缓）。
7. **全链 fail-open**：memory/520/context builder 任何故障不得阻断 Telegram 回复。
8. **隐私红线**：episodes、self_notes、portrait 正文、.env、token、sessions、logs 永不入 Git。
9. **规训语言禁令**：不给记忆文件加"四档/铁律/反镜映"式命令；reentry 钩子出现祈使句即为腐化。
10. **诚实高于连续性**："我记不清"永远合法；翻到的不许说成"一直记得"。

## 2. 最小实施顺序与阶段门

严格按序，前一阶段验收未过不得进入下一阶段。每阶段 = 审计 → 修改 → 测试 → 更新 `IMPLEMENTATION_STATUS.md`。

### 阶段 0 · 只读审计（不改任何文件）
产出：当前 writer 清单（谁在写哪个文件）、双写点列表、state-dir/prompt 实际来源确认、README 已知 6 个 bug 的复现确认。

### 阶段 1 · 干净主链
从 main 新目录 clone；显式 state-dir；唯一 System Prompt/Role Card 来源；关闭旧 MemoryService 后台双写与回复改写；最小 Windows 启动兼容。
**门**：TG 连发 10 条各回 1 次；流式正常；`/new`/resume 正常；关 memory 与 520 后 TG 仍可用。

### 阶段 2 · 硬上下文
新线程首轮加载 Re-entry（仅一次）；Current State 只读 desire runtime；最小 Context Trace（每轮记录加载了什么、为什么、多少字）；builder 失败回退原始消息。
**门**：Trace 能解释每轮；reentry 注入字数有记录且 ≤300 字；无任何文件被每轮硬塞。

### 阶段 3 · 后台数据链
Closeout 每日 ≤1 次、允许 0 产出、只写 candidates；Janitor 只补断档；Review 服务独立、按 §1.4 五关检查、唯一 canon writer；decisions.jsonl 落盘。
**门**：同日重跑 closeout/review 字节幂等；旧 episodes/timeline/self_notes 不被自动覆盖；`state_log.jsonl` 字节不再变化。

### 阶段 4 · 520 收口
默认只读（状态、Trace、任务健康、candidate 查看）；停止一切直写；Memory Review 页只调 Review Service。
**门**：关闭 520 不影响 TG 与后台；页面崩溃不重启 poller；520_CONSOLE.md 第一阶段验收全过。

### 阶段 5 · cued recall（可选，前四关稳定后）
`memory.lookup(query, trigger, reason)` 工具 + 服务端预算 + recall_log + register 标签，按 MEMORY_LIVENESS_NOTES §8。
**门**：预算超限工具报错而非提示词约束；空结果照实返回；Trace 记录每次 recall。

## 3. 每阶段必须提交

- diff（一个问题一个 commit，`fix/*` 分支）；
- 测试结果（验收标准逐条勾选 + 命令输出）；
- Context Trace 样本（阶段 2 起）；
- **writer 变化声明**：本阶段有没有新增/移除任何文件的写入者；无变化也要显式写"无"；
- 回滚方法：单 commit revert 即可恢复；涉及数据文件的操作先备份到 `.backups/` 并写明还原命令。

## 4. 已明确延后（禁止顺手实现）

Soft Retrieval 全链（含 preview）、embedding/BM25/reranker、Memory Family/GraphRAG/PPR、全量旧数据迁移、自动改写 Timeline/Portrait/Re-entry、主动消息、天气/经期关怀、语音、剧场、topic index、用量统计、520 通用文件编辑器。
执行者若认为某延后项"很容易顺便做了"——这正是它被延后的原因，写进建议，不写进代码。

## 5. 常见腐化信号与停止条件

出现任一信号：停止当前阶段，写入 IMPLEMENTATION_STATUS 的 bug 记录，等用户决定。

- 第二个 writer 出现（任何文件被两个进程写）；
- reentry 注入字数悄悄上涨；
- 上下文出现未在 Trace 里解释的内容；
- Review 开始按重要性/品味筛选或改写措辞；
- Re-entry 被系统（非 AI）改写正文；
- 520 出现绕过 Review 的写路径；
- 回复中出现无来源的"我记得"；
- 为通过测试而伪造 no_output 之外的成功状态；
- 把"默认隐藏"实现成了"无法查询"。

## 6. 必须等真实案例才能决定（现在不许拍板）

- why_now 放行规则与 Soft Retrieval 融合公式（等 ~20 条正负例）；
- 是否需要 LLM reranker（等失败案例集）；
- 旧 episodes 是否迁移新 schema（等 Review 闭环稳定）；
- self_portrait 修订节奏是否需要收紧（等第一次自我漫画化迹象）；
- cued recall 预算数值（每 session 1 次是初始猜测，用 recall_log 校准）；
- Memory Family 阈值 70% / 5 条（原型数字，不是结论）。

## 7. SKILL.md 与运维说明：跑通后再写

现在不写 SKILL.md——真实命令、路径、恢复流程未经完整部署验证，写了就是虚构文档。首次端到端跑通后，依据**真实运行记录**补齐：

1. **部署 Skill**：实际用过的 clone/配置/启动/验证命令序列（从 shell 历史提取，不凭记忆写）；state-dir 与 .env 的真实位置约定；smoke test 一键脚本。
2. **运维 Skill**：日常健康检查（对照 520 首页六问）；断档补记流程（janitor 实际参数）；备份与还原演练记录；常见故障 → 实际修复命令的对照表。
3. **升级 Skill**：从上游拉更新的安全流程（先 upstream-baseline 对比再合并）。

判断方法：Skill 里每条命令必须能在文档外的干净环境复现一次才准落笔。

## 8. 未来扩展的接口预留（只留缝，不实现）

Soft Retrieval（接 §2 阶段 5 的 lookup 服务后面）、用户知识库（独立目录独立 writer，不混 memory/）、手机/多端（TG 已是端，新端只接 runtime 不接记忆内部）、MCP 化（lookup/review/trace 天然适合做成 MCP server 工具面）、多 AI 接入（记忆文件模型无关，见 MEMORY_LIVENESS_NOTES §8.10）。共同原则：**新入口接运行时，不直接接记忆文件。**
