# G4 真机交付留证：2026-08-04 第四次交付——预交付验证移回 git 源真相仓库 + 一次预检拦截实录

```text
Status: active
Date: 2026-08-04
Audited SHA: bf31e62（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：第一次交付 `G4_PRODUCTION_DELIVERY_20260730.md`，监督链修复 `G4_WATCHDOG_RECOVERY_20260731.md`，第二次交付 `G4_PRODUCTION_DELIVERY_20260801.md`，第三次交付 `G4_PRODUCTION_DELIVERY_20260803.md`，电池策略失岗根因 `G4_WATCHDOG_BATTERY_POLICY_20260803.md`。

## 一、这次交付了什么

方案 A（同前三次）：只搬代码，不换启动机制。Owner 全程在场并逐项授权。

| 项 | 值 |
|---|---|
| 目标 SHA | `bf31e62`（部署时的 `origin/main`） |
| 此前生产 SHA | `91dd0d5`（2026-08-03 第三次交付） |
| 落差 | 12 个提交（#140–#151），23 文件 +2898/−89；行为面 #144–#151（setMyCommands 菜单发布、命令改名/隐藏、`/switch back`、`/model` 优先级修复、`/memory review` 参数解析、`/status` watchdog 回看、`/ai_profile`），#140–#143 为文档留证 |
| 交付动机 | 把 8-03 夜间合入的 TG 命令面改造整批上机（52 条 Hermes 死菜单换真指令），顺产 G4 第四次交付证据 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260804`（瞬时，回滚也瞬时） |
| 行为面变化 | 新增能力开关全部保持默认；交付窗口内做过 G1 env 实验并已完全回退（见第三、四节）；生产 secrets 最终状态与交付前一致 |
| **停机窗口** | **02:36:39 – 02:46:38，约 10 分钟**（含一次被启动预检拦截的失败启动，见第三节） |

## 二、预交付验证（与 8-03 的方法差异：测试移回 git 源真相仓库）

8-03 第三次交付在无 `.git` 的暂存树上跑测试，产生两个已定性为环境因素的红组（`test:phase1` 的 `git ls-files` 断言、`test:520-endpoints` 的 `.env` 断言，见 `G4_PRODUCTION_DELIVERY_20260803.md` 第二节与 fable W9 裁定三）。本次把两件事拆开，各取所长：

1. **测试在 git 源真相仓库跑**（工程仓库 @ `bf31e62`，带 `.git`）：`phase1-offline.yml` 全部 13 个分组 **13/13 全绿**。8-03 的两个红组在真 git 环境下如预期转绿——反向印证 8-03「环境因素、非代码回归」的定性。

   | 分组 | exit | tests / pass / fail |
   |---|---|---|
   | test:phase1 | 0 | 112/112/0 + 87/84/0（其余 skip） |
   | test:phase2 | 0 | 30/30/0 |
   | test:phase3 | 0 | 160/160/0 |
   | test:phase4 | 0 | 25/25/0 + 118/118/0 |
   | test:phase5a | 0 | 9/9/0 |
   | test:p0-closeout-liveness | 0 | 11/11/0 |
   | test:memory-services | 0 | 51/51/0（较 8-03 +1 = #147 新增用例） |
   | test:reflect | 0 | 2/2/0 |
   | test:520-endpoints | 0 | （python 用例，全过） |
   | test:route-lanes | 0 | 286/284/0（2 skip = macOS `sips` 依赖，恒 skip） |
   | test:catalog-metering | 0 | 34/34/0 |
   | test:telegram-media | 0 | 42/42/0 |
   | test:orchestration | 0 | 118/118/0 |

2. **暂存树只做构建健全性验证**：`git archive` 自 `bf31e62` 导出干净树（不带 `.git`，按 7-30 决定）到 `runtime\app\telegram.new-20260804`，`npm ci` exit=0，`require.resolve('whereabouts-mcp')` 解析到暂存树内 `vendor\whereabouts-mcp\src\index.js`。

平台：Windows 10 生产机本机，node v24.15.0（与生产启动脚本同一可执行文件）。逐行流水：`workdesk\20260804-predeploy-verify.log`、`workdesk\20260804-predeploy-staging.log`（会话中转，非权威）。

## 三、交付时序（本地 2026-08-04 凌晨）

