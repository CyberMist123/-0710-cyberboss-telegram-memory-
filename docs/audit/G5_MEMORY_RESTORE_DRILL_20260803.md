# G5 真机演练留证：2026-08-03 memory 备份恢复演练（含真档原地恢复）

```text
Status: active
Date: 2026-08-03
Audited SHA: 91dd0d5（演练时的 origin/main，工具即该 commit 合入的 scripts/memory-backup.js）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。

D20 裁定 G5 是切生产硬门，并明确「不接受『脚本存在』替代演练」。本次演练在真实生产机上进行，Owner 全程在场并逐项授权（停机、备份落点、演练深度均由 Owner 当面裁定）。

## 一、演练前的真机现状（只观察，未改动）

| 项 | 值 |
|---|---|
| 主机 | win32 10.0.19045 / node v24.15.0 |
| 记忆真档 | `<CYBERLINK_ROOT>\memory` —— 155 个文件 / 4,286,828 字节 |
| TG 进程 | PID 38756 `runtime\app\telegram\bin\cyberboss.js start`（2026-08-01 19:17 起） |
| TG 子进程 | PID 27664 `claude.exe --model claude-fable-5`（陪伴线运行时）、PID 45120 tool-mcp-server |
| watchdog | **未运行**（无 `watchdog.py` 进程、无 `watchdog.pid`，日志停在 2026-07-12）；计划任务 `cyberboss-watchdog` 为 Ready 但只有登录触发、无重复间隔，故演练窗口内不会自动拉起 |
| nightly | `cyberlink-continuity-nightly` 下次触发 2026-08-04 06:30，不在窗口内 |
| 其他可能写记忆的进程 | 微信线 legacy 实例 PID 22532（`cyberlink\cyberboss\bin\cyberboss.js start --checkin`，2026-07-31 起）——未停；演练时 memory 最新写入时间为 13:32:48，四小时无写入，判定为闲置，并以 S5 覆盖前预检兜底 |

### 记录：descriptor 与实际运行不一致（不在本次处置范围）

`deployment\current.json` 的 `telegram_entry` 指向 `releases\cyberboss-phase25a-993d57f\bin\cyberboss.js`，而**实际运行的是** `runtime\app\telegram\bin\cyberboss.js`；watchdog 计划任务用的又是第三份 `runtime\telegram\descriptor.startup.json`。这属于 #77 第 3/4 项（descriptor 单一真相 / 启动固化，对应第五节判据 3、4）的问题域，本次演练**只记录、不顺手修**。

## 二、演练步骤与原始输出

工具：`scripts/memory-backup.js` @ `91dd0d5`（本仓库，测试进 `test:memory-services`，在 `phase1-offline.yml` 阻塞清单内）。

停机窗口：**17:44:26 – 17:47:23，约 3 分钟**。

```text
[17:44:26] S1 停机开始。停机前进程确认：
[17:44:27]   TG PID=38756 cmd=... runtime\app\telegram\bin\cyberboss.js start
[17:44:27]   匹配 runtime\app\telegram\bin\cyberboss.js —— 目标正确
[17:44:28]   stop PID=45120 (node.exe) -> 已停
[17:44:29]   stop PID=27664 (claude.exe) -> 已停
[17:44:30]   stop PID=38756 (node.exe) -> 已停
[17:44:33] S1 完成

[17:45:04] S2 snapshot 真实 memory -> backup\g5-drill-20260803
[17:45:04]   tool = scripts\memory-backup.js @ 91dd0d5
[17:45:05]   exit=0
[17:45:05]   {"ok":true,"command":"snapshot","backup":"...\\memory-live-2026-08-03T07-45-05-041Z",
              "file_count":155,"total_bytes":4286828,"skipped":0}

[17:45:16] S3 verify 快照自身
[17:45:16]   exit=0  ok=True checked=155 missing=0 extra=0 mismatched=0

[17:45:16] S4 隔离副本演练
[17:45:16]   S4.1 恢复成隔离副本 exit=0  ok=True restored_files=155
[17:45:17]   S4.2 副本核对 exit=0 ok=True
[17:46:16]   S4.3 破坏副本：删 reentry.md、删 candidates\episodes.candidates.jsonl、
                            改 episodes.jsonl、塞野文件 junk-from-drill.tmp
