# Cyberboss 核心改动审查包（给 Fable / 其他代码模型）

日期：2026-07-10

## 0. 审查目标

用户明确要求：

- **以 `AngeliaSama/cyberboss-deepseek` 原仓库行为为基线。**
- 原仓库本来能正常工作，不接受为了“架构更漂亮”而大改核心。
- 真正想保留的主要是：新建的关系记忆 `memory/`、`memory-kit/`、520 网页面板、本地 Windows 快捷启动与必要的 DeepSeek/Claude Code 接入。
- Telegram 代理、offset 刷新、额外去重、单实例锁、重复回复抑制等，是后续修 bug 叠出来的补丁；**不要默认它们有价值，优先判断能否回退到上游。**
- 当前能运行的本地目录只作冻结现场。任何回退必须在新目录/分支验证，不能直接覆盖现有部署。

## 1. 对比基线

本地源码仓库基线：

- upstream：`AngeliaSama/cyberboss-deepseek`
- commit：`ecc98cd1510c659f70ed7ac2dcc9b64c05ae7119`
- message：`feat: finalize location v2 event-driven runtime`
- 本地 branch：`local-safe-test`

对比命令：

```bash
git diff --ignore-space-at-eol ecc98cd -- <path>
```

工作树看起来改了 150+ tracked 文件，但大部分只是 CRLF/LF。忽略行尾后，真实逻辑修改集中在下列 16 个 tracked 文件；另有若干新建文件服务于 compact 与 Windows 启动。

## 2. 先给结论：建议分类

### A. 高置信度“回退到上游再测试”

这些是一组互相叠加的 Telegram 修 bug 补丁，用户已明确表示不想保留：

1. `package.json`：新增 `tunnel-agent`
2. `src/adapters/channel/telegram-utils.js`：自建代理 fetch 层
3. `src/adapters/channel/telegram.js`：代理配置、从磁盘刷新 state、扩大去重逻辑
4. `src/core/stream-delivery.js`：3 秒文本去重 + 关闭 delta 流式
5. `src/index.js`：stateDir 单实例锁
6. `src/services/telegram-service.js`：请求超时 10s → 20s
7. `src/core/app.js`：Telegram poll 健康跟踪、入站二次去重
8. `src/core/system-message-dispatcher.js`：runtime outage 系统消息

建议：在新分支先整体恢复这组文件到 `ecc98cd`，只补回确有必要的小修，跑 TG smoke test。

### B. 独立功能岛，需要单独决定，不应混在 Telegram 修复里

1. **自动 compact / `/ctx`**
   - `src/core/app.js`
   - `src/core/config.js`
   - `src/core/command-registry.js`
   - `src/adapters/runtime/claudecode/index.js`
   - 新文件 `src/core/compact-state-store.js`
   - 新文件 `src/core/compact-instructions.js`
   - 若干 compact hook / scripts

2. **desire-state 历史与网页展示数据**
   - 大量逻辑直接塞入 `src/core/app.js`
   - 应保留产品需求，但建议移入独立 service/hook；不要继续扩大 `app.js`

3. **Windows Claude Code 进程启动**
   - `src/adapters/runtime/claudecode/process-client.js`
   - `shell` 仅对 `.cmd/.bat` 开启、`windowsHide: true` 很可能是必要的本地适配
   - CLI warning 过滤要单独审，不能和 Windows 启动修复绑在一起

4. **Codex RPC 超时**
   - `src/adapters/runtime/codex/rpc-client.js`
   - 如果当前 TG 主线不用 Codex runtime，优先恢复上游，避免无关改动

### C. 倾向保留

1. `templates/weixin-instructions.md` 的关系记忆入口
   - 属于用户明确想保留的 memory 扩展
   - 但需保证运行时真正同步到 `.cyberboss-deepseek-test/weixin-instructions.md`

2. `src/adapters/channel/telegram.js` 中仅两行的文件消息描述修正：
   - 原代码重复读取 `file_name`
   - 新代码能在无文件名时返回 `[文件]`
   - 可作为独立小 patch 保留，不应因此保留整套 state/proxy 补丁

