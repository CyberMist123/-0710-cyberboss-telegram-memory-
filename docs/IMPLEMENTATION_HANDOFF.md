> **Status: superseded** — 部署期临时交接文档。
> 当前进度与下一步见 [`docs/CURRENT_STATUS.md`](./CURRENT_STATUS.md)；稳定结构见 [`docs/architecture/`](./architecture/)。

# Implementation Handoff — 实施交接

> 状态：临时交接文档，**不是第五份架构真相**。
> 权威文档仍然只有四份：`architecture/MEMORY.md`（结构）、`CURRENT_STATUS.md`（进度）、`520_CONSOLE.md`（前端边界）、`SOFT_RETRIEVAL.md`（暂缓项）。设计补充见 `MEMORY_LIVENESS_NOTES.md`。
> 本文与权威文档冲突时，以权威文档为准。首次端到端跑通后，本文大部分内容应被吸收或作废。
> 配套：`docs/prompts/DEPLOY_EXECUTION_PROMPT.md`（执行者入口）、`docs/prompts/ARCH_REVIEW_PROMPT.md`（阶段复核）。

## 1. 不可破坏的设计意图

1. **北极星判据**：记忆主要改变下一句话的姿态，不替 AI 决定下一句话的内容。
2. **上游 Cyberboss 是运行基线**，记忆是外挂插件。不宽泛重构 `src/core/`。
3. **写入权唯一**：原始会话（系统）、candidates（Closeout/Janitor）、Review decisions（Auto Review）、Episode canon（History writer）、Desire（Desire service）、Re-entry / Self-note 正文（主体 AI）。同一条事实只有一个来源。
4. **自动提取流程不直写 canon**。Auto Review 是海关不是编辑：核对来源、冲突、重复、长度、安全与格式；不按“重要性”替主体筛选，不改写 AI 措辞。History writer 只执行已经落盘的 Review decision。
5. **默认上下文只有**：System Prompt + Role Card + 首轮 Re-entry（≤300 字）+ 轻量 Current State + 当前对话。Episodes / Timeline / Portrait / Self-notes / Rereadings 默认不注入。
6. **默认隐藏 ≠ 不可查询**：第一阶段只要求用户明确拉线后的 `user_pull` 查询。AI 主动的 resonance / stakes / repair 触发仍是设计候选，当前不得实现。
7. **全链 fail-open**：memory / 520 / context builder 任何故障不得阻断 Telegram 回复。
8. **原始事件纯度**：进入 Closeout / Janitor 的原始会话必须排除记忆注入块、工具结果、Context Builder 元信息和客户端自动附件，防止记忆吃到自己的回声。
9. **隐私红线**：Episodes、Self-notes、Portrait 正文、`.env`、token、sessions、logs 永不入 Git。
10. **命令式措辞先告警**：记忆优先保存场景与原话。Re-entry 钩子中的祈使句第一阶段只产生 warning，不自动拒绝。
11. **诚实高于连续性**：“我记不清”永远合法；查到的不许说成“一直记得”。

## 2. 最小实施顺序与阶段门

严格按序，前一阶段验收未过不得进入下一阶段。每阶段 = 审计 → 修改 → 测试 → 更新 `CURRENT_STATUS.md`。

### 阶段 0 · 只读审计（不改任何文件）

产出：

- 当前 writer 清单；
- 双写点列表；
- Prompt、workspace 与 state-dir 的实际来源；
- TG poller、旧 MemoryService、520 与 Desire 的真实接线；
- `CURRENT_STATUS.md` 未收敛项在源码和运行现场是否仍成立；
- Closeout / Janitor 输入是否混入注入块、工具结果或自动附件。

### 阶段 1 · 干净主链

从干净目录验证主链；显式 state-dir；唯一 System Prompt / Role Card 来源；关闭旧 MemoryService 的后台双写与回复改写；保留最小 Windows 启动兼容。

**门**：TG 连发 10 条各回 1 次；流式正常；`/new` / resume 正常；关闭 memory 与 520 后 TG 仍可用。

### 阶段 2 · 硬上下文

新线程首轮加载 Re-entry（仅一次）；Current State 只读 Desire runtime；最小 Context Trace 记录每轮加载了什么、为什么、多少字；builder 失败回退原始消息。

**门**：Trace 能解释每轮；Re-entry 注入字数有记录且 ≤300 字；Episodes 等旧档没有被每轮硬塞。