[17:46:16]   S4.4 破坏后核对 exit=1 ok=False missing=2 extra=1 mismatched=1
[17:46:16]      missing: candidates/episodes.candidates.jsonl, reentry.md
[17:46:16]      extra: junk-from-drill.tmp
[17:46:16]      mismatched: episodes.jsonl
[17:46:17]   S4.5 从备份恢复 exit=0 ok=True
[17:46:17]   S4.6 恢复后核对 exit=0 ok=True checked=155
[17:46:17]      野文件已清除: True / candidates 已回来: True / reentry.md 已回来: True

[17:46:44] S5 真档原地恢复
[17:46:44]   覆盖前预检 exit=0 ok=True checked=155 missing=0 extra=0 mismatched=0
[17:46:44]   预检通过：真档与快照逐字节一致，覆盖是等价操作。
[17:46:45]   正式覆盖 exit=0 ok=True restored_files=155
              post_check(missing/extra/mismatched)=0/0/0
[17:46:45]   独立复核（不看 restore 自己的报告，另跑一次 verify）
[17:46:45]     exit=0 ok=True checked=155
[17:46:45] S5 完成

[17:47:21] S6 重启 TG（runtime\startup\start-telegram.ps1，原路起，未改任何配置）
           新 PID=34400，pid file=34400，日志 "bridge loop started; waiting for Telegram messages."
```

完整逐行流水：`workdesk\20260803-g5-drill-transcript.log`（会话中转，非权威）。

## 三、这次演练证明了什么、没证明什么

**证明了：**

1. 对真实记忆真档能做出带 sha256 manifest 的完整快照（155 文件全覆盖，`skipped=0`，无 symlink 被静默跟随）。
2. 快照可核对：`verify` 对备份自身与任意目标树都能逐文件比对。
3. **破坏能被检出** —— 这是演练成立的前提。删文件、改内容、塞野文件三类破坏分别落在 `missing` / `mismatched` / `extra`，退出码 1。少了这一步，后面的"恢复成功"什么也证明不了。
4. 从备份恢复能把被破坏的树**逐字节**还原，且清除恢复前不该存在的野文件。
5. **恢复路径本身在真档上跑过一次**：真实 `memory\` 被整体覆盖重建，覆盖后独立复核 155/155 一致。

**没证明：**

- **release 回滚未演练。** G5 的名字是「备份与回滚验证」，本次只做了记忆备份/恢复；`scripts/windows/phase1-rollback.ps1` 的真机回滚（descriptor 原子切换 + 停旧 release + watchdog 拉起 rollback release）没有跑过。**故 G5 记 `PARTIAL` 而非 `PASS`。**
- 未演练"备份是唯一幸存副本"的极端场景（本次真档始终健在，破坏只发生在隔离副本与一次等价覆盖上）。
- 未覆盖 `runtime\` / `settings\` / `releases\` 的备份恢复——本次范围只有 `memory\`。

## 四、演练本身挖出的工具缺陷（已记录，未修）

`restore` 的非空目标检查排在 dry-run 分支**之前**，因此对一个非空目标（真档就是）无法在不给 `--overwrite` 的情况下取得预览，会直接以 `ERROR target is not empty` 退出。方向是安全的（fail-closed，宁可不预览也不误写），但预览能力在最需要它的场景下失效。S5 实际执行时因此只能跳过 dry-run 直接走正式覆盖（有预检兜底，未造成风险）。修理留后续 PR。

## 五、留证物

| 物 | 位置 |
|---|---|
| 快照（含 manifest.json） | `<CYBERLINK_ROOT>\backup\g5-drill-20260803\memory-live-2026-08-03T07-45-05-041Z\`（不入库：记忆真档不进公开仓库） |
| 隔离副本（演练残留，可清） | `<CYBERLINK_ROOT>\backup\g5-drill-20260803\restore-copy\` |
| 逐行流水 | `workdesk\20260803-g5-drill-transcript.log` |
| 工具与其测试 | `scripts/memory-backup.js`、`test/memory-backup-restore.test.js`（PR #139） |