3. Windows 本地启动脚本（大多是新文件，不属于上游核心）
   - 可以放在 `extensions/windows-launcher/` 或 `scripts/windows/`

## 3. 逐文件标记

| 文件 | 实际改动 | 初步判断 | 建议 |
|---|---|---|---|
| `package.json` | 新增 `tunnel-agent` | 只服务自建 TG 代理 | 随代理补丁一起回退 |
| `scripts/start-deepseek-telegram.sh` | 默认打开 `CYBERBOSS_MEMORY_BACKGROUND_WRITE=1` | 会开启 Cyberboss 旧内置 memory 写入，与新关系 memory 并存 | **优先回退/默认 0** |
| `scripts/switch_shared_runtime.sh` | 本地删除 | 上游文件含硬编码机器路径和 token，不适合恢复原样 | 保持删除或改成本地示例，勿恢复密钥 |
| `src/adapters/channel/telegram-utils.js` | 129 行代理 fetch 实现 | 复杂度高，且用户不需要；增加新的超时/Abort 行为 | 回退上游 |
| `src/adapters/channel/telegram.js` | 代理、state mtime refresh、去重 set 上限、deleteWebhook 改走 helper、文件描述小修 | 大部分是并发/重复问题补丁 | 回退后仅考虑保留文件描述小修 |
| `src/adapters/runtime/claudecode/index.js` | `/compact` 可追加自定义 instructions | 自动 compact 功能岛 | 单独评估；不与 memory/TG 修复混合 |
| `src/adapters/runtime/claudecode/process-client.js` | Windows `.cmd/.bat` shell、隐藏窗口、过滤 CLI warning | Windows 启动部分可能必要；warning 过滤可能吞信息 | 拆成两个 patch 分别审 |
| `src/adapters/runtime/codex/rpc-client.js` | RPC timeout、transport 关闭时 reject pending | 通用健壮性，但与当前主线可能无关 | 当前不用 Codex 则先回退 |
| `src/core/app.js` | Telegram 健康/去重、auto compact、desire history/backfill 等 785 行 | 最大风险文件，多个功能岛混杂 | 不整体重写；按功能块拆审 |
| `src/core/command-registry.js` | 新增 `/ctx` | auto compact 配套 | 是否保留取决于 compact 功能 |
| `src/core/config.js` | TG proxy、desire-history、compact 配置 | 多个功能岛共用 | 回退 proxy；其余按功能拆分 |
| `src/core/stream-delivery.js` | 文本 TTL 去重、关闭 delta 流式 | 高风险，可能吞合法重复文本并改变原版流式 | **优先回退上游** |
| `src/core/system-message-dispatcher.js` | outage prompt | 当前对应 enqueue 方法未被调用 | 删除/回退 |
| `src/index.js` | stateDir PID lock | 用户确认不需要，可能制造 stale lock | 回退上游 |
| `src/services/telegram-service.js` | timeout 10s → 20s | 没有独立证据 | 回退上游 |
| `templates/weixin-instructions.md` | 新增 memory/reentry 使用说明 | 用户核心需求 | 保留，但缩到最小 |

## 4. 已发现的具体代码问题

### 4.1 `resolveDesireHistoryFile()` 在同一文件定义两次

`src/core/app.js` 新增代码中出现两个同名 function declaration。JavaScript 后面的定义会覆盖前面的定义。

即使两个实现当前大多指向同一目录，这也是明确的多轮补丁叠加痕迹。必须合并为一个实现，并测试自定义 `desireHistoryFile` 与默认 stateDir 两种路径。

### 4.2 outage 通知方法是死代码

`enqueueRuntimeOutageSystemMessage()` 被定义，但整个文件没有调用点。

当前 poll 恢复时只写 `lastRecoveredGap`，没有真正 enqueue。因此：

- `runtime_outage` dispatcher 分支大概率无效；
- 相关 100+ 行逻辑增加复杂度但没有实现用户可见功能。

建议整体回退，除非先写一个失败→恢复的可重复测试证明需求存在。

### 4.3 desire history 可能重复写两条

同一个 `desire_state` 可能同时在：

