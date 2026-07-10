# Cyberboss Telegram Memory

这是一个给 Cyberboss 增加“关系连续性”的私有扩展项目。

目标不是让 AI 背诵更多旧事，而是让它换窗口、`/new`、换模型后仍知道最近走到哪里；同时避免把历史、画像和规则全部塞进上下文，最后只剩表演式连续性。

> 当前阶段：整理架构与接线顺序。`design/living-memory-rfc` 仍是设计分支，不可直接覆盖本地运行目录。

## 接手 AI 先看什么

仓库只认下面四份权威文档：

1. [`docs/CONTINUITY_ARCHITECTURE.md`](docs/CONTINUITY_ARCHITECTURE.md)  
   唯一架构真相：各层做什么、谁读、谁写、什么时候进入上下文。
2. [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)  
   唯一实时进度：已跑通、未完成、下一步与验收标准。
3. [`docs/520_CONSOLE.md`](docs/520_CONSOLE.md)  
   520 页面要展示和控制什么，以及它不能承担什么后端职责。
4. [`docs/SOFT_RETRIEVAL.md`](docs/SOFT_RETRIEVAL.md)  
   暂缓的自动召回、reranker、why_now、记忆家族与 GraphRAG 进展。

另有一份非权威设计笔记：

- [`docs/MEMORY_LIVENESS_NOTES.md`](docs/MEMORY_LIVENESS_NOTES.md)：Fable 对“无自动召回时，记忆怎样仍然是活的”的脑暴与工程候选。它可以提供创意，但不能覆盖上述四份文档。

旧 RFC、审计任务、模型长评和阶段性判断不再作为当前规范。索引见 [`docs/archive/20260710_DESIGN_DRAFTS.md`](docs/archive/20260710_DESIGN_DRAFTS.md)。

代码目录中的 `README.md`、`PROJECT.md`、`AUTOMATION.md` 等只解释局部工具或旧运行方式；若冲突，以四份权威文档为准。

## 一张图看懂

```text
Telegram / 当前对话
        ↓
Cyberboss 运行时
        ↓
默认上下文：
System Prompt + Role Card + 首轮 Re-entry + 轻量 Current State
        ↓
模型自然回复

后台写入：
原始会话
  → Closeout 提出 Episode candidate / Re-entry 原稿 / Self-note
  → Auto Review 核对证据、重复、冲突、长度与安全
  → 各自唯一 writer 写入 canon
  → Reflect 低频更新 Timeline / Rereadings / Portrait

旧档读取：
Episodes 及下游来源默认不自动读取、不自动注入
  → 用户明确拉线时，可以受控工具式翻查
  → AI 主动翻档与自动 Soft Retrieval 暂不开放
```

## 当前真实状态

已经有并且曾运行过：

- Telegram → Cyberboss → Claude Code / DeepSeek → 回复；
- `reentry.md`、正式 `episodes.jsonl`、timeline、AI self notes 等关系记忆文件；
- Janitor 增量扫描与 `episodes.candidates.jsonl` 候选输出；
- 520 页面、Windows 启动脚本和本地运行现场。

还没有收敛：

- TG 实际读取哪份 Prompt 与哪一个 state-dir；
- 旧 Cyberboss MemoryService 与关系记忆的边界；
- Re-entry 双写作模式和长度告警；
- Auto Review、去重、冲突处理与 canon 唯一 writer；
- Self-note 的低频回读闭环；
- 用户拉线后的受控 Episode 查询；
- Desire 的唯一 writer 与 520 数据源；
- 520 从“大杂烩后端”退回可关闭的查看、切换与评测界面；
- 从干净 `main` clone 后的端到端验证。

明确暂缓：

- 自动 Soft Retrieval、embedding、LLM reranker；
- AI 主动翻旧档；
- Memory Family / GraphRAG；
- 全量旧数据迁移；
- Ombre / Haven 主线；
- 主动消息、语音、天气与经期等产品扩展。

## 不能混淆的边界

- Cyberboss 是主体；关系记忆是插件。
- Episode 是事件证据；Timeline 是整理视图，不是第二套事实源。
- Re-entry 是 AI 写给下一个自己的短交接，属于 canon；系统可以供材料，但不能替 AI 执笔。
- 不新增独立 Living State 文件；少量悬置事项留在 Re-entry 钩子里。
- Self-note 由 AI 唯一写入，普通对话不注入，只在 Closeout / Reflect 低频回读。
- Auto Review 默认由独立 AI 完成；用户不承担日常审批。
- Auto Review 是海关，不是编辑：核对事实和边界，不替主体 AI 决定什么值得记。
- Episodes、Timeline、Portrait、Self-note、Rereadings 默认隐藏；默认隐藏不等于删除或禁止查询。
- 520 的滑块控制测试注入，不封死用户明确拉线后的工具式翻查。
- Desire 是实时状态，不属于关系正史。
- 520 是前端；关掉页面后，TG、上下文和后台任务仍应运行。
- 旧 Episodes 与 Self-note 先保留原样，不因重构而重写其叙事与情感痕迹。

## 文档命名规则

- 权威文档统一使用英文大写文件名。
- 一个概念只有一个权威文件。
- 进度只更新 `IMPLEMENTATION_STATUS.md`。
- 架构只更新 `CONTINUITY_ARCHITECTURE.md`。
- 脑暴笔记必须明确标注“非权威”，结论定案后回写权威文档。
- 临时模型任务不要长期留在活跃目录；结论合并后进入 archive 或依靠 Git 历史追溯。
- 不再使用 `TONIGHT_*`、`FINAL_*`、`NEW_*`、`V2_FINAL_*` 这类很快失真的名字。

## 隐私

真实 token、会话、日志、私人记忆、Desire live state、PID、缓存和 lock 文件永不提交 GitHub。仓库只保存代码、结构、脱敏样例和公开可审查的设计说明。
