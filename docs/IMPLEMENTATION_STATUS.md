# Implementation Status

> 状态：唯一实时进度源  
> 最后更新：2026-07-11  
> 更新规则：完成一项、改变范围或发现真实 bug 时，只改本文，不在其他 Markdown 重复维护进度。

## 当前阶段

正在做架构收口和干净接线准备。

`design/living-memory-rfc` 当前仍以文档为主，不能当作已经完成的运行版本。旧本地 `legacy-current` 提供真实运行证据，但不继续在上面堆新功能。

## 状态总表

| 模块 | 状态 | 当前事实 |
|---|---|---|
| Telegram → Cyberboss → Claude Code / DeepSeek | 已跑通过 | legacy 本地曾实际运行；main 仍需干净目录 smoke test |
| System Prompt / 人格来源 | 未收敛 | runtime、仓库模板与本地 live 内容需要选唯一来源 |
| Re-entry | 已有 / 待验证 | 文件与旧循环存在；新规则已确定为 AI 最终执笔，双模式尚未实现 |
| Episodes | 已有 | 本地有正式内容；Git 只保留脱敏结构，暂不重写 |
| Timeline / Portrait / Self-notes / Rereadings | 已有 / 默认隐藏 | 文件和结构存在；普通对话不自动读取或注入 |
| Living State | 不采用独立文件 | 悬置事项继续由短 Re-entry 钩子承载，不新增长期数据层 |
| Janitor → candidates | 已跑通过 | 有增量、幂等、dry-run 和候选输出；默认调度与路径仍需收敛 |
| Auto Review → canon | 未完成 | 默认由独立 AI 审核；缺去重、冲突、合并、证据核对和唯一 writer |
| Closeout | 有模板 / 未闭环 | 需要稳定触发、允许 0 产出、只写 candidates / AI 原稿 |
| Self-note 闭环 | 未完成 | 普通对话不注入；Closeout / Reflect 低频回读规则已确定 |
| 旧档工具式查询 | 未完成 | 用户明确拉线时应能查 Episode；不等于自动 Soft Retrieval |
| Desire 当前状态 | 已有 / 边界混乱 | runtime 已写状态；旧 history、state_log 与 520 数据源尚未统一 |
| 520 | 已有 / 职责过重 | 页面可打开，但新边界、滑块、why_now 输入和 Auto Review 观察尚未实现 |
| Windows 启动 | 已有 / 待精简 | 入口和历史补丁过多，需保留最小 Claude 启动兼容 |
| Soft Retrieval | 暂缓 | 不做自动召回；只积累 why_now 评测数据 |
| Memory Family / GraphRAG | 暂缓 | 只保留思路，不接运行链 |

## 当前已确认的架构决定

- Cyberboss 是主体，关系记忆是插件。
- 默认硬上下文是 System Prompt、Role Card、首轮 Re-entry、轻量 Current State 和当前对话。
- 从 Episodes 开始的旧档默认不自动读取、不自动注入。
- 默认隐藏不等于不可访问：用户明确寻找旧事时，允许工具式查询。
- Re-entry 是 canon，由主体 AI 最终执笔；支持 AI 自主写和“系统供材料 → AI 写”两种模式。
- 不新增 Living State 文件；少量悬置事项留在 Re-entry 钩子里。
- Self-note 由 AI 唯一写入，不进入普通对话；Closeout / Reflect 可低频回读。
- Auto Review 默认由独立 AI 完成，用户不承担日常审批。
- Auto Review 只核对事实和边界，不替主体 AI决定记忆意义，不改写其声音。
- Timeline、Portrait、Rereadings 是低频视图或修正记录，不是并行事实源。
- Desire 只有一个 writer，关系记忆与 520 禁止写。
- 520 是可关闭前端，不能承载核心后台职责。
- Soft Retrieval 暂缓，但 520 可以采集 why_now 反馈。

## 下一步优先顺序

### 1. 先让现有主链干净可验证

