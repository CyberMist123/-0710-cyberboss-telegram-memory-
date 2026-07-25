# runtime\startup 脚本备份(部署区收编)

真实部署位置:`<CYBERLINK_ROOT>\runtime\startup\`
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

## 2026-07-25 stable-telegram-launcher.candidate.ps1 硬化(分支 `fix/production-cutover-blockers`)

- 首次把 `stable-telegram-launcher.candidate.ps1` 收编进本镜像目录(此前只存在于部署区,未入库)。
- 修复 `Test-ExistingTelegramPoller`(此前忽略自己的 `-Entry` 参数,只按 `cyberboss\.js ... start` 做宽松子串匹配,`start --checkin` 会被误判为在跑的正式轮询进程):现在它与 PID 文件快速路径都会对候选进程的命令行做参数级分词,要求出现与 descriptor 规范化后的 `telegram_entry` 完全一致(大小写不敏感)的路径 token,紧跟一个独立的 `start` token,并排除其后出现 `--checkin`/`--help` 或属于其他目录同名 `cyberboss.js` 进程的情况。出现多个精确匹配时 fail closed(抛出异常),不再默默选一个。
- 本次改动未触碰任何计划任务、`deployment\current.json` 或现网存活进程(Telegram PID 24284 / watchdog PID 10424);配套 dry-run 测试矩阵见 `fix/production-cutover-blockers` 分支的 `test/stable-telegram-launcher.test.js`。
