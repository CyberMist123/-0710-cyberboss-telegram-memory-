# G4 真机交付留证：2026-08-04 第五次交付（bf31e62 → a4c5b54，首次带 G2 主体签署 IPC 代码上机）

```text
Status: active
Date: 2026-08-04
Audited SHA: a4c5b54（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：第一次 `G4_PRODUCTION_DELIVERY_20260730.md`、监督链修复 `G4_WATCHDOG_RECOVERY_20260731.md`、第二次 `G4_PRODUCTION_DELIVERY_20260801.md`、第三次 `G4_PRODUCTION_DELIVERY_20260803.md`、第四次 `G4_PRODUCTION_DELIVERY_20260804.md`、电池策略 `G4_WATCHDOG_BATTERY_POLICY_20260803.md`。

## 一、这次交付了什么

方案 A（同前四次）：只搬代码，不换启动机制。Owner 全程在场并授权（含明确授权在本工程窗口内执行本次生产切换）。

| 项 | 值 |
|---|---|
| 目标 SHA | `a4c5b54`（full `a4c5b54b4bc8ce82c0b7e51b71bc1c32dfb1bd0e`，部署时的 `origin/main`） |
| 此前生产 SHA | `bf31e62`（2026-08-04 第四次交付） |
| 落差 | 2 个 PR：**#153**（G1 行改写为 Phase 2-5A 预检硬禁 + DECISIONS C7 候选，纯文档）+ **#154**（G2 主体签署改走窄鉴权 IPC broker + 新增 **D31**，src 代码 + 测试 + 文档）。行为面新增能力全部默认关（`CYBERBOSS_SUBJECT_SIGNING_ENABLED` 默认 false） |
| 交付动机 | 把 #154 的 **G2 签署 IPC 修复**送上活体，为后续 Owner 在场的 G2 真机 canary 铺路；顺产 G4 第五次交付证据 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260804-d5`（瞬时，回滚也瞬时） |
| 行为面变化 | 无新开行为开关；`telegram.env` **全程未动**（Owner 已配的本地 whisper 语音 env 原样保留）；生产 secrets 最终状态与交付前一致 |
| **停机窗口** | **14:45:46 – 14:50:59，约 5 分钟**（含一次因手动 shell 未设 `CYBERLINK_ROOT` 的失败启动，见第三节） |

## 二、预交付验证（源真相仓库 a4c5b54，13/13 全绿）

在 **git 源真相仓库**（`【项目】\cyberboss` @ `a4c5b54`）跑 `phase1-offline.yml` 全部 13 组：

- **11 组直接 exit=0**。2 组（`test:phase4`、`test:orchestration`）在 Git Bash 下报 9 个失败，签名均为 `tar: Cannot connect to C: resolve failed` —— **GNU tar 把 Windows `C:\path` 误当远程 `host:path`**（release-manifest fixture 用 `git archive`/`tar`）。
- **对照实验**：同两组经 **PowerShell（Windows bsdtar）** 原样重跑 → `orchestration` 118/118/0、`phase4` 25/25/0 + 118/118/0，`tar-host-errors=0`。确证为 shell 环境噪声、非代码回归。旁证：#154 的 `phase1-offline` CI（windows-latest，含这两组）全绿。
- **真实姿态：13/13 全绿。** 逐行流水：`workdesk\20260804-predeploy5-verify.log`。

暂存树只做构建健全性：`git archive a4c5b54` 导出干净树（不带 `.git`）到 `runtime\app\telegram.new-20260804-d5`，`npm ci` exit=0（188 包），`require.resolve('whereabouts-mcp')` 解析到暂存树内 `vendor\whereabouts-mcp\src\index.js`。流水：`workdesk\20260804-predeploy5-staging.log`。

平台：Windows 10 生产机本机，node v24.15.0，npm 11.12.1。

## 三、交付时序（本地 2026-08-04 下午）

