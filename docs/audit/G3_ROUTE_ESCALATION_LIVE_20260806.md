# Route 2/3 升格链真机交付：从「一次都没通过」到 argv 实证可用

```text
Status: active
Date: 2026-08-06
Base SHA: e60bba3（批次起点 origin/main ee7139f）
Audited SHA: e60bba3
Current authority: docs/CURRENT_STATUS.md
```

## 交付概要

| 项 | 值 |
|---|---|
| 批次分支 | `fix/subject-provenance-carry`（连续做完，未逐个开 PR，D36） |
| 交付次数 | 7 次代码上机（d11–d17）：`4bcc7e6` → `467a2db` → `9857a19` → `f2ba471` → `d35db8c` → `dbbbc17` → `e60bba3`，另有 1 次纯配置重启（route1 两个开关生效） |
| 每次前置 | 本机 PowerShell 14 组 + portability + diff hygiene 全绿，零红上机；回滚 0 次 |
| 生产配置变更 | `telegram.env` 加 2 行（route1 两个开关）；`launch-profiles.json` 加 `escalatedHarness` 与整个 `work-engineering` profile |
| 单次停机 | 20–25 秒 |

## 一句话结论

**Route 2 升格链此前从未成功过一次。** 不是"默认关"，是通路上有多处硬缺陷，任何窗口
调用都必挂。本批修完并在真机上取到 argv 实证；Route 3（带 CC harness 的档）为本批新增
并同样取到实证；Route 1 亦已端到端闭环（见下）。

## 挖出的层（按发现顺序）

| # | 缺陷 | 判据 | 处置 |
|---|---|---|---|
| 1 | `index.js` IPC 处理器调 `route2GateEnabled()`，require 未引入 → 每次必抛 ReferenceError | 真机实测错误码 | 修，T08 A12 |
| 2 | 同处理器读 `context.lane`/`launchProfile`，而子进程侧 `resolveContext` 从不提供 → 恒挂 `route2_window_id_required` | 真机 | 改走 app 层按 `turnId` 反查（同 Route 1 成例） |
| 3 | 升格只活一轮（`turn.completed` 即 revoke）且回收 `closeProcessKey` | 代码 + 真机 | 寿命解绑 turn；busy 时不杀进程 |
| 4 | 升格当场重启子进程，杀掉**提出请求的那一轮** | 真机 `Runtime process exited unexpectedly` | 延后到 turn 边界；D33 原话本就如此 |
| 5 | `attachProcessToSession` 的 `revoke("restart")` 让承载宽面的 relaunch 取消自己承载的授权 | 真机（宽面永远窄面回来） | 删除；lease 权威改为 TTL/交还/strong interrupt |
| 6 | 回收写回的 lease 丢了 `sessionSlotKey`，下次读 `safeId` 抛 → `poll failed` | 真机重启后 | normalize 保留身份；读回死 lease 丢弃不抛 |
| 7 | `process.close` 无条件映射为 `turn.failed` → 任何**故意**关进程都推一条假故障 | 真机 | `close()` 设 `suppressNextCloseEvent` |
| 8 | Route 1 缺 `work-engineering` profile → `route1_origin_turn_unknown` | 真机 | 配置补齐（configRoot 用已登录的 `.claude`，Owner 裁定） |
| 9 | Route 1 任务 workspace 取 chat 的产品树根（**不是 git 仓库**）→ `worktree_provision_failed` | 真机 | 改为继承工程车 profile 的 `cwd` |
| 10 | `parseTaskSessionCapsule` 裸 `JSON.parse` worker 文本 → 干完的活被判 `capsule_invalid_json` | 真机 | 提取放宽、契约不放宽，T09 A9 |
| 11 | `sendTurn` 漏返 `profileFingerprint` → origin route 指纹为空 → **每条结果都标「来自已终结窗口」** | 真机 | 补该字段 |

其中 **#6 与 #7 是本批自己引入或激活的**，单元测试全绿，只有真机重启与真机升格才暴露。

## 真机证据（argv 是唯一判据）

窄面（未升格）：

```
--tools Read,Glob,Grep,Write,Edit,WebFetch,WebSearch    --system-prompt ✓
```

Route 2（`tier: "wide"`）：

```
pid=39616  --tools default  --resume f576654b-…（同一 session）
--system-prompt ✓   --append-system-prompt ✗
lease route2-2af6f8bf… harness=false lane=tg/fable-chat
```

Route 3（`tier: "wide+harness"`）：

```
pid=14712  --tools default  --resume f576654b-…（同一 session）
--system-prompt ✗   --append-system-prompt ✓
lease route2-e0d9b148… harness=true
```

TTL 回落两次实测（`status=revoked`，子进程退休，下轮回窄面）。升格前后 **session 未轮换**
——档位写在 lease 上而非 profile 指纹上。

## 已知且已接受的缺口（本批不修）

1. **门控空转**：`route2_escalate` 的 schema 无 `plan`，IPC 处理器读 `args.plan` 恒为 `{}`，
   故 `decideRoute2Gate` 恒 `within_soft_limit`，`repositoryWork`/`parallel`/`longLoop`
   等硬理由在真实调用链上是死代码。Owner 2026-08-06 裁定：放行原则上没问题，路线本就该由
   她自己判断，门控是成本路由器不是权限闸（同 D33 补注、不变量 3）。另注：`plan` 是模型
   自报，服务端无独立推导来源。
2. **lease 不是白名单**：`assertCapabilityLease` 对不在 `lease.toolNames` 里的工具直接放行，
   而 `toolNames` 恒为空。与第 1 条同源。
3. **Route 1 查询无持久化**：`taskStatus` 读内存 Map，重启后已完成任务查不到，尽管
   `task-results.jsonl` 有落盘行。
4. **失败路径不清理 worktree**：成功路径会移除，失败任务（如 `route1-e541c270-…`）
   留下一棵 641 文件的检出树在盘上，会随失败次数累积。

## Route 1 端到端实证（2026-08-06 23:0x，Owner 在场）

任务 `route1-f1d9e6d7-4e26-4dfe-997f-9ae1fd2aefe5`，`base_sha=d35db8c`，
`allowed_paths=["docs/audit"]`：

```
lifecycle=completed  decision=accept  origin_state=origin_current  source=origin_window
files_changed=["docs/audit/route1-canary-20260806.md"]
tests=[{name:"canary file exists with correct content", passed:true, exit_code:0}]
```

同时实证三件事：**worktree 隔离成立**（产物只在 worktree 内，主工作副本 `git status`
干净、canary 文件不在其中）；**成功路径自动清理 worktree**（该目录已被移除）；
**结果正文不自动注入**，经 `route1_task_result` 由她主动领取。

`origin_state` 由前一次的 `origin_expired` 变为 `origin_current`，即为上表第 11 项
（`sendTurn` 漏返 `profileFingerprint`）的修复实证。

## 待证

episode 写链（G2：签署 → Auto Review → publication intent → History）本批未动。
上机后每次重启 err.log 均出现 `[subject-signing] subject_source_entry_id_missing`
——该诊断码为本批 #180 新增，说明仍有路径拿不到出处、因而签不出候选，属 episode
批次的第一个待查点。
