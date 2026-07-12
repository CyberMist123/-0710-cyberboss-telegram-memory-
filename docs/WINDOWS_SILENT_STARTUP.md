# Windows Silent Startup

520 与 memory runtime 使用独立 PowerShell 程序注册为当前用户登录时静默启动的两个计划任务，不依赖 Te Launcher：

- `cyberboss-memory-panel`：只启动 `127.0.0.1:520`；
- `cyberboss-watchdog`：唯一 runtime 自动恢复 owner。

脚本从外部 `deployment/current.json` 解析当前不可变 release、state-dir、workspace 与 watchdog owner，不把任务钉死在开发 worktree。descriptor 可选的 `dashboard_root` 允许 520 单独升级到新的不可变快照而不切换或重启 TG release。520 和 watchdog 保持独立进程树；其中一个停止或失败不会让另一个重启。

```powershell
$script = '.\scripts\windows\continuity-startup.ps1'

# 注册或更新两个任务（不启停当前进程）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Mode Install

# 查看任务状态
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Mode Status

# 取消自启（不停止当前进程）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Mode Uninstall
```

默认会向上查找 `deployment/current.json`。仓库被复制到其他目录时，也可以显式传入：

```powershell
-DescriptorPath '<CYBERLINK_ROOT>\deployment\current.json'
```

Dashboard 启动入口优先使用 `extensions/relationship-memory/memory-kit/dashboard_continuity.py`，旧 `dashboard.py` 仅在新版入口文件缺失时作为回滚后备。任务动作使用 `powershell.exe -WindowStyle Hidden`，子进程优先使用 `pythonw.exe`，并默认禁止登录时自动弹浏览器。

`Dashboard` 与 `Memory` 模式都会先核对各自 PID 文件和命令行，避免重复启动。安装或取消任务不会读取 memory 正文，也不会停止任何已运行进程。

如果现有计划任务由更高权限创建、当前用户无权更新，`Install` 会自动退回到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的两个当前用户启动项。它们仍直接调用同一个独立 PS1，仍然静默且不依赖 Te Launcher。此时应把无法修改的旧 VBS action 保持 inert，避免两个启动 owner 竞争。
