# G4 第九次真机交付：TG /model /effort 切换修复上机

```text
Status: active
Date: 2026-08-05
Base SHA: 01810c5（full 01810c5da7d86c9bb154dfbcb993baa60c6ee3c0）
Audited SHA: 01810c5
Current authority: docs/CURRENT_STATUS.md
```

## 交付概要

| 项 | 值 |
|---|---|
| 目标 SHA | `01810c5` |
| 此前生产 SHA | `3447ffd`（descriptor 与活树一致） |
| 落差 | 3 个 PR：**#169**（时区来源显式化，beijing-time→app-time）、**#171**（/model /effort 切换修复：目录校验 + override 双写兜底）、**#172**（目录恢复 4.x 现役型号，修正 #171 误砍） |
| 交付动机 | 让 TG 端 /model /effort 切换在生产真正可用 |
| 生产配置变更 | **无**（window override 开关早已 =1，本次纯代码树） |
| 备份 | 树 `telegram` → `telegram.bak-20260805-d9`；descriptor `.bak-20260805-d9-predeploy` |
| 停机窗口 | **22:58:40 – 23:00:36+25s，约 2 分 20 秒**（含一次失败启动） |

## 预交付验证

源真相仓库 @01810c5：13/13 组 exit=0 + portability exit=0（流水 `workdesk\20260805-predeploy9-verify.log`，log 头记录 HEAD 全 SHA）。同 SHA GitHub CI（run 31007489526）success。暂存树 `git archive 01810c5` → 635 文件，`npm ci` exit=0，两个 `file:` vendor 依赖 resolve 落树内。

## 本次踩到的坑：npm file: 依赖的 junction 是绝对路径

坑 3 新变体（与第八次 robocopy 变体同根）。npm ci 在暂存树 `telegram.stage-d9` 里给 `file:vendor/...` 依赖建的 junction 用**绝对路径**指向 `...\telegram.stage-d9\vendor\...`；`Rename-Item` 换名后 junction 悬空，第一次启动 `Cannot find module 'whereabouts-mcp'`（err.log 22:59:5x，24024→25828）。修复：删两条悬空 junction、按新活树绝对路径重建（whereabouts-mcp / timeline-for-agent），`require.resolve` 复核落回活树。

**教训（给下次）**：暂存树 npm ci 之后、换名之前，先检查 `node_modules` 里 file: 依赖的 junction target；或换名后固定重建这两条 junction 再启动。`node -e require.resolve` 在暂存树 CWD 下验证会经暂存树自己的 node_modules 命中，**验不出这个问题**。

## 时序

| 时刻 | 动作 |
|---|---|
| 22:53:33–22:55:43 | 预交付 13 组 + portability 全绿（后台，停机前完成） |
| 22:58:40 | D1 停监督 `schtasks /End cyberboss-watchdog` SUCCESS，pythonw 清零 |
| 22:58:50 | D2 停 TG：5 进程（anchor/bridge/tool-server×2/子进程）taskkill /F /T，3 秒后 remaining=0 |
| 22:59:05 | D3 `Rename-Item` 双向换名一次成功（CWD 先挪出，未复现占用） |
| 22:59:17 | D6 第一次启动 → **失败**：悬空 junction（见上） |
| ~23:00:1x | 重建两条 junction |
| 23:00:36 | D6b 第二次启动 → 成功；bridge loop started，err.log 零新增（25828 持平） |
| 23:00:44 | telegram-poller `setMyCommands ok count=14` |
| 23:01:11 | D8 恢复监督；23:01:13 首条 `healthy ... pid 9588 matches` |
| 23:01+ | descriptor `deployed_sha` → 01810c5 全 SHA（无 BOM 写回）；活树 EOL 归一比对 == commit 01810c5 逐字节一致（app.js / claudecode index / command-registry / app-time / app-timezone 抽查） |

## 回滚

树改名 `telegram` ↔ `telegram.bak-20260805-d9`（注意 bak 树 junction 指向 live 路径，回滚后仍有效因路径不变）；descriptor 用 `.bak-20260805-d9-predeploy` 回填。无 env/profile 层。

## 顺带发现（不属本次交付）

1. 交付期间（22:57）主工作副本 `【项目】\cyberboss` 被另一并行工作者切到 `feat/route2-escalate-trigger` 并提交推送（route2 升格触发方）。预交付验证在此之前完成（log 头 HEAD=01810c5），交付内容不受影响；**未动该分支状态**，留给该工作者。
2. `runtime\app\` 下积累 10 个 `telegram.bak-*` 历史树，占盘待清（非本窗职责）。

## 待证（需 Owner 实机）

TG 发 `/model` 应列 8 现役型号；`/model opus-4.6`（或完整 id）后 `/status` 与活子进程 argv 应带 `--model claude-opus-4-6`，线程轮换后仍保持。
