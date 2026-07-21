# runtime\startup 脚本备份(部署区收编)

真实部署位置:`C:\Users\18717\Documents\cyberlink\runtime\startup\`
此目录是其在 git 内的镜像备份——**改了部署区脚本,请同步拷回这里提交**(后续由 GitHub 提交自动化接管)。

## 计划任务现状(2026-07-22)

| 任务 | 状态 | 说明 |
|---|---|---|
| cyberboss-watchdog | Ready(7-22 启用) | 60s 巡检,按 descriptor 拉起 tg,重启后自愈 |
| cyberboss-memory-panel | Ready | 登录时拉 520 面板(start-dashboard.ps1) |
| cyberboss-tg-line | Disabled | 指向旧 deepseek 启动器,**勿启用** |
| cyberboss-wechat-line | Ready | 微信线(旧 workspace,待迁移) |

## 2026-07-22 修复记录

- `start-dashboard.ps1`:pythonw 静默崩溃无迹可寻且会留下"活着不监听"的僵尸骗过防重检查 → 改用 python.exe 隐窗启动,stdout/stderr 落 `runtime\telegram\logs\dashboard.{out,err}.log`
- `cyberboss-watchdog` 计划任务由 Disabled → Ready(此前重启后 tg 无人拉起)
- `settings\secrets\telegram.env`(不入库):`CYBERBOSS_ENABLE_DESIRE`、`CYBERBOSS_DESIRE_DRIVEN` 由 0 → 1(八维停摆根因),原文件留有 .bak-20260722
