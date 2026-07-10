# Cyberboss Telegram Memory

这是一个给 Cyberboss 增加“关系连续性”的私有扩展项目。

目标不是让 AI 背诵更多旧事，而是让它换窗口、`/new`、换模型后，仍知道最近走到哪里，不会从虚无开始，也不会被历史和规则压得像在演角色。

> 当前阶段：整理架构与接线顺序。`design/living-memory-rfc` 仍是设计分支，不可直接覆盖本地运行目录。

## 先看这几份

仓库只认下面四份活文档：

1. [`docs/CONTINUITY_ARCHITECTURE.md`](docs/CONTINUITY_ARCHITECTURE.md)  
   唯一架构真相：各层做什么、谁读、谁写、什么时候进入上下文。
2. [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md)  
   唯一实时进度：已经跑通、半成品、今晚目标、验收标准和下一步。
3. [`docs/520_CONSOLE.md`](docs/520_CONSOLE.md)  
   520 页面该展示什么，以及它不能承担什么后端职责。
4. [`docs/SOFT_RETRIEVAL.md`](docs/SOFT_RETRIEVAL.md)  
   暂缓的软召回、reranker、记忆家族与 GraphRAG 进展。

旧 RFC、审计任务、调研长文和阶段性判断不再作为当前规范。索引见 [`docs/archive/20260710_DESIGN_DRAFTS.md`](docs/archive/20260710_DESIGN_DRAFTS.md)。

## 一张图看懂

```text
Telegram / 当前对话
        ↓
Cyberboss 运行时
        ↓
硬上下文：
System Prompt + Role Card + 首轮 Re-entry + 轻量 Current State
        ↓
模型自然回复

后台：
原始会话
  → Closeout / Review
  → Episode / Living State / Self-note 候选
  → 审核后的正史
  → 生成 Re-entry / Timeline 等阅读视图

未来：
Soft Retrieval 从正史中按需取 0–3 条，暂不在今晚实现。
```

## 当前真实状态

已经有并且曾运行过：

- Telegram → Cyberboss → Claude Code / DeepSeek → 回复；
- `reentry.md`、正式 `episodes.jsonl`、timeline、AI self notes 等关系记忆文件；
- Janitor 增量扫描与 `episodes.candidates.jsonl` 候选输出；
- 520 页面、Windows 启动脚本和本地运行现场。

还没有收敛：

- TG 实际读取哪一份 prompt 与哪一个 state-dir；
- 旧 Cyberboss MemoryService 与关系记忆的边界；
- candidate 去重、审核、合并与晋升；
- Desire 的唯一 writer 与 520 数据源；
- 520 从“大杂烩后端”退回可关闭的查看与控制界面；
- 从干净 `main` clone 后的端到端验证。

明确暂缓：

- Soft Retrieval、embedding、LLM reranker；
- Memory Family / GraphRAG；
- 全量旧数据迁移；
- Ombre / Haven 主线；
- 主动消息、语音、天气与经期等产品扩展。

## 几条不能混淆的边界

- Cyberboss 是主体；关系记忆是插件。
- Episode 是事件证据；Timeline 是由事件整理出的故事视图，不是第二套事实源。
- Re-entry 是下一次醒来需要知道的少量当前信息，不是完整历史。
- Closeout / Review 是后台过程，不是一种记忆文件。
- Desire 是实时状态，不属于关系正史。
- 自动流程只写 candidates；正式正史必须经过审核规则。
- 520 是前端。关掉页面后，TG、上下文和后台任务仍应运行。
- 旧 episodes 和 self notes 先保留原样，不因重构而重写其叙事与情感痕迹。

## 文档命名规则

- 活文档统一使用英文大写文件名。
- 一个概念只有一个权威文件。
- 进度只更新 `IMPLEMENTATION_STATUS.md`。
- 架构只更新 `CONTINUITY_ARCHITECTURE.md`。
- 临时模型任务不要长期留在活跃目录；结论合并后进入 archive 或直接依靠 Git 历史追溯。
- 文件名不再使用 `TONIGHT_*`、`FINAL_*`、`NEW_*`、`V2_FINAL_*` 这类很快失真的名字。

## 隐私

真实 token、会话、日志、私人记忆、desire live state、PID、缓存和 lock 文件永不提交 GitHub。仓库只保存代码、结构、脱敏样例和公开可审查的设计说明。
