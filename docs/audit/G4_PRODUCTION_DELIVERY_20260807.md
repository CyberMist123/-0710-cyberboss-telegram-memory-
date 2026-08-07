# 第十九次真机交付：`/status` 四条真相源修复上机

```text
Status: active
Date: 2026-08-07
Base SHA: 2cee7c3（批次起点 origin/main 1a5ce59）
Audited SHA: 2cee7c3
Current authority: docs/CURRENT_STATUS.md
```

## 交付概要

| 项 | 值 |
|---|---|
| 批次分支 | `fix/status-command-truth`（连续做完，未逐个开 PR，D36） |
| 交付次数 | 1 次代码上机（d19） |
| 前置 | 本机 PowerShell 14 组全绿 + portability passed，零红上机 |
| 生产配置变更 | `telegram.env` 加 1 行（`CYBERBOSS_WATCHDOG_LOG`），备份 `telegram.env.bak-20260807-prewatchdoglog` |
| 停机 | 19 秒（11:41:08 停 → 11:41:27 起） |
| 回滚 | 0 次 |

## 起因

Owner 2026-08-06 真机报 `/status` 四条毛病，其中 context 一条她注明「本次新毛病」「以前明明可以的」。

## 四条的根因

| # | 症状 | 根因 | 处置 |
|---|---|---|---|
| 1 | context 比例要等发完一条消息才正确 | `/status` 读的是**纯内存表**，只在子进程吐出带 usage 的 assistant 消息时写一次；进程起来不写、turn 开始不写、relaunch 不写、bot 重启直接清空 | 改从 CC 自己的会话 transcript 读 |
| 2 | `status: idle` 看不懂 | 中文注解只挂在 `threadState` 缺失的兜底分支上，真有状态时反而裸打 token | token · 人话 + 状态图标 |
| 3 | `/model` 对而 `/status` 错 | `/model` 走 window override 阶梯，`/status` 直接打 `describe().model`（profile 缺省值，恒非空） | 阶梯收进单一 helper，三个命令共用 |
| 4 | watchdog `unknown · log not configured` | 生产 `telegram.env` 65 行里没有 `CYBERBOSS_WATCHDOG_LOG` | 补该行 |

## 第 1 条：为什么不能问子进程，以及答案在哪

**问过了，不行。** 零推理探测（启动 CC、只读它在收到任何用户消息之前吐的行、立即杀掉）：
握手阶段只有两条 `system`（`hook_started` / `hook_response`），**没有任何 `usage` 字段**，也没有可白嫖的查询口。任何能问出数字的做法都要真花一次推理，并且会往她的对话里塞一条假的用户消息。

**但答案本来就在磁盘上。** CC 给每个会话写一份 JSONL（`<configRoot>/projects/<slug>/<sessionId>.jsonl`），每条 assistant 条目都带 usage；而 relaunch 是 `--resume` 同一个会话，**所以新进程扛的上下文就是这份文件**。读它最后一条用量即可：零成本、不等她说话、跨重启与跨 relaunch 都成立。

生产实测（会话 `f576654b-…`，1171 条，374 条带 usage）：最后一条 `currentTokens = 80,639`。

「以前明明可以的」也解释得通：那张内存表以前一直是热的，因为很少重启；08-06 一天 7 次代码上机 + 1 次配置重启，每次清空，于是她必须发一条消息把它喂回去。

实现上三条守住的边界：

- 按 sessionId 在 `projects/*/` 下找文件，**不复算那个 slug**——cwd 编码方案不归我们所有，是最容易在脚下变的东西。
- 只读尾部 256KB，且**显式丢弃首行**——尾读会把首行切开，宁可少一条也不把碎片解析成一个数字。
- 全程 fail-open：文件缺失 / 不可读 / 尚无 assistant 条目 / 整行损坏一律返回 null，回落原内存读数。诊断字段不许把 `/status` 弄挂。

