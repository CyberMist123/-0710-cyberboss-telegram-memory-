# G4 真机交付留证：2026-08-03 第三次交付——预交付全量测试归档 + 坑 3 复现验证

```text
Status: active
Date: 2026-08-03
Audited SHA: 91dd0d5（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：第一次交付 `G4_PRODUCTION_DELIVERY_20260730.md`，监督链修复 `G4_WATCHDOG_RECOVERY_20260731.md`，第二次交付 `G4_PRODUCTION_DELIVERY_20260801.md`。

## 一、这次交付了什么

方案 A（同 7-30 / 8-01）：只搬代码，不换启动机制。Owner 全程在场并逐项授权。

| 项 | 值 |
|---|---|
| 目标 SHA | `91dd0d5`（部署时的 `origin/main`） |
| 此前生产 SHA | `6fb078e`（2026-08-01 第二次交付） |
| 落差 | 25 个提交，全部经真实 CI（windows-latest）合入 |
| 交付动机 | 会话 A 计划项：把最新 main 上机，顺产 G4 第三次交付证据与第五节判据 2 的测试输出素材 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260803`（瞬时，回滚也瞬时） |
| 行为面变化 | 新增能力（Route 1 T09/T10-A/B/C、D28 只读 lookup 消费者等）全部默认关；生产 secrets 未动；未开任何行为开关 |
| **停机窗口** | **18:00:59 – 18:01:57，58 秒** |

## 二、预交付验证（暂存目录，生产未被触碰）

从 `origin/main` 用 `git archive` 导出干净树（不带 `.git`，按 7-30 决定）到 `runtime\app\telegram.new-20260803`，`npm ci`（exit=0）+ `npm install`（exit=0）后跑 `phase1-offline.yml` 列出的**全部 13 个分组**。

**完整输出已归档：`docs/audit/G4_PREDEPLOY_TEST_OUTPUT_20260803.log`（含每组 `npm run` 的完整 stdout+stderr）。** 这份归档即第五节判据 2 所要求的「真 Windows 生产机的 release/cutover 测试完整输出」。

> **归档时做过一次机械脱敏，必须说明**：`scripts/portability-check.js` 的 `windows-user-path` / `windows-drive-path` / `current-username` 三条规则禁止任何 git 跟踪文件出现本机绝对路径与用户名（首次提交时 CI 正是因此而红：`docs/audit/G4_PREDEPLOY_TEST_OUTPUT_20260803.log:166 [windows-user-path]`）。归档版把绝对路径与用户名替换成 `<CYBERLINK_ROOT>` / `<USERPROFILE>` / `<DRIVE_X>` / `<USER>` 四类占位符，**除此之外逐字未改**——分组顺序、退出码、断言文本、失败堆栈均为原样。未脱敏的原始文件留在 `workdesk\20260803-predeploy-full-output.log`（会话中转，不入库）。选择脱敏而不是给 portability 检查开例外，是因为那条规则本身是仓库的正当纪律，不该为归档让路。

| 分组 | exit | tests / pass / fail / skipped |
|---|---|---|
| test:phase1 | **1** | 112 / 111 / 1 / 0 |
| test:phase2 | 0 | 30 / 30 / 0 / 0 |
| test:phase3 | 0 | 160 / 160 / 0 / 0 |
| test:phase4 | 0 | 25 / 25 / 0 / 0 + 118 / 118 / 0 / 0 |
| test:phase5a | 0 | 9 / 9 / 0 / 0 |
| test:p0-closeout-liveness | 0 | 11 / 11 / 0 / 0 |
| test:memory-services | 0 | 50 / 50 / 0 / 0 |
| test:reflect | 0 | 2 / 2 / 0 / 0 |
| test:520-endpoints | **1** | （python 用例，见下） |
| test:route-lanes | 0 | 284 / 282 / 0 / 2 |
| test:catalog-metering | 0 | 34 / 34 / 0 / 0 |
| test:telegram-media | 0 | 42 / 42 / 0 / 0 |
| test:orchestration | 0 | 118 / 118 / 0 / 0 |

**绿 11 / 红 2。两个红的都是环境因素，且这次做了对照实验证明，不是凭印象定性：**

1. `test:phase1` 唯一失败 = `scripts/portability-check.js:8` 的 `git ls-files --cached --others --exclude-standard` → `fatal: not a git repository`。部署树按 7-30 决定不带 `.git`。与 8-01 同签名。
2. `test:520-endpoints` 唯一失败 = `test_deepseek_env_key.py:111` 的 `test_gitignore_covers_private_secret_files` → `AssertionError: .env`。同样要求 git 上下文。与 8-01 同签名。

