# G4 第八次真机交付：catalog invoke 上机 + 目录开关首次在生产打开

```text
Status: audit
Date: 2026-08-05
Base SHA: 3447ffd（full 3447ffd3a2d253c4dbca42c78119564c442e88ce）
Audited SHA: 3447ffd
Current authority: docs/CURRENT_STATUS.md
```

## 一、交付概要

| 项 | 值 |
|---|---|
| 目标 SHA | `3447ffd` |
| 此前生产 SHA | `a0e9e8a`（descriptor 与活代码树标记一致，本次未出现元数据说谎） |
| 落差 | 4 个 PR：**#162**（D34 catalog invoke）、**#164**（目录索引资源补调用用法）、**#165**（六个空转 profile 字段改按 profileId 派生）、**#163**（外部 MCP 文件夹注册表 T-I） |
| 交付动机 | 让"目录里的工具可见不可调"这条缺环在生产上真的闭合 |
| 备份方式 | 树重命名 `telegram` → `telegram.bak-20260805-d8`；`telegram.env`、两份 profile 资产、descriptor 均先备份 |
| 行为面变化 | **本次动了三处生产配置**：profile 两份资产剥六键（随 #165 必须同批）、`telegram.env` 新增 `CYBERBOSS_TOOL_CATALOG_ENABLED=1`（见第四节）。两个 route2 开关仍**保持关闭** |
| 停机窗口 | **20:44:04 – 20:48:59，约 4 分 55 秒**（含一次失败启动，见第三节） |
| 二次重启 | 20:54:37 – 20:55:12（开目录开关，约 35 秒） |

## 二、预交付验证（源真相仓库 3447ffd，13/13 全绿）

PowerShell 跑 `phase1-offline.yml` 全部 13 组，逐组 `exit=0`，另加 `node scripts/portability-check.js` `exit=0`。流水：`workdesk\20260805-predeploy8-verify.log`。暂存树 `git archive 3447ffd` → `tar.exe` 解出 634 文件，`npm ci` exit=0，树内 `require.resolve('whereabouts-mcp')` 落在暂存树内。

同 SHA 的 GitHub CI（windows-latest）四项全绿。

## 三、本次踩到的新坑：robocopy /MOVE 会吃掉 vendor 目录

**坑 2/坑 3 的一个新变体，值得单独记。**

换树第一步 `Rename-Item live → bak` 成功，第二步 `stage → live` 反复报"being used by another process"——**占用者是会话自己的 PowerShell 工作目录**（前一条命令 `Set-Location $stage` 后 CWD 一直留在暂存树里；PowerShell 工具的 CWD 跨命令持久）。此时服务已停，不能干等，改用 `robocopy /E /MOVE` 搬内容。

搬完出现两次 `MODULE_NOT_FOUND`：

1. `whereabouts-mcp` —— `node_modules\whereabouts-mcp` 是指向 `vendor\whereabouts-mcp` 的 junction，**robocopy 遍历 junction 时把目标内容当成源搬走了**，结果 `vendor\whereabouts-mcp` 整个消失、junction 悬空。
2. `timeline-for-agent` —— 同一原因，第一次启动就是死在它上面（err.log 20:47:27 那条）。

