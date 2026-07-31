# System Overview

```text
Status: active
Authority: stable architecture
Scope: 全系统调用链、身份模型、上下文分档、写入权
Current status: docs/CURRENT_STATUS.md
```

> **这份文档只描述稳定结构** —— 谁调用谁、谁写什么、边界在哪。
> 它**不写**当前完成度、日期、SHA 或"能不能切生产"。那些只在 `docs/CURRENT_STATUS.md`。
> 一个模块在这里被描述，不代表它已接生产。

领域细节见 `docs/architecture/MEMORY.md`（记忆链）与 `docs/architecture/WINDOWS_RUNTIME.md`（生产运行时）。

* * *

## 一、一条消息的完整路径

```text
Telegram 用户消息
  │
  ▼
src/adapters/channel/telegram.js      通道适配器：拉取、去重、媒体描述符
  ▼
src/core/route-lane.js                算出 route lane（第二节的三种身份）
  ▼
src/core/app.js                       中枢：命令分流、投递
  │
  ├── 命令？ ──► src/core/command-registry.js ──► app.js 内的 handler
  │
  ├── 通路 A：buildRuntimeTurn()        —— 本轮 turn 的拼装
  │     ├── provider = telegram
  │     │     ├── resolveMemoryContextFailOpen()
  │     │     └── plaintext <channel> envelope，<memory_context> 块排在信封上方（外侧）
  │     │           （formatTelegramRuntimeText()）
  │     │        注：这条分支不走 resolveVisionContext() —— Telegram 媒体
  │     │        以 <media> 引用进 envelope，是刻意设计（DECISIONS.md D15）
  │     └── 其他 provider
  │           ├── resolveVisionContext()
  │           └── resolveMemoryContextForPrepared()
  │
  └── 通路 B：runtime opening context   —— 运行时适配器注入
        （src/adapters/runtime/claudecode|codex 调 prepareOpeningContext()）
          ├── Re-entry
          └── Current State
  ▼
模型回复 ──► src/core/stream-delivery.js  分块、typing、投递回原 lane
```

**通路 A 与通路 B 不是同一个函数，也不是同一条执行路径。**

- Re-entry 与 Current State 属于 **opening context**（通路 B）；
- memory_context 属于 **runtime turn 拼装**（通路 A）；
- 所以 memory_context 失败**不代表** Re-entry 和 Current State 失败，反之亦然。两者要分开判读、分开修。

把三者画成同一条装配链是上一版文档的错误，也是通路 A 上的缺陷长期没被发现的原因之一。当前各自的状态见 `docs/CURRENT_STATUS.md`。

默认模型输入由**稳定提示层、首轮 Re-entry、轻量 Current State、当前真实对话**组成。Episodes 及下游旧档**默认不进**普通对话上下文 —— 这是设计，不是缺陷。

`src/core/context-trace.js` 记录每一轮装配了什么、跳过了什么、为什么。

trace 行的主体是运行时适配器返回的 `continuity`（通路 B 的 `reentry` / `current_state`）。**`memory_context` 来自通路 A，由 `app.js` 的 `recordContextTrace()` 折进同一行**：本轮解析出记忆行就记成一个 `loaded` 的 `memory_context` block，`reason` 取 memory_context 的 mode（`targeted` / `state_only` / `skip` / `gated_off` / `error` 等）；没有记忆行就记进 `skipped`，`reason` 同样是 mode，缺失时退成 `empty`。

只有**投递用户回合**那一处调用会把本轮的 memory_context 传进来。opening 刷新类调用不带 turn，不传，行的形状保持原样 —— 所以 opening 行里没有 `memory_context` 是正常的，不是缺失。

这样 README 那条「Context Trace 无法解释实际上下文 = 一级腐化信号」才有落点：三个注入块现在都能在同一行里被解释。

* * *

### 子代理与结果回流

Claude Code 子进程自己可以再起**子代理**。这条链路目前不由本仓库的代码调度 —— 它发生在子进程内部 —— 但有一个必须知道的后果：

> **子代理的反馈会回到子进程的 transcript，也就是会进入这个 chat 窗口的上下文。**

所以"Work 过程隔离、只把结果胶囊带回主 Chat"是**目标**，不是当前已实现的保证。一个话痨子代理会直接把主对话的上下文吃掉，这是 Token 预算最容易失控的地方。