**对照实验**（在带 `.git` 的工程仓库 `main=14b277e` 上跑同样两条，留证 `workdesk\20260803-predeploy-env-control.log`）：

```text
node scripts/portability-check.js                       -> exit=0  Portability check passed.
python .../tests/test_deepseek_env_key.py               -> exit=0  deepseek env key handling -> ok
```

同一条检查在有 `.git` 时通过、无 `.git` 时失败 —— 环境因素成立，非代码回归。

环境核对：node = `C:\Program Files\nodejs\node.exe` v24.15.0，与生产启动脚本同一可执行文件。

## 三、交付时序（本地 2026-08-03）

| 时刻 | 动作 |
|---|---|
| 18:00:58 | `schtasks /end /tn cyberboss-watchdog` 成功；watchdog 进程数 = 0（本次监督进程本就未运行，见第五节） |
| 18:00:59 | 停 TG：先按 pid file(34400) 核对命令行匹配 `runtime\app\telegram\bin\cyberboss.js` 才动手；逐层杀孙(28600 tool-mcp-server)→子(31160 claude.exe)→本体；确认残留 = 0 |
| 18:01:34 | 换树：`telegram` → `telegram.bak-20260803`，`telegram.new-20260803` → `telegram` |
| 18:01:34 | **坑 3 原样复现**：改名后 `require.resolve('whereabouts-mcp')` = `RESOLVE_FAILED MODULE_NOT_FOUND`（确认 8-01 留证里写的失败模式真实存在） |
| 18:01:36 | 按 8-01 留证的修法：删掉悬空的 reparse point `node_modules\whereabouts-mcp` → `npm install`（exit=0）→ `require.resolve` 返回 `...\telegram\vendor\whereabouts-mcp\src\index.js`，修复确认 |
| 18:01:55 | descriptor 备份 `descriptor.startup.json.bak-20260803-predeploy` 后**只改** `deployed_sha` → `91dd0d5…`；`last_verified_sha` / `verification_mode` 未动（本次同样不是 verified 交付，不伪造验证记录）；写回后核对 BOM=False、JSON 可解析 |
| 18:01:57 | 启动成功：`bridge loop started; waiting for Telegram messages`；pid file = 25808 |
| 18:02:24 | `cyberboss.err.log` mtime 仍是 14:50:58 —— **本次启动零新增错误** |
| 18:02:25 | 恢复监督：`schtasks /run` → watchdog PID 31492 起；watchdog.log 打出 `healthy active release cyberlink-unified-runtime-221a2c: pid 25808 matches ...\runtime\app\telegram\bin\cyberboss.js` —— **监督链闭环** |

逐行流水：`workdesk\20260803-delivery-transcript.log`（会话中转，非权威）。

## 四、交付后真机观察（不是本次交付造成的，但在本次窗口内被发现）

1. **#131「压缩/回合后不回复」的虚报被真机复现。** Owner 18:15 在 Telegram 发消息，先收到 `❌ Runtime process exited unexpectedly`，随后 18:16 收到内容正确的正常回复（含真实旧事）。`err.log` 自 18:09:45 起零新增，说明**没有真正的崩溃**——与只读普查（`workdesk\20260803-tg-command-survey.md` A3）判定的竞态一致：运行时终态事件可能先于 pending operation 登记被消费，于是先弹错误文案、真正那一轮照常跑完。
2. **`memory_context` 在生产上没有执行，但原因有两层**（详见第六节，属 `NEEDS_FABLE`）。

## 五、没做到的 / 保持原状的

- `deployment\current.json` 与 `runtime\telegram\descriptor.startup.json` 及 watchdog 计划任务所用 descriptor **三份互不一致**（`current.json` 的 `telegram_entry` 指向 `releases\cyberboss-phase25a-993d57f\...`，实际运行的是 `runtime\app\telegram\...`）。#77 第 3/4 项原样，方案 B（正规发布包机制）仍未启用，`start-telegram.ps1` 仍硬编码绝对路径。
- **交付前 watchdog 本就没在运行**（无 `watchdog.py` 进程、无 `watchdog.pid`，其日志停在 2026-07-12）；`cyberboss-watchdog` 计划任务只有登录触发、无重复间隔。本次交付后已把它拉起并确认打出健康行，但「监督链在两次交付之间是否持续在岗」这一点，本次证明不了。
- 未开任何行为开关；`CURRENT_STATUS.md` 各 `UNKNOWN` 生产接线判断不因本次交付改变。
- 微信线 legacy 实例（`cyberlink\cyberboss\bin\cyberboss.js start --checkin`）全程未停、未动。

