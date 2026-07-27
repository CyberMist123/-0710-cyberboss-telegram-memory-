# System Overview

> **这份文档只描述稳定结构** —— 谁调用谁、谁写什么、边界在哪。
> 它**不写**当前完成度、日期、SHA 或"能不能切生产"。那些只在 `docs/CURRENT_STATUS.md`。
> 一个模块在这里被描述，不代表它已接生产。

领域细节见 `docs/architecture/MEMORY.md`（记忆链）与 `docs/architecture/WINDOWS_RUNTIME.md`（生产运行时）。

* * *

## 一、一条消息的完整路径

```text
Telegram
  │
  ▼
src/adapters/channel/telegram.js          通道适配器：拉取、去重、媒体描述符
  │   └── src/services/telegram-media-descriptor.js
  │   └── src/services/media-inbox-service.js
  ▼
src/core/route-lane.js                     算出 route lane（见第二节的三种身份）
  ▼
src/core/app.js                            中枢：命令分流、上下文装配、回复投递
  │
  ├── 命令？ ──► src/core/command-registry.js  ──► app.js 内的 handler
  │              （/effort、/model、能力操作等）
  │
  └── 对话 ──► src/core/hard-context.js       装配硬上下文三块
                  ├── Re-entry        ← src/core/reentry-loader.js
                  ├── Current State   ← src/core/current-state.js
                  └── memory_context  ← app.js 内装配，受 gate 控制
                  ▼
                  ├── launch-profile.js          profile → 启动参数（含 --effort）
                  ├── session-slot.js            native transcript 身份
                  ├── process-registry.js        进程与 lane 的对应
                  └── telegram-profile-router.js profile 选择
                  ▼
              模型回复
                  ▼
src/core/stream-delivery.js                分块、typing、投递回原 lane
```

送进模型的默认上下文只有四块：**System Prompt + Role Card + 首轮 Re-entry + 轻量 Current State + 当前对话**。Episodes 及下游旧档**默认不进**普通对话上下文 —— 这是设计，不是缺陷。

`src/core/context-trace.js` 记录每一轮装配了什么、跳过了什么、为什么。

**当前它只覆盖 `reentry` 与 `current_state` 两种 block。** `memory_context` 在全仓只作为 gate 键存在，从未作为 trace block 出现 —— 因为 trace 记的是运行时适配器返回的 `continuity`，而 memory_context 产生在另一条通路上。

所以 README 那条「Context Trace 无法解释实际上下文 = 一级腐化信号」目前对所有 provider 都成立。补齐它是修 G1 的验收前提，见 `docs/CURRENT_STATUS.md` P0-2。

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

**写入权唯一** —— 同一文件出现第二个 writer 是一级腐化信号：

| 内容 | 唯一 writer |
| --- | --- |
| 原始会话 log | 系统 |
| candidates | Closeout / Janitor |
| Review decisions | Auto Review |
| Episode canon | History writer |
| Re-entry / Self-note 正文 | 主体 AI |
| Desire 状态 | Desire runtime |

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
| **完全按需** | 上下文里连目录都没有，模型靠工具自己翻 | Episodes 正文、Timeline 正文、旧对话、天气、健康、Todo 原文、日记 |

第三档靠 `src/tools/tool-host.js` 注册的工具实现，经 `src/tools/mcp-stdio-server.js` 以 MCP 暴露给子进程。相关工具：`memory_lookup`、`cyberboss_timeline_read` / `_categories` / `_proposals`、`weather`、`cyberboss_diary_append`、`cyberboss_reminder`、`cyberboss_sticker_*`、`location_*`。

**这个分档就是"积木"的接缝。** 加一个新能力时先决定它落在哪一档；把第三档的东西提到第一档，是上下文膨胀最常见的来路。

### 硬上下文三门

`src/core/hard-context.js` 的 `loadContextGates()` 读 `CYBERBOSS_STATE_DIR/context-gates.json`：

```json
{ "reentry": true, "current_state": true, "memory_context": true }
```

文件缺失或键缺失 \= 该块启用。520 控制台可以写这个文件，在**不重启 TG 进程**的前提下切换注入块 —— 这是调试记忆通路的第一手段，也是临时压 Token 的最快开关。

### memory_context 的四种模式

> ⚠️ 下面描述的是这段逻辑本身。**它在 Telegram 上不执行**（第一节的提前 return），当前只对非 Telegram provider 生效。

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

Desire 状态由 Desire runtime 唯一写入；八维实时态落 `desire-state.json`，连续历史追加 `desire-history.jsonl`。

* * *

## 六、520 控制台

`extensions/relationship-memory/memory-kit/dashboard.py`（5,834 行，零第三方依赖，内联 HTML/JS 前端）与 `dashboard_continuity.py`。只绑 `127.0.0.1:0520`，不对外。

**520 是记忆系统的控制平面前端，不是只读面板。** 它能改提示词、改上下文分层、开关注入门、改 Desire 调度。六个 tab：健康度 / 时间线 / 八维 / 关怀 / 剧场 / 文件。

### 写权限分两层

**活跃写端点**（全部需要 `X-Api-Token`；只读端点因只绑本机而免 token）：

| 端点 | 改什么 | 保护 |
| --- | --- | --- |
| `/api/runtime-prompt/save`、`/restore` | **生产运行时提示词正文** | sha256 乐观锁、自动备份、历史版本下拉回滚、保存前 diff 预览 |
| `/api/context-layout/save`、`/snapshot`、`/restore` | 上下文分层布局与逐模块开关 | 快照 + 回滚 |
| `/api/context-gates` | 运行时三门 `reentry` / `current_state` / `memory_context` | 不重启 TG 进程即时生效 |
| `/api/desire-schedule` | Desire 调度配置（时区、夜间跳过等） | revision 乐观锁、自动备份、审计日志 `desire_schedule_saved` |
| `/api/context-source/save` | 上下文源 | — |
| `/api/todo/save` | Todo / Current Focus | — |
| `/api/review/retry` | 重跑单条 Review（调 `scripts/continuity/run-phase3.js review --candidate-id=`） | 候选 id 白名单正则 |

