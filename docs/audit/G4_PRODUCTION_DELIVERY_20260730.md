# G4 真机交付留证：2026-07-30 第一次把 main 搬上生产 Telegram 运行时

```text
Status: active
Date: 2026-07-30（证据补记与复核 2026-07-31）
Audited SHA: 48660a9（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。

存在的理由：`CURRENT_STATUS.md` 第五节切生产判据第 2 条要求「真 Windows 生产机的 release/cutover 测试完整输出已归档进 `docs/audit/`」。本文补的就是这一条，同时如实记录**哪些没做到**。

---

## 一、这次交付了什么

方案 A —— **只搬代码，不换启动机制**。只替换 `runtime\app\telegram\` 这棵树的内容；watchdog、计划任务、`start-telegram.ps1`、描述文件一个字不改。

| 项 | 值 |
|---|---|
| 目标 SHA | `48660a9`（部署时的 `origin/main`） |
| 此前生产 SHA | `221a2c5`（2026-07-12） |
| 落差 | 157 个提交 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260730`（瞬时，回滚也瞬时） |
| 启动时刻 | 2026-07-30 15:03:40（首次，pid 37908） |

选方案 A 而不是方案 B（启用正规发布包 + 候选启动器 + `install-descriptor`）的理由：第一次交付要窄。方案 B 要同时动代码、启动器、描述文件机制三个变量，出问题无法归因。**方案 B 才是 G4 的完整形态，留作第二步。**

## 二、预交付验证（暂存目录，生产未被触碰）

从 `origin/main` 用 `git archive` 导出干净树到 `runtime\app\telegram.new-20260730`，`npm ci` 后跑主 CI 的全部分组：

| 分组 | 结果 |
|---|---|
| `check`（语法） | 全过 |
| `test:phase1` | 119/120 |
| `test:phase2` | 14/14 |
| `test:phase3` | 28 通过 0 失败 |
| `test:phase4` | node 23/23 |
| `test:phase5a` | 9/9 |
| `test:route-lanes` | 152/152（2 skip） |
| `test:telegram-media` | 37/37 |
| `test:orchestration` | 112/112 |

约 375 个测试通过。三处失败**全部定性为环境因素，逐条有据**：

