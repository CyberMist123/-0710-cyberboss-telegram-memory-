# Windows Runtime

> **这份文档只描述稳定结构** —— descriptor 的形状、安装链路的锚定关系、watchdog 的契约。
> 它**不写**当前哪个 release 在跑、计划任务当前是 Ready 还是 Disabled、某次修复的日期。那些属于 `docs/CURRENT_STATUS.md` 与 `docs/archive/`。

生产机是一台长期开机的 Windows，**单后端**。Mac 只做代码编辑与人工查看，不运行 bot、不启用每晚 closeout 作业。

---

## 一、Release descriptor 是唯一事实来源

`deployment/current.json`。**按机器不同，不入版本控制，不跨机同步。** 仓库里只有 `current.example.json`（形状示例）与 `current.schema.json`（校验用）。

必填字段：

| 字段 | 含义 |
|---|---|
| `active_release_id` | 当前活动 release 标识 |
| `telegram_entry` | Telegram 进程入口（`bin/cyberboss.js` 的绝对路径） |
| `config_dir` / `state_dir` / `log_dir` | 三个运行目录 |
| `pid_file` | PID 文件 |
| `watchdog_target` | watchdog 拉起的目标脚本 |
| `last_verified_sha` | 40 位十六进制，schema 强制 |
| `rollback_release` | 回滚目标的完整副本（同样必填上述字段） |

可选：`workspace_dir`、`watchdog_owner_dir`。

**descriptor 里必须同时带着回滚目标。** 一个没有 `rollback_release` 的 descriptor 通不过 schema —— 这是刻意的：切换的同时就得知道往哪退。

---

## 二、安装链路与哈希锚定

```text
release 产物
    │
    ▼
src/orchestration/release-manifest.js          生成 / 校验 manifest
    │   git 校验是关系校验，不是存在性校验：
    │   rev-parse ^{tree} 比对 commit.tree_sha 确为 commit.sha 的 tree
    ▼
scripts/orchestration/release-control-plane.js  安装 descriptor 与启动件
    │   installDescriptor        双锚定
    │   installStartupArtifact   必填 expectedManifestSha256
    ▼
scripts/windows/runtime-startup/install-*.ps1   PowerShell 安装器
    │   install-release-descriptor.ps1
    │   install-runtime-startup-artifacts.ps1   必填 -ExpectedManifestSha256
    │   install-telegram-watchdog.ps1
    ▼
<CYBERLINK_ROOT>\runtime\startup\               真实部署位置
```

**锚定纪律**：manifest 单读一次、检查 BOM、`equalHash` 锚定，验证 / 覆盖检查 / 事后比对全部作用于**同一份 bytes**。中途换 manifest 无法自我认证。

`scripts/windows/runtime-startup/` 是部署区脚本在 git 内的**镜像备份**。改了部署区的脚本要同步拷回这里提交，否则仓库里的版本会悄悄落后于真实运行的版本。

---

## 三、两条不可回退的纪律

来自 R4 终审，违反过一次，代价是"一个诱饵目录就能决定被执行的 Python 文件与密钥路径"。

### 1. 不许向上摸目录找根

`start-telegram.ps1` / `start-dashboard.ps1` **不做祖先回溯**。`CYBERLINK_ROOT` 必须显式设置，脚本会 resolve 并校验其确含 `runtime/` 与 `settings/`，否则 fail-closed。

`watchdog.py` 同理：`--descriptor` 必填，没有 `DEFAULT_DESCRIPTOR`，没有 cwd 兜底。

**生产机启动项必须固化 `CYBERLINK_ROOT`，watchdog 入口必须显式传 `--descriptor`。** 这是切生产的前置条件，不是建议。

### 2. fail-closed 断言必须先证明进程真的跑过

测试里一律用 `assertFailedClosed`：先断言 `result.error` 为空、`status !== null`（证明进程真的启动了），再断言非零退出，失败信息携带 stderr / stdout。

裸写 `assert.notEqual(status, 0)` 在 ENOENT 下恒真 —— "脚本没跑"和"脚本正确退役"不可区分。这条陷阱制造过一整轮假绿。

调 `powershell.exe` 的测试带 `{ skip: !IS_WINDOWS }` 守卫，非 Windows 上诚实 skip。**真实信号只来自 windows-latest CI 或真 Windows 机。** Python 探针类测试不加守卫（那不是平台问题，skip 等于埋掉缺陷）。

---

## 四、Watchdog 契约

`extensions/relationship-memory/launcher/watchdog.py`。

- **Python ≥ 3.10。** 有 `from __future__ import annotations`（低版本导入不炸无解释的 TypeError）+ `enforce_python_floor()`（低版本启动时带明确诊断 fail-closed）。CI 有 3.9 探针守这个行为。
- **重复守卫按精确三元组匹配**，比较前两侧都 `Path.resolve()` 规范化（`same_file_path`）。Windows 8.3 短路径与长路径必须判为同一文件，否则短路径启动的第二个 watchdog 不会被拦下（fail-open）。
- 巡检按 descriptor 拉起 Telegram 进程，机器重启后自愈。

`stable-telegram-launcher.candidate.ps1` 的存活检测做**参数级分词**：要求命令行里出现与 descriptor 规范化后的 `telegram_entry` 完全一致的路径 token，紧跟独立的 `start` token，并排除其后带 `--checkin` / `--help` 的进程与其他目录同名 `cyberboss.js` 的进程。出现多个精确匹配时 fail-closed 抛异常，不默默选一个。

---

## 五、计划任务与回滚

Windows 上的 520 与 memory watchdog 使用仓库内独立 PowerShell 计划任务接线，**不依赖 Te Launcher**。安装与状态见 `docs/WINDOWS_SILENT_STARTUP.md`。

面板用 `python.exe` 隐窗启动而非 `pythonw`：`pythonw` 静默崩溃无迹可寻，且会留下"活着但不监听"的僵尸骗过防重检查。stdout / stderr 落 `runtime\telegram\logs\dashboard.{out,err}.log`。

回滚：

```text
scripts/windows/phase1-switch.ps1     切换到 descriptor 指定的 release
scripts/windows/phase1-rollback.ps1   退回 rollback_release
```

回滚目标来自 descriptor 的 `rollback_release`，不是"上一个目录" —— 所以 descriptor 写错等于回滚路径写错。

---

## 六、CI 与真机的分工

`.github/workflows/phase1-offline.yml` 跑在 windows-latest，`npm run test:orchestration` 覆盖 12 个文件（含全部 release / cutover 测试）。所有步骤经 `scripts/ci/run-annotated.ps1` 执行，失败时把 TAP 失败块写成 run 页面 annotation，**无仓库凭据的环境也能读**。

注意：GitHub 的 pwsh 步骤按结尾的 `$LASTEXITCODE` 判定成败，凡"预期非零退出"的步骤必须显式 `exit 0`。

**CI 绿 ≠ 可以切生产。** windows-latest 不是生产机：路径布局、计划任务、密钥目录、8.3 短路径行为都不同。真机留证是独立的一关，判据见 `docs/CURRENT_STATUS.md` 第五节。

---

## 七、永不入库

```text
deployment/current.json          活动 release descriptor
runtime/                         PID、缓存、lock、live state、日志
memory/                          私人 Episodes / Self-notes / Portrait
settings/secrets/*.local.json    密钥（含 telegram.env）
```

这些**按机器不同**，跨机同步会直接产生错误的生产行为。