`route-lane.js` 的系统 lane 隔离解决的是**后台任务**不串进用户 transcript；它不解决**子代理输出**回流。两者不要混为一谈。

未来方向：子代理运行时除 Claude Code 外也考虑接 Codex（`src/adapters/runtime/codex/` 已有完整的 rpc-client / session-store / model-catalog，目前用于主运行时切换，不用于子代理）。

## 二、三种身份，永远不许混

`src/core/route-lane.js` 的头部注释是这段的权威定义，改动前先读它。

| 身份 | 组成 | 管什么 | 定义在 |
| --- | --- | --- | --- |
| **Continuity binding** | `workspaceId + accountId + senderId` | 长期**用户记忆**身份。跨 chat、topic、profile 稳定。**永不包含** `chatId` / `messageThreadId` / `profileId` | `route-lane.js` |
| **Route lane** | `accountId + chatId + nullable messageThreadId` | 每对话的**投递与回合串行**身份。两个 lane 绝不共享 turn gate、pending buffer、debounce timer、回复目标、typing 指示或出站 thread id | `route-lane.js` |
| **Session slot** | `workspace + route lane + effective profile` | Claude native transcript 身份 | `adapters/runtime/claudecode/session-slot.js` |

`route-lane.js` **无依赖，必须保持无依赖** —— 通道适配器、core app、运行时适配器三边都加载它。

**系统 lane**：后台生产者各有自己的显式 lane（`closeout`、`liveness`、`system-message`、`background-author`、`automation-sender`），绝不继承交互式 Telegram 路由。这样一个 closeout 回合不可能落进用户的 topic transcript，一个用户回合也不可能被后台任务 resume。

* * *

## 三、记忆链与写入权

```text
原始会话（排除记忆注入块 / 工具结果 / 自动附件）
  → Closeout / Janitor      只产生 candidates 与 AI 原稿
  → Auto Review             只产生 decision
  → History writer          按 decision 唯一写入 canon
  → Reflect                 低频更新 Timeline / Rereadings / Portrait
```

代码位置：`src/continuity/`（`closeout-job.js`、`continuity-pipeline.js`、`candidate-authority.js`、`review-checkpoint.js`、`continuity-store.js`、`conversation-purity.js`）。调度在 `src/app/closeout-liveness.js`，由 `src/core/app.js` 装配。

**写入权唯一，谁写什么见 [`MEMORY.md`](./MEMORY.md) 第 7 节。** 同一文件出现第二个 writer 是一级腐化信号 —— 那张表只在 MEMORY.md 维护，这里不复制。

跨进程互斥靠 `src/orchestration/writer-lease.js`（租约，支持 stale 恢复）与 `src/core/workspace-lock.js`。

**Auto Review 是海关，不是编辑。** 它核对来源、冲突、重复、长度、安全与格式；不按"重要性"替主体筛选，也不改写 AI 的措辞。

**读取侧只有一种翻档**：用户明确寻找旧事时，通过 `src/services/memory-lookup-service.js` 走受控工具（在 `src/tools/tool-host.js` 注册为 `memory_lookup`）。AI 因共鸣或修复需要主动翻档仍是设计候选，未开放。

**全程 fail-open：宁可本轮失忆，不可本轮失联。**

* * *

### Reflect 的位置

`src/continuity/weekly-reflect.js` 定义了 `WeeklyReflect`：抽一条**非最新**的 Episode，带上最近的 Self-notes 交给 `runtime.reflect()`，把新理解以幂等标记追加进 `rereadings.md`，走 writer lease，只叠加不覆盖。

它在设计里的位置是 `episodes → 低频重读 → 理解变化 → Re-entry 姿态变化` 这条链的第二步。**当前实现状态见 `docs/CURRENT_STATUS.md`**（简短说：这条链现在是断的）。

* * *

## 四、上下文预算：门控、目录与按需加载

**省 Token 不是优化项，是这套系统的结构性约束。** 一份东西"存在"和"每轮都进上下文"之间有三档，改任何注入前先确认你在改哪一档。

### 三档取用方式

