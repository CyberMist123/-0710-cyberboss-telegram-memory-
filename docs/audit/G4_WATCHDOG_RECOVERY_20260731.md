# G4 监督链修复留证：BOM 事故、真实停机与恢复（2026-07-31）

```text
Status: active
Date: 2026-07-31
Base SHA: 2dac363（修复时的 origin/main；生产运行树仍为 48660a9 导出）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情见 `docs/audit/G4_PRODUCTION_DELIVERY_20260730.md` 第五节（监督链失效的首次记录）。

## 一、风险变成了事故：真实停机 ~2.5 小时

7-30 交付留证里写的风险（"bot 崩了没人拉"）在本日真实发生：

| 时刻（本地） | 事件 |
|---|---|
| 14:20 | 生产 bot 最后一条日志（`runtime\telegram\logs\cyberboss.log` 最后写入时间） |
| ~14:51 | 生产机重启；watchdog 计划任务随登录拉起，但 `load_descriptor()` 对带 BOM 的 `runtime\telegram\descriptor.startup.json` fail-closed，**无法恢复 bot** |
| 14:52 | 仅 legacy 树的 shared 服务（520 面板 / weixin 侧 / checkin）随启动项恢复；**Telegram bot 无人拉起** |
| ~17:10 | 本窗取证发现停机（离线约 2.5 小时） |
| 17:16 | 按 7-30 交付同一流程执行 `runtime\startup\start-telegram.ps1`，bot 复活（新 pid 22612），`bridge loop started; waiting for Telegram messages`，err.log 零新增 |
| 17:17 | 修复描述文件（见第二节） |
| 17:18:29 | watchdog 首次打出 `healthy active release cyberlink-unified-runtime-221a2c: pid 22612 matches ...\runtime\app\telegram\bin\cyberboss.js` —— **监督链恢复** |

停机期间 pid 文件内容为已死进程（12184），描述文件指向的树无任何进程 —— watchdog 若非 BOM fail-closed，本可在重启后 60 秒内恢复 bot。**这次事故就是监督链价值的反面证明。**

## 二、修了什么（Owner 已授权动 `runtime\`）

1. **先救活，再修监督**（刻意顺序，防双实例）：先用 `start-telegram.ps1` 拉起 bot 并确认 pid 文件与进程命令行一致，**然后**才修描述文件 —— 这样 watchdog 恢复解析后的第一次判活就是 `alive=True`，`launch_active_release()` 不会被触发，不存在两个 bot 抢同一 Telegram 账号的窗口。
2. **描述文件去 BOM**：`runtime\telegram\descriptor.startup.json` 重写为 UTF-8 无 BOM（原文件备份为同目录 `descriptor.startup.json.bak-20260731-prebomfix`，保留 BOM 原状）。
3. **`deployed_sha` 改为真话**：`221a2c59...`（7-12 旧值，7-30 交付后即失真）→ `48660a963c0d572a54501b1e7433f87995f26a95`（当前运行树的实际导出源，与 `G4_PRODUCTION_DELIVERY_20260730.md` 的目标 SHA 一致）。其余字段未动。
4. **上线前干跑验证**：用部署树自己的 `watchdog.load_descriptor()` + `active_release_alive()` 对修复后文件干跑 —— 解析成功、判活 `True, pid 22612 matches`，然后才让真 watchdog 的 60 秒周期接手。

## 三、修复后的监督语义（下次重启会发生什么）

watchdog 计划任务随登录启动 → 解析描述文件（现在能过）→ 判活失败（重启后 bot 死）→ `launch_active_release()` 执行 `watchdog_target` = `start-telegram.ps1` → 该脚本自带防重入（已有匹配进程即退出）→ bot 恢复。**重启自愈链路首次真正闭合。**

## 四、明确没修的（仍归 issue #77）

- `deployment\current.json` 仍指向 993d57f 旧 release 与废弃 workspace —— 三套真相只把 startup 描述文件这一套改成了真话；
- `last_verified_sha`（993d57f）与 `verification_mode` 未动 —— 本次不是一次 verified 交付，不伪造验证记录；
- 备份描述文件 `descriptor.startup.json.bak-20260730` 仍带 BOM（历史证据，保持原状）；
- 正规发布包机制（`install-descriptor` + 候选启动器，方案 B）仍未启用；
- `start-telegram.ps1` 仍硬编码路径、0 处引用描述文件 —— 单一真相重建是 #77 的正题。

## 五、回滚

恢复 `descriptor.startup.json.bak-20260731-prebomfix` 即回到修复前状态（watchdog 恢复 fail-closed 循环，bot 继续运行但重新失去监督）。不建议：那正是本次修掉的事故态。
