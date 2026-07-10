# Implementation Status

> 状态：唯一实时进度源  
> 最后更新：2026-07-10  
> 更新规则：完成一项、改变范围或发现真实 bug 时，只改本文，不在其他 Markdown 重复维护进度。

## 当前阶段

正在做架构收口和干净接线准备。

`design/living-memory-rfc` 当前仍以文档为主，不能当作已经完成的运行版本。旧本地 `legacy-current` 提供真实运行证据，但不继续在上面堆新功能。

## 状态总表

| 模块 | 状态 | 当前事实 |
|---|---|---|
| Telegram → Cyberboss → Claude Code / DeepSeek | 已跑通过 | legacy 本地曾实际运行；main 仍需干净目录 smoke test |
| System Prompt / 人格来源 | 未收敛 | runtime、仓库模板与本地 live 内容需要选唯一来源 |
| Re-entry | 已有 / 待验证 | 文件与旧循环存在；需确认 TG 读取正确 state-dir 和正确版本 |
| Episodes | 已有 | 本地有正式内容；Git 只保留脱敏结构，暂不重写 |
| Timeline / Portrait / Self-notes | 已有 | 内容和结构存在；以后作为当前视图与自我手记继续整理 |
| Janitor → candidates | 已跑通过 | 有增量、幂等、dry-run 和候选输出；默认调度与路径仍需收敛 |
| Candidate Review → canon | 未完成 | 缺去重、合并、证据预览、接受/拒绝/延后与唯一 writer |
| Closeout | 有模板 / 未闭环 | 需要稳定触发、允许 0 产出、只写 candidates |
| Desire 当前状态 | 已有 / 边界混乱 | runtime 已写状态；history、旧 state_log 与 520 数据源尚未统一 |
| 520 | 已有 / 职责过重 | 页面可打开并查看多类数据，但同时承担编辑、写状态和调度 |
| Windows 启动 | 已有 / 待精简 | 入口和历史补丁过多，需保留最小 Claude 启动兼容 |
| Soft Retrieval | 暂缓 | 今晚不做，单独记录在 `SOFT_RETRIEVAL.md` |
| Memory Family / GraphRAG | 暂缓 | 只保留思路，不接运行链 |

## 当前已确认的架构决定

- Cyberboss 是主体，关系记忆是插件。
- 硬上下文是 System Prompt、Role Card、首轮 Re-entry、轻量 Current State 和当前对话。
- Episode、Living State、Self-note 是数据；Re-entry、Timeline、Portrait 是阅读视图。
- Closeout、Review、Reflect、Janitor 是后台过程。
- 自动流程只写 candidates；canon 需要受控 Review writer。
- Desire 只有一个 writer，关系记忆与 520 禁止写。
- 520 是可关闭前端，不能承载核心后台职责。
- 旧 episodes、自我手记和 timeline 暂时保留，不迁移、不重写。
- Soft Retrieval 今晚不进入实现范围。

## 今晚优先顺序

### 1. 先让现有主链干净可验证

- 从 `main` 新目录 clone；
- 显式配置 state-dir、workspace、prompt 来源；
- 保留上游 Telegram 收发与流式；
- 只提取真正必要的 Windows Claude 启动兼容；
- 关闭旧 Cyberboss MemoryService 的后台双写与回复改写能力。

### 2. 跑通硬上下文

- 明确唯一 System Prompt / Role Card 来源；
- 新线程首轮正确读取 Re-entry；
- Current State 只从 Desire runtime 读取；
- 记录最小 Context Trace，确认实际加载了什么；
- Context 失败必须 fail-open，不能阻断 TG。

### 3. 跑通后台数据链

- 原始会话继续作为事实源；
- Closeout 每日最多一次，允许 0 产出；
- Review 与 Closeout 分开；
- 只生成 candidates 和 decision preview；
- 旧正式 Episodes 暂时只读，不自动迁移或覆盖。

### 4. 收紧 520

- 先做只读状态、Trace、任务健康和 candidate 查看；
- 停止写 `state_log.jsonl`；
- 不让 520 直接编辑 canon；
- 关掉 520 后，TG、Context 和后台任务仍继续运行。

## 今晚不做

- Soft Retrieval 正式或 preview 接线；
- embedding、BM25 fusion、LLM reranker；
- Memory Family、GraphRAG、PPR；
- 全量旧数据迁移；
- 自动改写 Timeline / Portrait / Re-entry；
- 主动消息、天气、经期、语音、剧场；
- 一次性重写旧 `dashboard.py`；
- 把 legacy 的代理、offset 热刷新、文本去重、关流式等补丁带回 main。

## 当前验收标准

### Telegram

- 连续发送 10 条消息，每条只回复一次；
- 两条相同文本也都正常回复；
- 原版流式不变；
- `/new` / resume 正常；
- 关闭 memory 或 520 时 TG 仍可用。

### Context

- 能显示本轮实际加载的模块、来源、版本和字数；
- 新线程只加载一次 Re-entry；
- 不把 Timeline、Portrait、完整 Episodes 每轮硬塞入；
- Builder 失败时回退到原始消息。

### Memory

- Janitor 只写 candidates；
- `episodes.jsonl`、timeline、self notes 不被自动覆盖；
- Closeout 与 Review 各自幂等；
- 0 产出属于成功；
- 一条事实不被多套 writer 重复写入。

### Desire

- 只有一个 writer；
- `state_log.jsonl` 字节不再变化；
- 520 只读展示当前状态和任务健康；
- 离线、失败和记录成功有明确状态，不补造历史。

## 下一次更新本文时需要写什么

只记录四类变化：

1. 新增了哪个真实运行能力；
2. 哪个状态从“未完成”变成“已验证”；
3. 发现了什么实际 bug 或错误假设；
4. 下一步范围是否改变。

不要把模型评审全文、临时提示词或长篇思考继续堆进本文。