| 档 | 含义 | 谁属于这一档 |
| --- | --- | --- |
| **常驻注入** | 每轮都拼进 prompt | System Prompt、Role Card、首轮 Re-entry、轻量 Current State |
| **目录式** | 只把**索引 / 摘要 / 标签表**放进上下文，正文不放 | Memory 目录、Timeline 摘要、贴纸标签表（`cyberboss_sticker_tags` 明确写着"只在决定要用贴纸时才加载目录"） |
| **完全按需** | 上下文里连目录都没有，模型靠工具自己翻 | Episodes 正文、Timeline 正文、旧对话、天气、健康、Todo 原文、日记、账本（`details.jsonl`，见 [`MEMORY.md`](./MEMORY.md) 2.5） |

第三档靠 `src/tools/tool-host.js` 注册的工具实现，经 `src/tools/mcp-stdio-server.js` 以 MCP 暴露给子进程。相关工具：`memory_lookup`、`cyberboss_timeline_read` / `_categories` / `_proposals`、`weather`、`cyberboss_diary_append`、`cyberboss_reminder`、`cyberboss_sticker_*`、`location_*`。

**这个分档就是"积木"的接缝。** 加一个新能力时先决定它落在哪一档；把第三档的东西提到第一档，是上下文膨胀最常见的来路。

### 硬上下文三门

`src/core/hard-context.js` 的 `loadContextGates()` 读 `CYBERBOSS_STATE_DIR/context-gates.json`：

```json
{ "reentry": true, "current_state": true, "memory_context": true }
```

文件缺失或键缺失 \= 该块启用。520 控制台可以写这个文件，在**不重启 TG 进程**的前提下切换注入块 —— 这是调试记忆通路的第一手段，也是临时压 Token 的最快开关。

### memory_context 的四种模式

Telegram 与其他 provider 走的是同一段解析逻辑，区别只在包装：Telegram 经 `resolveMemoryContextFailOpen()` 调用它（解析抛错时退成空 context，不拖垮本轮投递），结果作为 `<memory_context>` 块排在 `<channel>` envelope **上方（外侧）**——信封本体保持与线上桥逐字节一致（D9），记忆行永不与她的原文交错（D15，`formatTelegramRuntimeText()` 上方注释）。

`resolveMemoryContextForPrepared()`（`app.js`）先调 `src/core/memory-resolver.js` 的 `resolveMemoryRetrievalPlan(text)`，按**这一句话说了什么**决定这轮要不要检索：

| 模式 | 触发 | 注入什么 |
| --- | --- | --- |
| `skip` | 闲聊短句（"嗯"、"晚安"、"在干嘛"）且无槽位命中 | 不检索 |
| `state_only` | 命中进度 / 待办 / 此刻类措辞（"做到哪了"、"提醒我"） | 只用状态层，不翻记忆 |
| `targeted` | 命中槽位 | 只取命中的那几个槽 |
| `gated_off` / `manual_override` / `disabled` | 门控关闭 / 手动覆盖文件 / `CYBERBOSS_MEMORY_RETRIEVAL=false` | 按配置 |

槽位由 `src/core/memory-intent-classifier.js` 的正则表决定，共六个：`identity`、`relationship`、`preference`、`project`、`pattern`、`pending_promise`。**这是纯规则匹配，没有 embedding、没有相似度** —— 便宜、可解释、可测试，是当前阶段的刻意选择。

### 三个降本方向

设计里还有三个降本方向：**MCP 工具分组隐藏**（按场景只暴露一部分工具 schema）、**Memory 目录化**（注入可翻的目录而非命中行）、**子代理输出的结果胶囊化**（见第一节）。

它们各自做到哪一步，只看 `docs/CURRENT_STATUS.md` 的能力表 —— 这里不复述状态。

## 五、Desire 与主动消息

| 组件 | 位置 | 说明 |
| --- | --- | --- |
| Desire 内核 | `src/core/desire.js`、`desire-schedule.js`、`desire-state-persistence.js`、`desire-telemetry.js` | 八维状态 |
| 小时轮询 | `src/app/hourly-desire-poller.js` | 由 `app.js` 调起 |
| 服务层 | `src/services/desire-service.js` | {} |
| 系统消息队列 | `src/core/system-message-queue-store.js` | {} |
| 系统消息投递 | `src/core/system-message-dispatcher.js` | 走 `system-message` 系统 lane |
| 定时签到 | `src/app/system-checkin-poller.js` | {} |
| 自主活动暂停态 | `src/core/activity-pause-state.js` | `CYBERBOSS_STATE_DIR/activity-pause.json` |