- `handleSystemReplySent()` 以 `source=system_reply_sent` 写入；
- `handleRuntimeTurnCompleted()` 以 `source=runtime_turn_completed` 写入。

去重签名又包含 `note/source`，所以两个内容相同的状态因为 note 不同，**不会被判为重复**。这很可能导致八维历史重复点。

### 4.4 启动时全量 backfill 会扫描所有 conversation JSONL

`backfillDesireHistoryFromConversations()` 在 app 初始化时同步扫描 conversation 目录。

风险：

- 启动时间随聊天历史增长；
- 每次启动都重复做全量解析；
- 本应属于一次性迁移或后台任务，不应卡在 runtime 启动路径。

### 4.5 `deleteWebhook` 不能解决另一个 getUpdates poller

注释声称 deleteWebhook 可以断开 prior process 的 lingering long-poll，从而防止 409。实际上 webhook 与多个 `getUpdates` 实例是不同问题。若旧进程仍在轮询，deleteWebhook 不能替代进程管理。

这类补丁可能掩盖真正的“启动了多个实例”。既然用户不需要并发补丁，建议恢复原版并先只用一个明确启动入口。

### 4.6 stream-delivery 同时做了两种“治重复”操作

- 完全忽略 `runtime.reply.delta`
- 3 秒内相同文本直接丢弃

这会改变上游原本的流式行为，并可能吞掉用户确实需要的连续相同消息。问题应在“为何发送两次”的源头修，而不是末端按文本去重。

### 4.7 Telegram state 从磁盘刷新是在容忍并发写入

`refreshStateFromDisk()` 把磁盘与内存的 offset / seen keys 合并，主要价值是在多进程或外部修改 state 时减少重复。

如果部署原则本来就是只启动一个原版实例，这段逻辑没有必要，反而把错误的多实例状态变成隐蔽行为。

### 4.8 代理 fetch 层有重复的 timeout/Abort 控制器

`fetchJsonWithTimeout()` 已有 controller；`doFetchDirect()` 又创建一个 controller，但存在外部 signal 时使用外部 signal，自建 controller 的 timeout 就不会直接控制 fetch。虽然外层仍可能生效，但结构难懂且不必要。

## 5. 推荐给审查模型的任务

请不要直接重构。请输出：

1. 以 `ecc98cd` 为基线，把上述改动按“回退 / 保留 / 重写为扩展 / 需要复现”分类。
2. 优先给出一个 **最小恢复方案**：
   - 原版 Telegram 收发与 stream-delivery；
   - 保留 DeepSeek + Claude Code 必需配置；
   - 保留 memory workspace 的 prompt 入口；
   - 保留 Windows 启动，但不碰上游业务逻辑。
3. 对 `src/core/app.js` 只做功能块地图，不允许整文件改写。
4. 找出所有调用链与死代码，尤其：
   - Telegram poll health/outage
   - inbound/outbound dedupe
   - auto compact
   - desire history
5. 给出逐步回退顺序与每步 smoke test。
6. 所有建议必须附 rollback，不要一次性提交大 diff。

## 6. 建议的最小 smoke tests

恢复原版核心后至少验证：

1. 单一启动入口启动 TG。
2. 连续发送 10 条普通文本，每条恰好回复一次。
3. 两条完全相同的用户消息均能分别得到响应，不能按文本误杀。
4. 长回复行为与上游一致，不出现 partial + final 重复。
5. 发送图片、文件、语音，能正确形成 inbound 描述。
6. `/new`、原生 `/compact`、resume thread 正常。
7. 新窗口能读取 workspace `memory/reentry.md`，但不触发 Cyberboss 旧 memory 后台写入。
8. 520 面板与 janitor 独立运行；面板故障不能拖垮 TG。
9. 关闭代理环境后 TG 仍按原仓库路径工作。
10. 旧部署完全不动，可立即切回。

## 7. 附件

同分支另有：

- `audit/CORE_RUNTIME_PATCHES_SANITIZED.patch`

这是从本地工作树相对 `ecc98cd` 生成的 16 个核心文件原始 diff，已移除一个硬编码 token。请以 patch 为准审查，不要只靠本文件摘要。
