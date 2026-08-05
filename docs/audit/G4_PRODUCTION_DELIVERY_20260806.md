# G4 第十次真机交付：TG 表情包出口 + 候选 provenance 上机

```text
Status: active
Date: 2026-08-06
Base SHA: 4628ad7（full 4628ad7226a483e367494c9b07eae21884efa512）
Audited SHA: 4628ad7
Current authority: docs/CURRENT_STATUS.md
```

## 交付概要

| 项 | 值 |
|---|---|
| 目标 SHA | `4628ad7` |
| 此前生产 SHA | `085bf05`（descriptor 自述与活树 EOL 归一比对一致，636/636 文件零差异） |
| 落差 | 3 个 commit：**#176**（纯文档 3 行，profile 的 builtInTools 早已在活体改过，无代码）、**#177**（TG 表情包出口 + `sendAnimation`）、**#178**（候选 provenance 主进程取证，D35） |
| 交付动机 | 让 `sticker_send` 在 TG 真正可用；让 `memory_candidate_submit` 第一次真的能写成一条候选 |
| 生产配置变更 | **无**。签署开关本已是 `=1`（见下"意外发现"），env 未改 |
| 备份 | 树 `telegram` → `telegram.bak-20260806-d10`；descriptor `.bak-20260806-d10-predeploy`；env `.bak-20260806-d10-predeploy` |
| 停机窗口 | **01:11:47 – 01:12:3x，约 50 秒**（一次启动成功，无失败启动） |

## 预交付验证

源真相仓库 @4628ad7：13/13 组 + `npm run check` + portability 全部 exit=0
（流水 `workdesk\20260806-predeploy10-verify.log`，log 头记录 HEAD 全 SHA）。
同 SHA 的 GitHub CI 在 #177 / #178 两个 PR 上均 success（phase1-offline 各 6m40s / 6m42s）。
暂存树 `git archive 4628ad7` → 638 文件，`npm ci` exit=0。

### 预交付踩到的坑：不要用 Git Bash 跑测试

首轮 13 组里 `test:phase4` 与 `test:orchestration` exit=1，9 条失败全在
`release-manifest.test.js`，报 `tar: Cannot connect to C: resolve failed`。

根因是**测试宿主 shell**：Git Bash 的 GNU tar 1.35 把 `C:\...` 当成远程主机 spec。
换 PowerShell（走 `C:\WINDOWS\system32\tar.exe`，与 CI windows-latest 同一个 bsdtar）
后 orchestration 118/0、phase4 25/0 + 118/0，全绿。

**教训（给下次）**：预交付验证一律用 PowerShell 跑。用 Git Bash 会凭空造出两组红，
而这两组恰好是 release/manifest 这类最不该被误判的组。

## 坑 3（file: 依赖 junction）本次已提前规避

第九次交付死在这里：`npm ci` 在暂存树给 `file:vendor/...` 依赖建的 junction 用
**绝对路径**指向暂存树，`Rename-Item` 之后悬空，第一次启动
`Cannot find module 'whereabouts-mcp'`，多花约 90 秒。

本次按第九次留下的教训，**换名后、启动前**固定重建两条 junction
（`whereabouts-mcp` / `timeline-for-agent`），再从活树 CWD 跑
`require.resolve` 复核落点。**一次启动成功，err.log 零新增。**

## 意外发现：签署开关在生产一直是开的

Owner 指示本次顺带打开 `CYBERBOSS_SUBJECT_SIGNING_ENABLED`。追加前按幂等检查发现
**该键已存在于 `settings\secrets\telegram.env` 且值为 `=1`**，env 未做任何修改。

这解释了 Owner 之前的现场：fable 能加载到 `memory_candidate_submit` 的 schema
并卡在 `content_sha256` 上——工具本来就注册着，只是它要的东西模型给不出。

`CURRENT_STATUS.md` 能力表第 80 行此前把 G2-2 的生产接线记作 `DISABLED`
（"默认或当前关闭"），与真机不符，本次一并按词典改为 `WIRED`
（"已接生产入口，但尚无真机验证证据"）。

## 时序

| 时刻 | 动作 |
|---|---|
| 01:0x | 预交付 13 组 + check + portability（Git Bash 两组假红 → PowerShell 复跑全绿） |
| 01:0x | 基线取证：活树 EOL 归一比对 `085bf05`，636/636 零差异——descriptor 自述属实 |
| 01:1x | 暂存树 `telegram.stage-d10` 建好，`npm ci` exit=0，junction 指向暂存树（已预期） |
| 01:11:40 | D0 备份 descriptor + env |
| 01:11:41 | D1 停监督 `schtasks /End cyberboss-watchdog`，pythonw 清零 |
| 01:11:47 | D2 停 TG：5 进程（anchor/bridge/tool-server×3）`taskkill /F /T`，3 秒后 remaining=0 |
| 01:12:0x | D3 双向换名一次成功（CWD 已先挪出 root，未复现占用） |
| 01:12:0x | D4 重建两条 junction → 活树绝对路径；`require.resolve` 复核落回活树 |
| 01:12:3x | D6 **第一次启动即成功**；`state=enabled`、`setMyCommands ok count=14`；err.log 25828 → 25828 零新增 |
| 01:16:02 | D8 恢复监督；watchdog `healthy ... pid 23884 matches` |
| 01:16:37 | 活体已在处理真实入站消息（messageId=22177） |
| 01:1x | descriptor `deployed_sha` → `4628ad7…` 全 SHA（无 BOM 写回，实测首三字节非 EF BB BF） |

## 交付后取证

活树 EOL 归一比对 commit `4628ad7`：**638/638 文件，missing=0，diff=0**。

抽查两处修复实体：

- `src/tools/create-project-tooling.js` 含 `createConfiguredChannelAdapter`（出口按 channel 分流）
- `src/adapters/channel/telegram.js` 中 `sendAnimation` 出现 5 次
- `src/tools/tool-host.js` 中 `content_sha256` 仅剩 1 处，且是注释；
  `memory_candidate_submit` 的 `required` 实测为 `["type", "body", "origin"]`

## 回滚

树改名 `telegram` ↔ `telegram.bak-20260806-d10`（bak 树的 junction 指向 live 路径，
路径不变故回滚后仍有效）；descriptor 用 `.bak-20260806-d10-predeploy` 回填。
env 本次未改，其 `.bak-20260806-d10-predeploy` 只是同批留档。无 profile 层变更。

## 待证（需 Owner 实机）

1. **表情包**：让 fable 用 `cyberboss_sticker_send` 发一张（不是绕道 `cyberboss_telegram_send`），
   确认不再报 `No saved WeChat account was found`，且以内联动图而非文件附件呈现。
2. **候选**：走一次主体署名，确认 `candidates/episodes.candidates.jsonl` 真的落一条，
   且该条经 Review 时 `source_ref_located` 为真（不再恒 `deferred / source_ref_missing`）。

两项都通过之前，能力表相关行不得升到 `VERIFIED`。

## 顺带发现（不属本次交付）

`src/services/telegram-service.js` 有**第三条出口**：它自己的 `sendFile` 直接打
`sendDocument`，`channelAdapter` 零引用，也不走 `writeTelegramLog`（所以它发的东西
不进 `telegram-poller.log`）。#177 只修了 `channelAdapter` 那条。Owner 现场看到的
"发出来是个 GIF" 极可能就是 fable 绕道走了这条。是否收敛为单一出口未定。
