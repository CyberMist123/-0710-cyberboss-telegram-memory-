# G4 生产交付留证：d28/d29（主体节拍 E2 + timeline 发布链 E3）

```text
Status: completed
Date: 2026-08-09
Base SHA: d28=75756a77…、d29=5e20b64d…（batch/phase2-e2e3）
Current authority: docs/CURRENT_STATUS.md
```

## 交付内容

D42 主体节拍调度（consolidation 并入八维菜单 + reflect 每 N 天专用敲门）与
D43 timeline 候选发布链。Owner 当日两次裁定：①consolidation 不单独敲门，整理一句并进
desire_checkin 菜单，每日专用闹钟默认关；②reflect 每 3 天（生产 `_INTERVAL_DAYS=3`）。

## 预交付测试（真 Windows 本机）

全部 `test:*` 分组绿；唯一红 = release-manifest 9 条 tar 环境噪声（历次一致）。
phase1 含新调度器测试、phase3 含 timeline 发布测试，均阻塞主 CI。

## 部署与真机验证时间线（全部本机时间，机器时区=悉尼）

1. **d28（75756a7）22:37 上线**：D5 活树字节比对 164 文件 0 差异；watchdog 恢复。
2. 首敲未发生 → 排查发现**activity pause 闩自 2026-08-07 起一直 paused**（Owner 两天前
   /pause_heartbeat 未恢复）——调度器按设计被总闩拦截，这条暂停通路当场真机实证。
3. Owner 真机发 /continue_heartbeat（13:03:33Z 落盘）→ **10 秒后 reflect 系统 turn 开窗**
   （trace 13:03:43Z opening=true，E1 portrait 块同场注入）；beat state 记
   `reflect.dateKey=2026-08-09`，队列排空，err.log 零异常。恢复即敲验证通过。
4. 复盘发现**忙转缺陷**：到点未成敲期间（暂停/重叠）`nextScheduleAt` 停留在过去，
   差值取 0 → setTimeout(0) 自旋（22:49–23:03 实测自旋 14 分钟）。当日修：过期重排
   垫 60 秒，回归测试钉住非零延迟。
5. **d29（5e20b64，含忙转修复）23:06 上线**：D5 字节比对 0 差异，bridge/watchdog 恢复；
   同批撤掉验证用临时 `CYBERBOSS_REFLECT_HOUR=0`，回默认 20:30。下一次 reflect 敲门
   预期 2026-08-12 20:30（automationTimezone）。

## 生产配置变更

`telegram.env`（备份 `*.bak-20260809-d28-pre`）：`CYBERBOSS_REFLECT_TRIGGER_ENABLED=1`、
`CYBERBOSS_REFLECT_INTERVAL_DAYS=3`。consolidation 闹钟开关未加（默认关）。

## 结论

E2 能力行 `WIRED/COVERED/BLOCKING/VERIFIED`；timeline 通路 `WIRED`（离线闭环，真机
发布留证待第一条真实 timeline 候选）。desire 菜单句随下一个整点唤醒生效，无需另验。