| 时刻 | 动作 |
|---|---|
| 14:45:29 | D1 停监督：`schtasks /End cyberboss-watchdog` SUCCESS；watchdog 进程数=0 |
| 14:45:46 | D2 停 TG：pid file=36584，先核对命令行匹配 `runtime\app\telegram\bin\cyberboss.js` 才动手；`taskkill /F /T` 整树七进程全 SUCCESS；残留=0 |
| 14:46:06 | D3 换树：`telegram` → `telegram.bak-20260804-d5`，`telegram.new-20260804-d5` → `telegram`；`bin/cyberboss.js` 存在=True |
| 14:46:06 | D4 **坑 3 第四次原样复现**：改名后 `require.resolve('whereabouts-mcp')` = MODULE_NOT_FOUND（暂存树 junction 目标绝对路径随改名失效）；确认 reparse point 后 .NET `Directory.Delete`（只删链）→ `npm install` → **从树内 cwd 复核** resolve = `runtime\app\telegram\vendor\whereabouts-mcp\src\index.js`，junction target 已指向新树。（记一坑：`require.resolve` 是 cwd 相对，验证必须在树内跑，否则会误判 FAIL） |
| 14:47:04 | D5 descriptor：备份 `.bak-20260804-d5-predeploy` 后**只改** `deployed_sha`：`bf31e622…`→`a4c5b54b4bc8…`；`last_verified_sha`（`993d57f…`）/ `verification_mode` 未动；写回前 3 字节 = `123,13,10`（`{` CR LF 无 BOM）、JSON 可解析、回读逐字段核对通过 |
| 14:47:20 | D6 第一次启动**失败**：`start-telegram.ps1` exit=1，报 `CYBERLINK_ROOT is not set. Refusing to guess the workspace root (R4 F4)`。根因：手动 shell 未设 `CYBERLINK_ROOT`（生产由 watchdog 拉起时设置；手动交付需自行设）。**这是护栏按设计工作，不是 bug** |
| 14:48–14:50 | D6 重试：设 `CYBERLINK_ROOT=<工作区根>`（即 cyberlink 根目录，有 runtime+settings 的那一层）后 `start-telegram.ps1` 启动成功 |
| 14:50:59 | D7 核对：pid file=45344，命令行匹配新树；`bootstrap ok` / `bridge loop started; waiting for Telegram messages` / desire poller 起；err.log mtime 停在 03:18:47（启动前=启动后）——**零新增错误**；进程链 `45344 ← 39316(node)`，无 powershell，**已脱离启动器**（后续 kill 启动器管道 bot 仍存活，实证脱离） |
| 14:51:53 | D8 恢复监督：`BatteryStatus=2`（接电源，避开电池策略坑）；`schtasks /Run` SUCCESS → watchdog 进程数=1，watchdog.log `healthy active release cyberlink-unified-runtime-221a2c: pid 45344 matches …runtime\app\telegram\bin\cyberboss.js` —— **监督链闭环** |

逐行流水：`workdesk\20260804-delivery5-transcript.log`（会话中转，非权威）。

## 四、本次两处操作性记录（非代码问题）

1. **`start-telegram.ps1` 需 `CYBERLINK_ROOT`**：生产路径由 watchdog 计划任务拉起时注入；**手动交付时必须先设**，否则启动预检 fail-closed 拒启动（R4 F4 护栏）。前四次交付未撞是因当时 shell 已带该 env。建议下次发车脚本模板显式设 `CYBERLINK_ROOT`。
2. **坑 3 验证的 cwd 陷阱**：`require.resolve` 相对 cwd，junction 修复后的复核必须在 `runtime\app\telegram` 树内跑；在别处跑会误报 MODULE_NOT_FOUND（本次一度误判，切树内 cwd 后确认 OK）。

## 五、没做到的 / 保持原状的

- `deployment\current.json` 旧真相、`start-telegram.ps1` 硬编码、正规发布包机制仍未处理（#77 原样；本次仍走方案 A 手改 `deployed_sha`，未走已建好的验证 install 路径——采用缺口见 `workdesk\20260804-77-adoption-gap-report.md`）。
- `telegram.env` 未动；未留下任何新开行为开关；`CYBERBOSS_SUBJECT_SIGNING_ENABLED` 仍默认关。
- **G2 主体签署真机 canary 未做**——本次只是把 #154 的签署 IPC 代码搬上机，真机正例/work 双拒/turn 终结拒绝的 canary 留 Owner 在场的 G2 生产闭环场次（fable 裁定二.6.f）。

## 六、回滚路径

1. `schtasks /End cyberboss-watchdog` + 按 pid file 核对命令行后杀进程树
2. 删 `runtime\app\telegram`（新树），`telegram.bak-20260804-d5` 改名回 `telegram`
3. 改名回来后**在树内 cwd** 复核 `require.resolve('whereabouts-mcp')`，必要时删悬空 junction 后重跑 `npm install`
4. descriptor 恢复 `descriptor.startup.json.bak-20260804-d5-predeploy`
5. 设 `CYBERLINK_ROOT` 后执行 `start-telegram.ps1`，`schtasks /Run cyberboss-watchdog`
6. Telegram 说一句话确认应答

## 七、对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 | `PARTIAL` | 仍 `PARTIAL` | 第五次成功交付；坑 3 第四次复现同法修复；#77 仍未处理；本次记录两处操作性护栏（CYBERLINK_ROOT / cwd） |
| G2 | `PARTIAL` | 仍 `PARTIAL` | #154 签署 IPC 代码已上活体，但真机 canary 未做、生产开关默认关，判据未满足 |
| G1 / G3 / G5 | 各自不变 | 不变 | 本次交付不触及其证据面（#153 的 G1 行文案改写随代码上机，状态词早已 PARTIAL 不动） |

**仍不得切生产。** 判据状态不因本次交付改变。