Desire 状态由 Desire runtime 唯一写入；八维实时态落 `desire-state.json`，连续历史追加 `desire-history.jsonl`。

`/pause activity` 与 `/continue activity` 只控制窗口聊天之外的自主心跳：Desire 小时 tick、定时签到、closeout/liveness 新调度，以及 `desire_checkin` / `checkin` / `liveness_alert` 三种已排队消息的投递。窗口聊天、用户 reminder、位置事件与其他显式 system message 不在暂停面内。正在运行的回合不取消，下一次 tick 才读取暂停态。

`activity-pause.json` 的唯一 writer 是 `app.js` 的命令 handler；三个 poller 与 system-message dispatcher 都只读。文件缺失、损坏或 schema 不合法时按“未暂停”处理（fail-open）。队列中的受控消息不删除，continue 后按原有 `createdAt` 排序恢复投递。

* * *

## 六、520 控制台

`extensions/relationship-memory/memory-kit/dashboard.py` 与 `dashboard_continuity.py`。只绑 `127.0.0.1:0520`，不对外。

**520 是记忆系统的控制平面前端，不是只读面板。** 它能改生产运行时提示词、上下文分层与逐模块开关（含「八维 / Desire」）、注入门控、Desire 调度，并能重跑单条 Review。写端点全部需要 `X-Api-Token`。

`FROZEN_WRITE_ENDPOINTS` 共 7 个，性质不同：5 个是**安全冻结**（能绕过 Review 或直接改正式档），2 个 `care` 端点只是**前端未接完**。

**完整端点表、分层模块表与保护机制见 [`../520_CONSOLE.md`](../520_CONSOLE.md)。**

三条不可越过的边界：

- **API 桥永不让外部直接写 `episodes.jsonl` 正式档。候选与正式分离是全局禁区。**
- **520 出现绕过 Review 的写路径 = 一级腐化信号。**
- 关掉 520 后，Telegram、上下文装配与后台任务必须仍然正常工作 —— 它是编辑器，不是运行时依赖。

`context-gates.json`（三门）与 `context-layout.json`（分层）都落在 `CYBERBOSS_STATE_DIR`，TG 进程下一轮重建上下文时读到，**不需要重启**。

## 七、Windows 生产运行时

```text
deployment/current.json  →  release-control-plane.js  →  scripts/windows/runtime-startup/*.ps1
       descriptor              哈希锚定安装                    生产机入口
                                                                    ↓
                                             extensions/relationship-memory/launcher/watchdog.py
```

descriptor 是唯一事实来源，**按机器不同、不入版本控制、不跨机同步**；`runtime/`、`memory/`、`settings/secrets/*.local.json` 同理。

**完整内容 —— descriptor 字段、安装链路的哈希锚定关系、两条不可回退的纪律（不许祖先回溯找根、fail-closed 断言必须先证明进程跑过）、watchdog 契约、回滚路径 —— 全部在 [`WINDOWS_RUNTIME.md`](./WINDOWS_RUNTIME.md)，这里不复制。**

## 八、各领域入口速查

| 域 | 入口文件 | 领域文档 |
| --- | --- | --- |
| Telegram 通道 | `src/adapters/channel/telegram.js` | `docs/TELEGRAM_MEDIA_RUNTIME.md`、`docs/TELEGRAM_ROUTE_LANES_V2.md` |
| 路由 lane | `src/core/route-lane.js` | 同上 |
| Claude Code 运行时 | `src/adapters/runtime/claudecode/index.js` | `docs/commands.md` |
| 上下文装配 | `src/core/hard-context.js` | `docs/architecture/MEMORY.md` |
| 记忆链 | `src/continuity/` | `docs/architecture/MEMORY.md` |
| 受控翻档 | `src/services/memory-lookup-service.js` | `docs/SOFT_RETRIEVAL.md` |
| Closeout 调度 | `src/app/closeout-liveness.js` | `docs/CLOSEOUT_LIVENESS.md` |
| Desire | `src/core/desire.js` | — |
| 520 | `extensions/relationship-memory/memory-kit/dashboard.py` | `docs/520_CONSOLE.md` |
| 发布控制平面 | `scripts/orchestration/release-control-plane.js` | `docs/architecture/WINDOWS_RUNTIME.md` |
| 生产启动 | `scripts/windows/runtime-startup/` | `docs/WINDOWS_SILENT_STARTUP.md` |