1. **`portability static check`（phase1）** —— 该检查靠 `scripts/portability-check.js` 的 `git ls-files` 列文件，而暂存树用 `git archive` 导出、**故意不带 `.git`**。对照实验：同一检查在有 `.git` 的工作树上 `Portability check passed.` exit=0。→ 失败由「缺 `.git`」单独导致，与代码无关。
2. **python `gbk` 解码错（phase4）** —— 中文 locale Windows 的 Python 默认编码问题，出现在 dashboard 黑盒测试的输出环节。node 侧 23/23 全过。
3. **`tar: Cannot connect to C:`（orchestration）** —— Git-Bash 把 `C:\` 当远程主机名。改用 PowerShell 重跑即 112/112 全绿；真实 CI 本来就走 `scripts/ci/run-annotated.ps1`（PowerShell）。

**环境核对**：`npm ci` 用的 node = `C:\Program Files\nodejs\node.exe` = v24.15.0，**与生产启动脚本用的是同一个可执行文件**，无原生模块版本风险（8 个 `.node` 均为预编译 napi 二进制）。

**补充信号**：这 157 个提交在合并时都过了真实 CI（windows-latest）。

### 部署树不带 `.git` —— 这是决定，不是疏漏

部署树是**产物**不是工作副本；现有生产树那个 `.git` 已是断链孤儿，且指向的登记位现归工程工作副本所有，是个陷阱，趁这次清掉。运行时不需要 git（已核：`src/` 内调 git 的只有 `orchestration/delegation/git-workspace.js` 与 `release-manifest.js`）。

**已知限制**：`git-workspace.js` 确实调 git，它属 Codex 委派路径。按 `CURRENT_STATUS.md` 该路径对主 Chat 是 `NOT_WIRED`，因此不会被触发；**若将来接通委派，需重新评估部署树的 git 需求。**

## 三、交付过程中踩到的两个坑

两个都不是新代码的缺陷，是交付方案的缺陷。记在这里供下次复用。

### 坑 1 · `Enable-ScheduledTask` 不等于启动它

`cyberboss-watchdog` 的触发器是**登录时触发**（`Get-ScheduledTask` 显示 UserId 有值、无 StartBoundary、`NextRunTime` 为空）。原本那个 bot 进程是长驻进程；杀掉之后 `Enable-ScheduledTask` 只解除禁用、**不产生任何触发**，服务一直停着，看起来像「新代码起不来」，实际是「压根没被启动」。

**正确做法**：`Enable-ScheduledTask` 之后必须再 `Start-ScheduledTask`。

**诊断要点**：分辨「没启动」与「启动失败」看两处 —— `Get-ScheduledTaskInfo` 的 `LastRunTime` 是不是刚才，以及 `logs\cyberboss.err.log` 的 `LastWriteTime` 有没有变。**两者都没动 = 没启动，不是失败。**

### 坑 2 · `npm ci` 不链接 vendor 里的 `file:` 本地包

`package.json` 声明 `"whereabouts-mcp": "file:vendor/whereabouts-mcp"`。`npm ci` 报 `added 188 packages` 却跳过了这一个，`node_modules\whereabouts-mcp` 不存在 → `src/tools/tool-host.js` 的 `require("whereabouts-mcp")` 抛 `MODULE_NOT_FOUND`，整个进程起不来（调用链 `bin/cyberboss.js → src/index.js → core/app.js → tools/create-project-tooling.js → tools/tool-host.js`）。旧树的 `node_modules\whereabouts-mcp` 是有的（2026-07-12 装的），所以只在**新铺的树**上出现。

**修法**：部署树里跟一次 `npm install`（把它链成指向 `vendor\whereabouts-mcp` 的 Junction）。**依赖安装步骤应为 `npm ci` 然后 `npm install`**，并在铺树后硬检查 `Test-Path <部署树>\node_modules\whereabouts-mcp` 必须为 True。

## 四、交付结果：代码链成功

启动日志（2026-07-30 15:03:40）：

```text
[cyberboss] workspaceRoot=C:\Users\18717\Documents\cyberlink
[cyberboss] runtimeEndpoint=C:\Users\18717\.local\bin\claude.exe
[cyberboss] bridge loop started; waiting for Telegram messages.
[desire] poller starts, next planned tick in 21m
```

**2026-07-31 复核实测**：

| 检查 | 结果 |
|---|---|
| bot 进程 | pid 12184，2026-07-30 15:12:44 起，存活 10 小时 |
| Telegram 实际服务 | `logs\cyberboss.log` 写到 20:55:55，15:12 之后有 65 条 turn/reply 记录 —— **真的在应答，不只是进程活着** |
| `whereabouts-mcp` 链接 | `node_modules\whereabouts-mcp` 存在 |
| 备份树保留 | `runtime\app\telegram.bak-20260730` 在位 |
| watchdog 计划任务 `--descriptor` | **显式传了**（切生产判据第 4 条形式上满足） |
| `CYBERLINK_ROOT` / `workspaceRoot` | 启动日志显示 `workspaceRoot=...\cyberlink`，与修正后的描述文件一致 |

**结论：代码交付成功。** 这是第一次真机 release 留证。

## 五、没做到的（同等重要，别只读第四节）

### 5.1 监督链是死的 —— bot 现在无人监督地在跑

**这是本次交付最重要的负面发现，且当前仍在生效。**

- `runtime\telegram\descriptor.startup.json` 带 **UTF-8 BOM**（实测 2219 字节，前三字节 `EF BB BF`）
- 今天部署上去的加固版 `watchdog.py` 的 `load_descriptor()` 对 BOM **明确 fail-closed**：`raise ValueError("release descriptor must be UTF-8 without BOM")`
- 实测：拿部署树那份 `load_descriptor` 跑线上描述文件 → `FAILED: ValueError release descriptor must be UTF-8 without BOM`
- 线上 `runtime\telegram\watchdog.log`（最后写入 2026-07-30 15:01:19）：
  `check failed (will retry): ValueError: release descriptor must be UTF-8 without BOM`
- watchdog 进程 pid 19064 自 15:01:18 存活并每 60 秒重试，**每次都失败**

**所以 bot 是被直接拉起的，不是 watchdog 拉起的** —— `start-telegram.ps1` 对 descriptor 有 **0 处引用**，硬编码一切，因此完全不依赖描述文件即可启动。**bot 若崩溃，没有任何东西会重启它。**

这是 2026-07-23 停机根因的直接延续：旧 watchdog 崩在同一个 BOM 上（备份树日志 `Unexpected UTF-8 BOM (decode using utf-8-sig)`，7-27 起每分钟一条），加固版改成**故意**拒绝并给出清晰错误 —— 诊断信息变好了，可用性结果一样。

**为什么本次没顺手修**（去掉 3 字节即可）：

1. `runtime/` 是安全边界内的禁区，需要 Owner 明确授权；
2. **备份那份 `descriptor.startup.json.bak-20260730` 同样带 BOM**（2244 字节，BOM=True），所以「退回描述文件」不是解法；
3. 真实风险：BOM 一旦去掉，watchdog 会开始正常工作并调 `active_release_alive(descriptor)` 判断。而描述文件的 `deployed_sha` 仍是过期的 `221a2c59`、`watchdog_target` 指向 `runtime\startup\start-telegram.ps1`。若它判定「没活着」就会 `launch_active_release()`，**可能拉起第二个 bot 实例，两个 bot 轮询同一个 Telegram 账号**。

**修复必须连同 5.2 的身份问题一起做，不能单独去 BOM。** 归属 issue #77。

### 5.2 部署身份三套真相，且这次交付让它更不准了

| 来源 | 它声称的身份 |
|---|---|
| `deployment\current.json` | release `phase25a-desire-claude-993d57f`，入口在 `releases\cyberboss-phase25a-993d57f\`，workspace 指向 `cyberboss-deepseek-workspace`，还留着 2026-07-12「Owner 本人豁免 Telegram canary」的记录 |
| `runtime\telegram\descriptor.startup.json` | `deployed_sha` = `221a2c59...`（2026-07-12 那次） |
| 实际运行的树 | 从 `48660a9` 导出 |

三者互不一致，且**本次交付换了代码却没动任何一个身份文件**（方案 A 明确不动描述文件），因此描述文件现在主动地在说谎。回滚话术里「确认 `deployed_sha` = `221a2c59...`」这类校验因此不可靠。归属 issue #77。

### 5.3 方案 B 未走

正规发布包机制（`install-descriptor` + 候选启动器 + release manifest 哈希锚定）**在生产上从未启用过**。`install-descriptor` 要求候选描述文件无 BOM，而活的描述文件有 BOM —— 这本身就说明活描述文件不是这套工具装的。G4 的完整形态要求走通方案 B。

### 5.4 D20 泄漏面未取证

部署树里新增了一份 `CLAUDE.md`（`main` 有而旧生产树没有）。推断它在 CC 子进程 cwd（cyberlink 根）**下方**、不在上方，因此不会被向上查找捡到 —— **但这是推断，未实测**。

判定方法：在 Telegram 问一句，看回复开头有没有 `[cyberboss sync]` 那行字。有 = 工程上下文确实穿进陪伴线（坐实 D20 泄漏面）；没有 = 泄漏没发生。

另注：部署树里还有 `extensions\relationship-memory\CLAUDE.md`，其首句为「新窗口先安静读 `memory/reentry.md`」。**若它被加载，就存在一条绕过注入预算的第二读取路径。** 同样在 cwd 下方，同样未实测。这条会直接影响 G1 的口径，取证时一并判。

### 5.5 没开任何开关

nightly、Desire、记忆检索、closeout liveness 全部保持现状（实测生产上都是关的，记忆检索显式设成 0）。因此本次交付**不改变** `CURRENT_STATUS.md` 里任何一格 `UNKNOWN` 的生产接线判断。

## 六、回滚路径（已实测其前提）

1. `Disable-ScheduledTask -TaskName cyberboss-watchdog`，并结束 `runtime\telegram\state\cyberboss.pid` 里的进程
2. 删掉 `runtime\app\telegram`（新树）
3. 把 `runtime\app\telegram.bak-20260730` 改名回 `runtime\app\telegram`
4. `Enable-ScheduledTask` + `Start-ScheduledTask`（**两条都要，见坑 1**）
5. 在 Telegram 说一句话，确认有回复

**顺序关键：先停进程，再改文件。** 反了会让 watchdog 用半旧半新的状态把它拉起来。

若备份树也坏了，描述文件里的 `rollback_release`（`phase25a-desire-claude-993d57f`）的入口文件、启动脚本、config 目录、state 目录四样已实测确认都还在。

## 七、这次交付对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 Windows 生产验证 | `PARTIAL`（缺真机 release/cutover 留证） | 仍 `PARTIAL` | 有了一次真实交付留证（本文），但监督链失效（5.1）、发布包机制未启用（5.3），完整形态要方案 B |
| G1 Telegram 记忆读取 | `PARTIAL` | 仍 `PARTIAL` | 代码终于在机器上了，但 `CYBERBOSS_MEMORY_RETRIEVAL=0`，通路仍关着；取证手册在 `docs/G1_EVIDENCE_RUNBOOK.md` |
| G3 profile 隔离 | `PARTIAL` | 仍 `PARTIAL` | profile 机制上机了（此前生产上连文件都没有），配置仍缺 |
| G5 备份与回滚验证 | `NOT_VERIFIED` | 仍 `NOT_VERIFIED` | 第二步的重命名备份 + 回滚路径是一次**准演练**，但不等于 G5 要的完整恢复演练 |

**切生产判据逐条**：第 2 条（真机 release/cutover 输出归档）由本文满足；第 4 条（watchdog 入口显式传 `--descriptor`）形式上满足，**但描述文件本身无法被解析，实质未满足**；第 0、1、6、7 条不受本次交付影响，仍未满足。**因此仍不得切生产。**