| 时刻 | 动作 |
|---|---|
| 02:34:53 | D1 停监督：`schtasks /End /tn cyberboss-watchdog` SUCCESS；杀残留 watchdog 进程（PID 47244）后 watchdog 进程数=0。尝试 Disable 计划任务防换树窗口内自动拉起，返回「拒绝访问」（非管理员），以进程数=0 为准继续 |
| 02:36:34 | D2 停 TG：pid file=25808，先核对命令行匹配 `runtime\app\telegram\bin\cyberboss.js` 才动手；`taskkill /F /T` 整树四进程全部 SUCCESS；TG 相关 node/claude 残留=0 |
| 02:38:58 | D3 换树：`telegram` → `telegram.bak-20260804`，`telegram.new-20260804` → `telegram`；`bin/cyberboss.js` 存在=True |
| 02:38:58 | D4 **坑 3 第三次原样复现**：改名后 `require.resolve('whereabouts-mcp')` = `RESOLVE_FAILED MODULE_NOT_FOUND`；确认是 reparse point 后用 .NET `Directory.Delete`（只删链不删目标）→ `npm install` exit=0 → resolve 恢复指向新树 `vendor\whereabouts-mcp\src\index.js` |
| 02:39:00 | D5 descriptor：备份 `.bak-20260804-predeploy` 后**只改** `deployed_sha`：`91dd0d5…` → `bf31e6223c475850d6297e5f1d233cdd934897cf`；`last_verified_sha`（`993d57f…`）/ `verification_mode` 未动（本次同样不是 verified 交付，不伪造验证记录）；写回后核对前 3 字节 = `{` CR LF（无 BOM）、JSON 可解析 |
| 02:39:00 | 同窗口 G1 实验准备：备份后将 `context-gates.json` 的 `memory_context` 置 true；Owner 亲手将 `telegram.env` 的 `CYBERBOSS_MEMORY_RETRIEVAL` 0→1（计划 ②，fable W9 裁定一.4 授权） |
| 02:42:45 | D6 第一次启动：`start-telegram.ps1` exit=0，但 **bot 被启动预检拒绝**（pid 42172 秒死）。err.log：`Startup preflight failed.`——`CYBERBOSS_MEMORY_RETRIEVAL must remain off during Phase 2-5A` + `CYBERBOSS_CONTINUITY_DIR must be outside CYBERBOSS_MEMORY_DIR unless …with all legacy memory gates off`。**预检 fail-closed 按设计工作**；根因与处置见第四节 2 |
| 02:44:35 | 回退 G1 实验：`context-gates.json` 从备份还原（三门全 False）；Owner 亲手把 env 改回 0 |
| 02:46:29 | D6 第二次启动：`start-telegram.ps1` exit=0（配置未动） |
| 02:46:38 | D7 核对：pid file=3272，命令行匹配新树；`bootstrap ok` / `channel=telegram` / `runtime=claudecode` / `bridge loop started; waiting for Telegram messages`；err.log mtime 停在 02:42:45（= 第一次失败启动的预检输出）——**第二次启动零新增错误** |
| 02:47:07 | D8 恢复监督：任务 State=Ready Enabled=True；电源核对 BatteryStatus=2（接电源，避开电池策略坑）；`schtasks /run` SUCCESS → watchdog 进程数=1，watchdog.log 打出 `healthy active release cyberlink-unified-runtime-221a2c: pid 3272 matches …runtime\app\telegram\bin\cyberboss.js` —— **监督链闭环** |

逐行流水：`workdesk\20260804-delivery-transcript.log`（会话中转，非权威）。

## 四、交付后真机观察

1. **菜单换血生效**：本次启动的 telegram-poller.log 打出 `setMyCommands ok count=14`（#144 能力首次真机执行）；bot 实时应答 Owner（sendText ok）。
2. **G1 env=1 被启动预检硬拦（本次交付窗口内的新代码事实）**：`src/core/startup-preflight.js` 的 `validateLegacyMemoryGates` 在 Phase 2-5A 期间对四个 legacy 记忆开关任一为 true 直接拒绝启动，无配置可绕过；连带地，`start-telegram.ps1` 的 `CONTINUITY_DIR==MEMORY_DIR` 同根写法仅在「legacy 门全关」时被放行。即 **G1「靠 env=1 取真机 Trace 证据」在现行代码不可行**，与 fable W9 裁定一.4「批 env=1」存在冲突——该冲突属 Gate 判据解释，已按协议登记判断记录（J-w11-2）交 fable 强制审，**本文与本 PR 不改 G1 行结论、不做任何裁定**。
3. **交付本身与该实验相互独立**：预检拦截发生在 env=1 时，回退 env 后同一棵新树立即正常启动——拦截是配置面被禁，不是 `bf31e62` 代码或部署过程的问题。顺带取得预检 fail-closed 的首份生产侧实录。

## 五、没做到的 / 保持原状的

- `deployment\current.json` 旧真相、`start-telegram.ps1` 硬编码、正规发布包机制仍未处理（#77 原样）。
- 监督链「跨交付连续在岗」证据继续累积：本次 D1 时 watchdog 进程在岗（8-03 修复后存活跨夜至本次交付），但持续性判定仍以 `CURRENT_STATUS.md` G4 行口径为准。
- 未留下任何新开的行为开关；G1 实验（env + context-gates）已在交付窗口内完全回退。
- 本次交付窗口之后、同一工程窗口内另做过 Route1 与 G2 生产实验，均已回退且不属于本次交付内容（各自留证 `workdesk\20260804-route1-guardrail-production-proof.md`、`workdesk\20260804-bug-g2-signing-context-not-wired.md`、`workdesk\20260804-bug-runtime-process-exited-unexpectedly.md`，随各自判断记录走审计回路）。

## 六、回滚路径

1. `schtasks /end /tn cyberboss-watchdog` + 按 pid file 核对命令行后杀进程树
2. 删 `runtime\app\telegram`（新树），`telegram.bak-20260804` 改名回 `telegram`
3. 改名回来后复核 `require.resolve('whereabouts-mcp')`，必要时删悬空 junction 后重跑 `npm install`（坑 3 对回滚同样成立）
4. descriptor 恢复 `descriptor.startup.json.bak-20260804-predeploy`
5. 执行 `runtime\startup\start-telegram.ps1`，`schtasks /run /tn cyberboss-watchdog`
6. Telegram 说一句话确认应答

## 七、对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 | `PARTIAL` | 仍 `PARTIAL` | 第四次成功交付；预交付验证方法改良（git 源真相 13/13 全绿 + 暂存树构建健全性），坑 3 三次复现三次同法修复；#77 仍未处理，监督链持续性证据仍在累积 |
| G1 | `PARTIAL` | 仍 `PARTIAL` | env=1 取证路径被启动预检硬禁的新代码事实已交 fable 强制审（J-w11-2），本 PR 不动 G1 行 |
| G2 / G3 / G5 | 各自不变 | 不变 | 本次交付不触及其证据面 |

**仍不得切生产。** 判据状态不因本次交付改变。