- 从 `main` 新目录 clone；
- 显式配置 state-dir、workspace、prompt 来源；
- 保留上游 Telegram 收发与流式；
- 只提取真正必要的 Windows Claude 启动兼容；
- 关闭旧 Cyberboss MemoryService 的后台双写与回复改写能力。

### 2. 跑通硬上下文

- 明确唯一 System Prompt / Role Card 来源；
- 新线程首轮正确读取一次 Re-entry；
- Current State 只从 Desire runtime 读取；
- Context Trace 记录实际加载、跳过和 fallback；
- 从 Episodes 起全部默认不注入；
- Context 失败必须 fail-open，不能阻断 TG。

### 3. 跑通 Re-entry 与后台写入

- 实现 Re-entry authoring mode：`ai_direct` / `system_materials_then_ai` / `paused`；
- AI 保留最终原稿；Auto Review 不改写措辞；
- Re-entry 超出预算时告警，不静默膨胀；
- Closeout 每日最多一次，允许 0 产出；
- Self-note 由 AI 单写，普通聊天不注入；
- 旧正式 Episodes 暂时只读，不自动迁移或覆盖。

### 4. 实现最小 Auto Review

- 与 Closeout 分开运行；
- 核对证据、重复、冲突、修正、格式与安全；
- 输出 accepted / rejected / deferred / merged；
- History writer 按决策写 canon；
- 用户只保留撤回、异常重审和查看入口；
- 画像性 claim 需要时在自然对话中求证，不进入控制台待办。

### 5. 收紧 520

- 只读状态、Trace、任务健康和 Auto Review 决策；
- 停止写 `state_log.jsonl`；
- 不让 520 直接编辑 canon；
- 增加 Re-entry 模式切换；
- 增加 Episodes / Timeline / Portrait / Self-note / Rereadings 的测试滑块，默认关闭；
- 滑块只控制测试注入，不封死用户拉线后的工具式查询；
- 增加 why_now 空白框和结构化反馈记录；
- 关掉 520 后，TG、Context 和后台任务仍继续运行。

### 6. 再做旧档工具式查询

- 先只支持用户明确拉线；
- 小预算读取，查不到时自然继续；
- 记录读取来源与 why_now；
- 允许记忆只改变姿态，不强制复述成台词；
- AI 主动翻旧档的条件以后用真实样本再决定。

## 当前不做

- 自动 Soft Retrieval 或 preview 接线；
- embedding、BM25 fusion、LLM reranker；
- Memory Family、GraphRAG、PPR；
- 全量旧数据迁移；
- 自动把 Timeline、Portrait、完整 Episodes 或 Self-note 塞入对话；
- 新增 Living State 文件；
- 用户日常人工审核；
- 主动消息、天气、经期、语音、剧场；
- 一次性重写旧 `dashboard.py`；
- 把 legacy 的代理、offset 热刷新、文本去重、关流式等补丁带回 main；
- 导入用量统计。

## 当前验收标准

### Telegram

- 连续发送 10 条消息，每条只回复一次；
- 两条相同文本也都正常回复；
- 原版流式不变；
- `/new` / resume 正常；
- 关闭 memory 或 520 时 TG 仍可用。

### Context

- 能显示本轮实际加载、跳过的模块、来源、版本和字数；
- 新线程只加载一次 Re-entry；
- Episodes、Timeline、Portrait、Self-note、Rereadings 默认不自动注入；
- 用户明确拉线时可通过受控工具读取 Episode；
- Builder 失败时回退到原始消息；
- server 中断再恢复后，用户消息仍可被接受并回复。

### Memory

- Janitor 只写 candidates；
- `episodes.jsonl`、timeline、self notes 不被自动覆盖；
- Closeout 与 Auto Review 各自幂等；
- 0 产出属于成功；
- Re-entry 与 Self-note 的 AI 原稿不被 Review 改写；
- 一条事实不被多套 writer 重复写入。

### 520

- 可以独立启动与关闭；
- 关闭后 TG 和后台服务不受影响；
- 所有旧档测试滑块默认关闭；
- why_now 输入可以形成结构化日志；
- 页面只能调用后端服务，不能直接改 canon 或 Desire。

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