两者都从源真相仓库 `vendor\` 原样补回（`git status` 确认源仓库 vendor 干净），补完 `require.resolve` 均落回 `runtime\app\telegram\vendor\...`，与历次交付形状一致。

**教训（给下次）**：换树只用 `Rename-Item`；换之前先把会话 CWD 挪出暂存树。真要用 robocopy，必须加 `/XJ`（排除 junction），否则它会顺着 `node_modules` 里的链把 `vendor\` 搬空——而 `package.json` 的两个 `file:vendor/...` 依赖全靠那个目录。

## 四、本次动的三处生产配置

1. **`fable-chat-profile\launch-profiles.json`** 删六键（`residentToolSchemas` / `mcpServerCeiling` / `toolsetCeiling` / `defaultMcpServerSet` / `defaultToolset` / `envPolicy`），剩 15 键。**随 #165 必须同批**：新代码 + 未剥键 = `unknown_field` 启动即拒，旧代码 + 已剥键 = `invalid_type` 启动即拒，两向均已在交付前实测复现（`workdesk\20260805-tg-deploy-runbook-profile-strip.md`）。剥键前后 argv / env 键集 / `launchFingerprint` 逐字节相同（`e209aeea…`），session slot 未轮换。
2. **`launch-profiles.schema.json`** 的 `required` 同步删六项，剩 12 项。
3. **`telegram.env` 新增 `CYBERBOSS_TOOL_CATALOG_ENABLED=1`**——**这是目录第一次在生产上打开**。此前该键在生产 env 里**根本不存在**（默认关），意味着 D34 之前的所有目录相关代码在活体上一直是休眠的。备份 `telegram.env.bak-20260805-d8-precatalog`，写回前后首 3 字节均 `65,76,76`（无 BOM），仅追加一行。

`CYBERBOSS_ROUTE2_GATE_ENABLED` 与 `CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED` 仍未设置（D33 两轮制，本次只动目录这一个变量）。

## 五、实机验收：服务端已证，行为面待 Owner

### 已证（生产机 / 生产树 / 生产 env）

用活体树的 `bin/cyberboss.js tool-mcp-server` 起一个独立实例（不打扰在跑的那个），喂真 JSON-RPC：

| 判据 | 目录关（交付前形状） | 目录开（本次形状） |
|---|---|---|
| `tools/list` | 31 个工具，**13,811 字节** | **3 个**：`cyberboss_catalog` / `cyberboss_system_send` / `cyberboss_time`，**798 字节** |
| 一级目录 | —— | 八主题正常，`记忆(3)` 含 `memory_candidate_submit`（signing 开着） |
| **catalog invoke** | `Unknown tool: cyberboss_catalog` | **`{handle:"memory/memory_lookup", arguments:{…}}` → `isError=false`，返回 `Memory lookup completed with no matching record.`** |
| 调用后 `tools/list` | —— | 与调用前**逐字节相同** |

**这是 D34 在生产机上的第一次实证**：一个从未被 `tools/list` 广播过的工具，经 catalog invoke 真的被调用了，且广播面不变（前缀缓存不失效）。

顺带补上 T-E 的 MCP 半边：目录开/关的 MCP 工具面摆动实测 **798 vs 13,811 字节**（约 17×）。此前 `20260805-production-shape-request-probe.md` 量的是 `--tools` 内建面（5 个 7,138 字节），两半至此齐了。

### 待证（需要 Owner 实机互动）

**她自己会不会用**——这是唯一没法由服务端证明的部分。判据与观察项见 `workdesk\20260805-canary2-addendum-d34-tg.md` 的 F/G/H：让她做一件需要非常驻工具的事（记日记、设提醒都不在常驻 3 工具里），**不提示她用 catalog**，看她能不能自己走完"翻主题 → 拿 handle → 带 arguments 调"。卡在"看得到调不了"即为不过，届时按 `DECISIONS.md` C9 评估 `listChanged` 二期。

## 六、交付时序

| 时刻 | 动作 |
|---|---|
| 20:44:02 | D1 停监督：`schtasks /End` SUCCESS；**注意 watchdog 跑的是 `pythonw.exe` 不是 `python.exe`**，按后者过滤会误判为 0 |
| 20:44:04 | D2 停 TG：先按命令行匹配活体树核对，pids 29216/1928/27880 + 子进程，`taskkill /F /T` 全 SUCCESS；3 秒后 remaining=0 |
| 20:44:23 | D3 `live → bak` 成功；`stage → live` 因会话 CWD 占用连续失败（6 次重试） |
| 20:45:42 | D3c 改 `robocopy /E /MOVE`，exit=1（有文件复制=成功），`bin/cyberboss.js` 就位 |
| 20:46:53 | D4c 补回 `vendor\whereabouts-mcp` |
| 20:47:25 | D6 第一次启动 → **失败**：`Cannot find module 'timeline-for-agent/package.json'`（err.log 20:47:27，size 23631 → 24024） |
| 20:48:20 | D4d 补回 `vendor\timeline-for-agent`，两个 `file:` 依赖均 resolve OK |
| 20:48:28 | D6b 第二次启动 → 成功；20:48:59 实测 `bridge loop started`、desire poller 起、**`tool-mcp-server` 持续存活** |
| 20:49:16 | D8 恢复监督（`BatteryStatus=2` 市电）；20:49:18 起连续三次 `healthy … pid 8600 matches` |
| 20:54:22 | W5 `telegram.env` 追加目录开关 |
| 20:54:37 | D10 重启拾取开关；20:55:12 bridge pid 16244 + tool server pid 20728 起；20:55:14 watchdog `healthy … pid 16244` |

**`cyberboss.err.log` 自 20:47:27 那条失败启动之后零新增**（两次成功启动均无错误）。逐行流水：`workdesk\20260805-delivery8-transcript.log`（会话中转，非权威）。

## 七、回滚

三层，必须一起回：

1. 树：`telegram` ↔ `telegram.bak-20260805-d8` 改名（瞬时）。
2. profile 两份资产：`.bak-20260805-d8` 覆盖回去（六键加回）。
3. `telegram.env`：`.bak-20260805-d8-precatalog` 覆盖回去（目录开关消失）。

只回其中一层都会 fail-closed（第四节已实测两个方向）。descriptor 的 `deployed_sha` 回填 `a0e9e8a…`，备份在 `descriptor.startup.json.bak-20260805-d8-predeploy`。

只想关目录、不回滚代码：删 `telegram.env` 那一行重启即可——代码侧目录关闭时与基线逐字兼容（`test:catalog-metering` 的 A1 用例钉着）。