### 阶段 3 · 后台数据链

- Closeout 每日最多一次，允许 0 产出，只产生 candidates 与主体 AI 原稿；
- Janitor 只补断档；
- Auto Review 独立产生 `accepted / rejected / deferred / merged` decision，不改写 AI 原稿；
- History writer 是 Episode canon 的唯一 writer，只执行已经落盘的 decision；
- 原始输入过滤记忆注入块、工具结果、自动附件与 builder 元信息；
- `decisions.jsonl` 落盘，写入动作幂等。

**门**：同日重跑 Closeout / Review / History writer 字节幂等；旧 Episodes / Timeline / Self-notes 不被自动覆盖；`state_log.jsonl` 字节不再变化；旧记忆回显不会被再次生成 candidate。

### 阶段 4 · 520 收口

默认只读：状态、Trace、任务健康、candidate 与 Review decision 查看；停止一切直写；异常时允许撤回、重审或调用 Review service。

**门**：关闭 520 不影响 TG 与后台；页面崩溃不重启 poller；`520_CONSOLE.md` 第一阶段验收全过。

### 阶段 5A · user_pull 查询（可选，前四关稳定后）

只支持用户明确寻找旧事：`memory.lookup(query, trigger="user_pull", reason)`。空结果合法；查询来源进入 Trace；查到的不冒充一直记得。

**门**：查询失败 fail-open；空结果照实返回；Trace 记录查询；旧档仍不自动注入。

### 阶段 5B · AI 主动翻档（暂缓）

resonance / stakes / repair 不在本轮实施。等真实 `why_now`、查询日志、翻错案例与预算数据后再决定。

## 3. 每阶段必须提交

- 完整、可 revert 的 diff；
- 验收标准逐条勾选及实际命令输出；
- Context Trace 样本（阶段 2 起）；
- writer 变化声明，无变化也写“无”；
- 回滚方法：revert 哪个 commit、数据文件如何从 `.backups/` 还原、如何验证回滚成功。

## 4. 已明确延后（禁止顺手实现）

- AI 主动翻旧档；
- Soft Retrieval 全链及 preview；
- embedding / BM25 / reranker；
- Memory Family / GraphRAG / PPR；
- 全量旧数据迁移；
- 自动改写 Timeline / Portrait / Re-entry；
- Re-entry Episode 数量元信息行；
- topic index、召回冷却、用量统计；
- 520 通用文件编辑器；
- 主动消息、天气、经期、语音、剧场。

执行者若认为某延后项“很容易顺便做了”，只许写进建议，不许进入 diff。

## 5. 常见腐化信号与停止条件

出现任一信号：停止当前阶段，写入 `CURRENT_STATUS.md` 的 bug 记录，等用户决定。

- 第二个 writer 出现；
- Re-entry 注入字数持续上涨；
- 上下文出现 Trace 无法解释的内容；
- Review 开始按重要性或品味筛选，或改写措辞；
- Re-entry 被系统直接改写正文；
- 520 出现绕过 Review 的写路径；
- 回复中出现无来源的“我记得”；
- 为通过测试伪造成功状态；
- 把“默认隐藏”实现成“无法查询”；
- 记忆注入块、工具结果或旧 Episode 回显被重新抽成 candidate。

## 6. 必须等真实案例才能决定

- why_now 放行规则与 Soft Retrieval 融合公式；
- 是否需要 LLM reranker；
- AI 主动翻档触发与预算；
- 旧 Episodes 是否迁移新 schema；
- Self-portrait 修订节奏；
- Memory Family 阈值；
- Re-entry 元信息行是否真的改善体验；
- 休眠、结束与换模型账本的具体产品形态。

## 7. SKILL.md 与运维说明：跑通后再写

现在不写 SKILL.md。首次端到端跑通后，依据真实 shell 历史与恢复演练补齐：

1. 部署 Skill：clone、配置、启动、验证、state-dir 与 smoke test；
2. 运维 Skill：健康检查、Janitor、备份还原与真实故障命令；
3. 升级 Skill：上游对比、合并、回滚。

Skill 中每条命令必须在干净环境实际复现过，才准落笔。

## 8. 未来扩展接口（只留缝，不实现）

Soft Retrieval、用户知识库、手机多端、MCP 化和多 AI 接入都应接运行时或受控 service，不直接读写记忆文件。