token 求和公式抽成 `events.js` 的 `summarizeUsageTokens`，事件流与 transcript 共用一份。

## 顺带修好的：main 的阻塞 CI 红了一夜

`fa59679` 卸载 timeline 工具包时，system trigger 提示词里那句去掉了 `timeline/`，但 `test/desire-loop-minimal.test.js:324` 仍按旧措辞断言。`gh run list` 实证 `phase1-offline` 在 `fa59679` 与 `1a5ce59` 两次推送上**都是 failure**——08-06 那批收尾时只看了本地分支的绿，没回头看推上 main 之后的结论。出厂措辞是对的，改的是测试的期望。

**教训**：批次收尾必须回看 main 推上去之后的 CI 结论，本地绿不等于 main 绿。

## 真机验收（Owner 在场，2026-08-07）

```
📁 workspace: <CYBERLINK_ROOT>            ← 真机输出为绝对路径，此处按可移植性规则改写
🧵 thread: f576654b-4d1a-4b84-ae16-d8348ca3e710
💤 status: idle · 空闲
🧠 runtime: claudecode
🤖 model: claude-opus-4-6
⚡ effort: medium
📦 context: approx 85.1k/200k | 57% left
🐕 watchdog: alive
```

判据逐条：

- **context 那行是关键**：bot 十几分钟前才重启、内存表为空，**旧代码在这一刻只会打 `unavailable`**。它给出了数字 ⇒ 从磁盘读这条路在生产上通了。
- `model` 显示 `claude-opus-4-6` 而非 profile 缺省的 `claude-fable-5` ⇒ 阶梯修对。
- `effort` 上榜；`provider` 行已消失；状态图标与短注解生效；`watchdog: alive` ⇒ env 生效。

## 部署真相判据

**不信 descriptor 元数据**（交付后 `deployed_sha` 仍写 `fa59679`，是旧的——issue #77 已记）。判据是活代码树对 `git archive 2cee7c3` 的**逐字节比对：159 个 src 文件，零差异**。

## 本次踩到的两个坑

1. **Git Bash 的 tar 会把 `C:\...` 当远程主机**（`tar: Cannot connect to C: resolve failed`），导致 `test:orchestration` 9 个 release-manifest 用例假红。判据平台是 PowerShell，换过去即全绿。历次审计记过，这次是从 Bash 工具跑测试撞上的新入口。
2. **不要用 `git show | Set-Content -NoNewline` 造比对文件**：PowerShell 把 git 输出切成字符串数组，`-NoNewline` 再把它们无分隔拼接，换行全丢，于是每个文件都"不相等"。d19 首跑的 D5 假警报即出于此，已改为字节级比对。

## 工具固化

部署脚本此前只存在于**上一个会话的 scratchpad** 里（根 `CLAUDE.md`「会话产物纪律」明令避免的形态），下个窗口只能考古。已固化为带参数的可复用脚本：

- `workdesk\tools\build-stage.ps1 -Sha <sha> -Tag <tag>`
- `workdesk\tools\deploy.ps1 -Sha <sha> -Tag <tag>`

两者的 vendor junction 列表改为**从 `package.json` 派生**，不再写死（d18 就因为写死而对已删除的 `timeline-for-agent` 报了一条 RESOLVE_FAIL）。

## 回滚

停进程 → `Rename-Item telegram -> telegram.failed` → `Rename-Item telegram.bak-20260807-d19 -> telegram` → 重跑 `runtime\startup\start-telegram.ps1`。
配置侧单独回滚：删 `telegram.env` 最后一行（备份 `telegram.env.bak-20260807-prewatchdoglog`）。

## 未做

`♻️ 新的子进程接管了这条 lane` 那条主动通知已上机但**尚未真机触发**（需要一次真实升格或 TTL 回收）。离线 6 条用例覆盖（含 Route 1 worker 不得播报），真机留证归下一窗。
