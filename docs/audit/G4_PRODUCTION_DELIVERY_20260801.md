# G4 真机交付留证：2026-08-01 第二次交付——监督链在位下的热交付 + /pause activity 上机

```text
Status: active
Date: 2026-08-01
Audited SHA: 6fb078e（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：第一次交付见 `G4_PRODUCTION_DELIVERY_20260730.md`，监督链修复见 `G4_WATCHDOG_RECOVERY_20260731.md`。

## 一、这次交付了什么

方案 A（同 7-30）：只搬代码，不换启动机制。这是**监督链修复后的第一次交付**——流程比 7-30 多了"先停监督、后停进程"和"descriptor 写真话"两步。

| 项 | 值 |
|---|---|
| 目标 SHA | `6fb078e`（部署时的 `origin/main`） |
| 此前生产 SHA | `48660a9`（2026-07-30 交付，7-31 由监督链修复留证确认） |
| 落差 | 29 个提交，全部经真实 CI（windows-latest）合入 |
| 交付动机 | `/pause activity` / `/continue activity`（e3ed3e7）上机；Owner 要求暂停自主心跳 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260801`（瞬时，回滚也瞬时） |
| 行为面变化 | 仅新增暂停命令；其余新能力（catalog / handoff / signing / G3 preflight / review artifacts）全部默认关，关闭时逐字节兼容基线，生产 secrets 未动 |

## 二、预交付验证（暂存目录，生产未被触碰）

从 `origin/main` 用 `git archive` 导出干净树，`npm ci` + `npm install` 后跑主 CI 全部 **14 个分组**（较 7-30 多出的 5 组为此后接线的 memory-services / reflect / 520-endpoints / catalog-metering / p0-closeout-liveness）：

- **12 组绿**（含 7-30 曾环境性失败的 phase4：本次 node + python 全过）。
- **2 组红，均定性为环境因素，逐条有据**（部署树按 7-30 决定不带 `.git`）：
  1. `test:phase1` 111/112，唯一失败 = portability static check——`git ls-files` 无仓库必炸，与 7-30 同签名；
  2. `test:520-endpoints` 唯一失败 = `test_gitignore_covers_private_secret_files`——`git check-ignore --no-index` 仍要求仓库上下文，暂存树 exit=128；同一命令与整份测试文件在工程仓库实测通过。

环境核对：node = `C:\Program Files\nodejs\node.exe` v24.15.0，与生产启动脚本同一可执行文件。

## 三、交付时序（本地 2026-08-01）

| 时刻 | 动作 |
|---|---|
| 19:14 | `schtasks /end` 终止 watchdog 计划任务并杀 watchdog 进程（`Disable-ScheduledTask` 需管理员被拒；该任务登录触发，不会自行重跑，风险窗口仅换树数秒）；杀 bot 进程，确认双亡 |
| 19:15 | 换树；预置 `<state_dir>\activity-pause.json` = `{"version":1,"paused":true,...}`（UTF-8 无 BOM，与 `/pause activity` 命令写入的形状逐字段一致）——**新进程从首个 tick 起即暂停态** |
| 19:15 | descriptor 备份 `descriptor.startup.json.bak-20260801-predeploy` 后仅改 `deployed_sha` → `6fb078e…`（保持无 BOM）；`last_verified_sha` / `verification_mode` 未动（本次同样不是 verified 交付，不伪造验证记录） |
| 19:16 | 首次启动**崩溃**：`MODULE_NOT_FOUND whereabouts-mcp`（见第四节坑 3） |
| 19:17 | 重建链接后启动成功：`bridge loop started; waiting for Telegram messages`，err.log 零新增 |
| 19:17 | 干跑部署树 watchdog：descriptor 解析成功，`active_release_alive` = `True`（pid 与运行树入口匹配）；`Start-ScheduledTask` 恢复监督 |
| 19:17:57 | watchdog 打出对新树的第一条 `healthy active release`——**监督链全程闭环** |

## 四、坑 3 · junction 绝对路径在树改名后断裂（新，下次交付必读）

7-30 坑 2 的变种：`npm install` 把 `file:vendor/whereabouts-mcp` 链成**绝对路径 junction**，目标指向暂存目录 `telegram.new-*\vendor\...`。树改名为 `telegram` 后 junction 悬空——**`Test-Path` 仍返回 True**（reparse point 存在），但 `require` 解析失败，进程起不来。

- **修法**：树到最终位置后 `cmd /c rmdir node_modules\whereabouts-mcp` + 重跑 `npm install`；
- **硬检查升级**：7-30 写的 `Test-Path` 检查不充分，应改用 `require.resolve("whereabouts-mcp", { paths: [<部署树>] })`；
- **根治**：依赖安装挪到换树**之后**，或换树后一律重跑 `npm install`。

## 五、没做到的 / 保持原状的

- `deployment\current.json` 三套真相问题原样（#77）；方案 B（正规发布包机制）仍未启用；`start-telegram.ps1` 仍硬编码。
- 未开任何行为开关；`CURRENT_STATUS.md` 各 `UNKNOWN` 生产接线判断不因本次交付改变。
- `/pause activity` 的**命令级真机证据**尚缺：本次是文件预置进入暂停态，`/continue activity` 的首次真机执行由 Owner 在 Telegram 验收（届时才可谈 `VERIFIED`）。
- 7-30 留证 5.4 的 D20 泄漏面取证仍未做（判定方法不变：看 Telegram 回复开头有无工程 sync 行）。
- `runtime\app\` 下发现历史遗留空目录 `telegram$f`（疑似 PowerShell 插值事故产物），未清理，待 Owner 裁决。

## 六、回滚路径

1. `schtasks /end /tn cyberboss-watchdog` + 杀 pid 文件所指进程
2. 删 `runtime\app\telegram`（新树），`telegram.bak-20260801` 改名回 `telegram`
3. descriptor 恢复 `descriptor.startup.json.bak-20260801-predeploy`
4. 执行 `start-telegram.ps1`，`Start-ScheduledTask cyberboss-watchdog`
5. Telegram 说一句话确认应答。旧版本无暂停功能，`activity-pause.json` 对其无副作用，可留可删。

## 七、对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 | `PARTIAL` | 仍 `PARTIAL` | 第二次成功交付 + 首次监督链在位的热交付（本文），交付流程可复现度提高；#77（部署身份单一真相、方案 B）仍未处理 |
| G1 / G3 / G5 | 各自不变 | 不变 | 本次不触及其证据面 |

**切生产判据逐条**：不因本次交付改变任何一条的满足状态。仍不得切生产。