## 六、`NEEDS_FABLE`：能力表与代码事实冲突（本窗只记录，未改状态词）

能力表把 **Telegram memory_context** 与 **Context Trace 覆盖 memory_context** 两行的「生产接线」记为 `WIRED`（＝已接生产入口、只是缺真机验证证据），第三节 G1 说明段（「仍缺什么」）也只写「缺真机执行证据」。

**代码事实**：`src/core/app.js:1175` 在 `runtimeConfig.legacyMemoryRetrieval === false` 时直接返回 `mode: "disabled"`，该配置来自 `src/core/config.js:115` 的 `CYBERBOSS_MEMORY_RETRIEVAL`；而 **`.env.example` 里就是 `CYBERBOSS_MEMORY_RETRIEVAL=0`**，生产 env 同样是 `0`。

**真机证据**（本窗取得，Owner 授权下临时开关 `runtime\telegram\state\context-gates.json` 后取证，取完已逐字段还原）：

```text
context-gates 三门关闭时（8-02 起的现场状态）：
  turn-1785744927629  ts=08-03 08:15:30  memory_context: skipped reason=gated_off
                                          reentry / current_state 同样 gated_off

context-gates 三门开启后：
  turn-1785746040059  ts=08-03 08:34:02  reentry      loaded=True chars=37 hash=12cdbc88…
                                          current_state loaded=True chars=67 hash=e01af496…
                                          memory_context: skipped reason=disabled   <-- 换了原因
  turn-1785746944425  ts=08-03 08:49:04  memory_context: skipped reason=disabled

历史统计（context_trace.jsonl 共 1046 行）：
  memory_context 真的执行过 = 816 行，最后一次 = 08-01 07:50:19
  gated_off = 13 行（8-02 16:09 起）
```

即：**门开着 `memory_context` 也不会执行，因为它被默认关闭的 `CYBERBOSS_MEMORY_RETRIEVAL` 挡在更下一层。**

**为什么这是冲突而不只是缺证据**：按第二节词典，「已有生产接线，但默认或当前关闭」对应 `DISABLED`，不是 `WIRED`。更要紧的是第五节判据 0 要求「Telegram 上 memory_context 实际执行，且 Context Trace 能证明它执行了」——**在仓库默认姿态下这条证据永远取不到**。这需要一个裁定：要么把该路径改为默认开启（产品裁定），要么重新定义 G1 使其对准当前真实的核心读取路径（按需翻档 / `memory_lookup`）。

按协议第二/四节，腐化信号由指挥窗记录、不顺手修，处置一律 `NEEDS_FABLE`。**本 PR 因此没有改这两行的状态词，也没有改判据 0。**

## 七、回滚路径

1. `schtasks /end /tn cyberboss-watchdog` + 杀 pid 文件所指进程
2. 删 `runtime\app\telegram`（新树），`telegram.bak-20260803` 改名回 `telegram`
3. 旧树的 `node_modules\whereabouts-mcp` junction 指向绝对路径，改名回来后需复核 `require.resolve`，必要时重跑 `npm install`（坑 3 对回滚同样成立）
4. descriptor 恢复 `descriptor.startup.json.bak-20260803-predeploy`
5. 执行 `runtime\startup\start-telegram.ps1`，`schtasks /run /tn cyberboss-watchdog`
6. Telegram 说一句话确认应答

## 八、对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 | `PARTIAL` | 仍 `PARTIAL` | 第三次成功交付 + 首次归档预交付全量测试输出（判据 2 素材）+ 首次用对照实验证明红组为环境因素；#77（部署身份单一真相、方案 B）仍未处理，监督链在岗连续性仍无证据 |
| G1 | `PARTIAL` | 仍 `PARTIAL` | 本次未取得 G1 证据，且发现取证被默认关闭的开关阻断（第六节，`NEEDS_FABLE`） |
| G2 / G3 / G5 | 各自不变 | 不变 | 本次不触及其证据面 |

**切生产判据逐条**：判据 2 的素材已归档（`G4_PREDEPLOY_TEST_OUTPUT_20260803.log`），是否即视为该条满足，留给审计裁——本 PR 不擅自勾这一条。其余各条满足状态不因本次交付改变。**仍不得切生产。**