**冻结写端点** —— 一律 403 `write_frozen`，由 `test_dashboard_write_freeze.py` 守卫：

```text
/api/save              任意文件写
/api/state_log         八维状态史追加
/api/episode_candidate Episode 候选追加
/api/janitor/run       触发 janitor
/api/care/config       关怀配置
/api/care/cycle        cycle 录入
/api/config            chat provider / model
```

冻结名单在 `dashboard.py` 的 `FROZEN_WRITE_ENDPOINTS`。**冻结名单里混着两种性质完全不同的东西，不要一视同仁：**

- `/api/save`、`/api/state_log`、`/api/episode_candidate`、`/api/janitor/run`、`/api/config` —— **按设计冻结**。它们能绕过 Review 或直接改正式档，解冻前必须先证明不绕过 Review。
- `/api/care/config`、`/api/care/cycle` —— **只是前端还没接**。关怀页的读路径已通，写路径待补，属于未完成的工程，不是安全边界。补前端时一并解冻即可。

剧场页（`/api/theater/scripts`）目前纯展示只读，没有写端点。

### 上下文分层：520 能关掉的模块

`DEFAULT_CONTEXT_LAYOUT` 定义四组，每组每模块各有独立 `enabled` 开关，组级 `runtime_gate` 映射到硬上下文三门：

| 组 | 含义 | runtime_gate | 模块 |
| --- | --- | --- | --- |
| Base | 稳定层 | 无（恒在最前） | 人物卡 / AI Identity、关系 / 情感注入、Tool / AI 自主活动规则 |
| Re-entry | 慢变化层 | `reentry` | Boundary、History / Timeline 摘要、AI Portrait、User Portrait |
| Live State | 鲜活状态层 | `current_state` | 最近状态摘要 / 小纸条、**八维 / Desire**、承诺、Todo / Current Focus、Health / 手机 Monitor、Location / Weather、RP 预设 / Overlays |
| Cache | 会话连续层 | 无 | 上一会话摘要、上一会话原文 / 最近 N 轮 |

「八维开关」就是 Live State 组里的 `desire` 模块开关。布局落 `context-layout.json`，门控落 `context-gates.json`，两者都在 `CYBERBOSS_STATE_DIR`，TG 进程下一轮重建上下文时读到。

`compute_module_state()` 另外给出记忆链各模块的运行态（`on` / `available` / `preview` / `not_implemented`），依据是对应文件在不在，不是配置声明。

### 不可越过的边界

- **API 桥永不让外部直接写 `episodes.jsonl` 正式文件。候选与正式分离是全局禁区。**
- **520 出现绕过 Review 的写路径 \= 一级腐化信号。** 冻结名单存在的理由就是这条。
- 关怀页 cycle 只由用户本人录入，数据永不进 `user_portrait` / `episodes`，不做分析图表。
- 关掉 520 后，Telegram、上下文装配与后台任务必须仍然正常工作 —— 520 是编辑器，不是运行时依赖。

### 八维页的数据源

优先读 `desire-history.jsonl`（Desire 唯一 writer 追加）；只有连续历史不存在时才只读回退到冻结的 `state_log.jsonl`。页面显示数据源、路径、新鲜度、维度完整度与回退状态。八维曲线是内联 canvas 手绘，无外部 CDN。

## 七、Windows 生产运行时

细节见 `docs/architecture/WINDOWS_RUNTIME.md`，此处只给骨架。

```text
deployment/current.json          release descriptor（按机器不同，不入版本控制）
        │
        ▼
scripts/orchestration/release-control-plane.js   安装 descriptor 与启动件
        │  锚定：manifest 必须带 expectedManifestSha256，单读、BOM 检查、哈希锚定
        ▼
src/orchestration/release-manifest.js            manifest 生成与校验
        │  git 校验是关系校验：rev-parse ^{tree} 比对 commit.tree_sha
        ▼
scripts/windows/runtime-startup/                 生产机 PowerShell 入口
        ├── start-telegram.ps1     必须显式设置 CYBERLINK_ROOT，否则 fail-closed
        ├── start-dashboard.ps1    同上
        └── install-*.ps1          安装器
        ▼
extensions/relationship-memory/launcher/watchdog.py
        --descriptor 必填（无祖先探测、无 cwd 兜底）；Python ≥ 3.10
```

**两条不可回退的纪律**（来自 R4 审查）：

1. **不许向上摸目录找根。** `CYBERLINK_ROOT` 必须显式设置并校验其确含 `runtime/` 与 `settings/`。祖先回溯让一个诱饵目录就能决定被执行的 Python 文件与密钥路径。
2. **fail-closed 断言必须先证明进程真的跑过。** 复用 `assertFailedClosed`，不要裸写 `assert.notEqual(status, 0)` —— ENOENT 下它恒真，"脚本没跑"和"脚本正确退役"不可区分。

回滚：`scripts/windows/phase1-rollback.ps1`、`phase1-switch.ps1`。

* * *

## 八、按机器不同的东西

下列内容**永不入版本控制、永不跨机同步**：

```text
deployment/current.json          活动 release descriptor
runtime/                         PID、缓存、lock、live state
memory/                          私人 Episodes / Self-notes / Portrait
settings/secrets/*.local.json    密钥
```

`vendor/` 是上游拷贝，不在里面改东西。

* * *

## 九、各领域入口速查

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
