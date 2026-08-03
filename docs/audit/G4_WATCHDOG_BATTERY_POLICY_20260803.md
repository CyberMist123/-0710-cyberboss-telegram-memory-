# G4 监督链留证：电池电源策略导致的静默失岗与修复（2026-08-03）

```text
Status: active
Date: 2026-08-03
Base SHA: 4cb4574（留证时的 origin/main；本文只加证据，不改被述代码）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：`docs/audit/G4_WATCHDOG_RECOVERY_20260731.md`（BOM 事故与首次监督链修复）。本文补的是另一个、与 BOM 无关的失岗根因：**任务计划程序的电源策略**。

## 一、一句话

监督链此前"在两次交付之间是否持续在岗无证据"，本窗查清：**根因是 `cyberboss-watchdog` 计划任务的两个电源开关（`DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries`）为 `True`，机器一旦用电池就被任务计划程序静默停掉、且电池状态下拒绝启动，全程无告警。** 2026-08-03 19:53 已由 Owner 用管理员权限修复（两开关置 `False`）。本窗（22:11–22:14）独立复核：修复保持、watchdog 在岗、并已扛过一次电池→市电切换。**诚实缺口：尚未跨夜、尚未观测到"市电→电池"方向的切换，这两条持续性仍在累积。**

## 二、根因（W9 §5.3 记录 + 本窗独立复核）

- 现象（W9 记）：8-03 交付后 18:02:25 拉起的 watchdog 每 60 秒一条 healthy，**18:31:55 干净断掉**，日志无任何报错行；此后 `schtasks /run` 得 `SUCCESS` 但进程数恒为 0，任务停在 `State=Queued`、`LastTaskResult=0`（不是失败，是压根没跑）。
- 根因（W9 记）：任务设置 `DisallowStartIfOnBatteries=True` + `StopIfGoingOnBatteries=True`，而当时 `Win32_Battery.BatteryStatus=1`（正在用电池）。**切到电池 → 任务被停；电池状态下 → 拒绝启动。全程无告警。** 这也解释了为何交付前 watchdog 长期不在岗、日志停在 2026-07-12——不是某次崩了没人管，是每次机器用电池就自动失效。
- 反证（W9 记）：手工 `python watchdog.py --descriptor ... --interval 60` 直接跑，进程存活、写出 healthy 行——**脚本本身没问题**。

## 三、修复（2026-08-03 19:53，Owner 管理员权限执行）

- 普通权限 `Set-ScheduledTask` 报"拒绝访问"（与 8-01 记的 `Disable-ScheduledTask` 需管理员是同一约束）。**未用"删掉重建"绕过**（有丢失生产监督任务的风险），改为落脚本 `workdesk\tools\fix-watchdog-battery-policy.ps1` 交 Owner 管理员执行；脚本只动那两个开关，触发器/动作/其余设置一概不碰，可重复运行，非管理员时第一步干净退出。

## 四、本窗独立复核（2026-08-03 22:11–22:14，不采信脚本自身输出）

### 4.1 计划任务与电源开关（`Get-ScheduledTask` / `Get-ScheduledTaskInfo`）

```text
Task State                 : Running
LastRunTime                : 2026-08-03 19:53:53
LastTaskResult             : 267009   (0x41301 = 任务正在运行中，正常值)
DisallowStartIfOnBatteries : False    ← 修复保持
StopIfGoingOnBatteries     : False    ← 修复保持
任务动作                    : C:\Python314\pythonw.exe "<CYBERLINK_ROOT>\runtime\app\telegram\extensions\relationship-memory\launcher\watchdog.py" --descriptor "<CYBERLINK_ROOT>\runtime\telegram\descriptor.startup.json" --interval 60
```

**排查提示**：任务用 `pythonw.exe`（无窗口 python），不是 `python.exe`——按 `Name='python.exe'` 过滤进程会误判"watchdog 不在跑"。判活以 watchdog.log 新鲜度为准，不以进程名过滤。

### 4.2 电池状态：已扛过一次电池→市电切换

```text
Win32_Battery.BatteryStatus = 2   (市电)
```

W9 修复时为 `1`（电池）。两次采样之间发生过 **电池→市电** 切换，而任务仍 `Running`、两开关仍 `False`——这正是修复要扛的一类转换，扛住了。（注：真正会触发 `StopIfGoingOnBatteries` 的是相反方向"市电→电池"，本窗未观测到，见第五节。）

### 4.3 watchdog.log 连续性（`runtime\app\telegram\...\launcher\watchdog.log`，活日志）

```text
healthy 行总数 : 169
首条           : [2026-08-03 18:02:25] healthy active release cyberlink-unified-runtime-221a2c: pid <PID> matches <CYBERLINK_ROOT>\runtime\app\telegram\bin\cyberboss.js
修复起点       : [2026-08-03 19:53:42] healthy ... pid <PID> matches ...
              [2026-08-03 19:54:44] healthy ...
              [2026-08-03 19:55:45] healthy ...   （此后每 ~60s 一条，连续）
末条           : [2026-08-03 22:14:25] healthy active release cyberlink-unified-runtime-221a2c: pid <PID> matches <CYBERLINK_ROOT>\runtime\app\telegram\bin\cyberboss.js
```

- 18:02→22:14 之间 healthy 计数 169 < 该时段应有分钟数，**断口在 18:31–19:53**（即 W9 记的电池策略失效那 ~82 分钟，属修复前，符合叙述）。19:53 修复后至今连续。
- 每条 healthy 都在核 `pid <PID> matches <CYBERLINK_ROOT>\runtime\app\telegram\bin\cyberboss.js`——TG 主进程（8-03 18:01:57 交付起）持续被判活。

### 4.4 一次瞬时失败并自愈（诚实记录）

```text
[2026-08-03 21:57:06] check failed (will retry): TimeoutExpired: Command '[...Win32_Process -Filter 'ProcessId=<PID>'...]' timed out after 10 seconds
[2026-08-03 21:58:08] watchdog recovered: descriptor and active release are healthy
```

21:57 有一次 PID 检查子命令 10 秒超时（`check failed (will retry)`），**下一轮 21:58 即 `watchdog recovered`**。这不是电池策略问题，是一次瞬时系统负载导致的子命令超时、watchdog 自身重试机制已覆盖。记此以示"连续"不等于"零瞬断"。

## 五、诚实缺口（尚不能下的结论）

1. **未跨夜。** 修复 19:53，复核 22:14，同一晚间，约 2 小时 20 分。"跨过整晚仍在岗"无证据。
2. **未观测到"市电→电池"方向切换。** `StopIfGoingOnBatteries=False` 真正要拦的是这个方向；本窗只见到电池→市电。修复置 False 从设置层面已消除该风险，但**运行时行为证据**仍缺一次真实的市电→电池转换。
3. 结论：**G4 该行只升到"根因已明 + 已修复 + 起于电池已证 + 跨电池→市电已扛"，不升到"跨夜/切回电池持续在岗已证"。** 后者留待下一次跨夜 + 电源切换后补证。

## 六、脱敏规则（协议坑 24）

本文所有摘录为原样命令输出，仅做如下机械替换，**除此之外逐字未改**：

- 本机仓库根绝对路径 → `<CYBERLINK_ROOT>`
- 生产 bot 进程号真值 → `<PID>`（CLAUDE.md 第四节：PID 不入库）

替换后本文经 `node scripts/portability-check.js` 复跑两次（第二次把 `USERNAME` 环境变量临时设为 CI runner 用户名，手法见协议坑 22），均 exit=0（见本窗判断记录原始证据）。
