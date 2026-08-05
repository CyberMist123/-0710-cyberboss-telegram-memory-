# G4 真机交付留证：2026-08-05 第六次交付（000960d → 29d22e5，首次带 G3 chat 启动链恒等式 + 生产 env 绑定）

```text
Status: active
Date: 2026-08-05
Audited SHA: 29d22e5（部署时的 origin/main）
Current authority: docs/CURRENT_STATUS.md
```

本文是**证据存档**，不是结论。当前 Gate 结论一律以 `docs/CURRENT_STATUS.md` 为准。前情：`G4_PRODUCTION_DELIVERY_20260730.md`、`G4_WATCHDOG_RECOVERY_20260731.md`、`G4_PRODUCTION_DELIVERY_20260801.md`、`G4_PRODUCTION_DELIVERY_20260803.md`、`G4_PRODUCTION_DELIVERY_20260804.md`、`G4_PRODUCTION_DELIVERY_20260804_2.md`、电池策略 `G4_WATCHDOG_BATTERY_POLICY_20260803.md`。

## 一、这次交付了什么

方案 A（同前五次）：只搬代码，不换启动机制。Owner 全程在场并明确授权本次生产切换。

| 项 | 值 |
|---|---|
| 目标 SHA | `29d22e5`（full `29d22e5763e731315db0feda383b19b8132d2adf`） |
| 此前生产 SHA | **`000960d`（按活代码树实测）**——descriptor 的 `deployed_sha` 当时写着 `b0d8b68`，是过期元数据，见第五节 |
| 落差 | 1 个 PR：**#159**（G3 启动链恒等式 + 去 `--bare` 走订阅鉴权 + 内建工具面两档 + profile 文件化 + tool MCP server `CYBERBOSS_ENV_FILE` 转发；新增 **D33**） |
| 交付动机 | 让 chat 链在生产上第一次真的可能起来：#159 之前 preflight 验的是"平行宇宙的 launch"，且 `--bare` 下 CLI 永不读订阅登录、tool MCP server 因空 env 启动即退 |
| 备份方式 | 重命名 `runtime\app\telegram` → `runtime\app\telegram.bak-20260805-d6`（瞬时，回滚也瞬时） |
| 行为面变化 | **本次动了 `telegram.env`**（见第四节）：删 `CYBERBOSS_CLAUDE_EXTRA_ARGS`、profile 由长 JSON 单行改为 `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE` 指向文件。两个 route2 开关按 D33 首轮**保持关闭** |
| **停机窗口** | **16:22:19 – 16:23:41，约 1 分 22 秒**（历次最短） |

## 二、预交付验证（源真相仓库 29d22e5，13/13 全绿）

在 **git 源真相仓库**（`【项目】\cyberboss` @ `29d22e5`）用 **PowerShell** 跑 `phase1-offline.yml` 全部 13 组（坑 20：Git Bash 的 GNU tar 会制造 9 个假红），逐组 `exit=0`，另加 `node scripts/portability-check.js` `exit=0`。逐行流水：`workdesk\20260805-predeploy6-verify.log`。

暂存树只做构建健全性：`git archive 29d22e5` → Windows `tar.exe` 解到 `runtime\app\telegram.new-20260805-d6`（631 文件），`npm ci` exit=0，**树内 cwd** 复核 `require.resolve('whereabouts-mcp')` 落在暂存树内。流水：`workdesk\20260805-predeploy6-staging.log`。

平台：Windows 10 生产机本机，Node v22，pwsh 7。同 SHA 的 GitHub CI（windows-latest）四项全绿：`check` / `doc-status-blocks` / `secret-audit` / `phase1-offline`（5m30s）。

## 三、交付时序（本地 2026-08-05 下午）

| 时刻 | 动作 |
|---|---|
| 16:21:58 | D1 停监督：`schtasks /End cyberboss-watchdog` SUCCESS；watchdog 进程数=0 |
| 16:22:04 | D2 停 TG：pid file=26320，先核对命令行匹配 `runtime\app\telegram\bin\cyberboss.js` 才动手 |
| 16:22:19 | D2 `taskkill /F /T` SUCCESS |
| 16:22:19 | D3 换树**第一次失败**：`The process cannot access the file because it is being used by another process`。残留 node 进程逐个核对命令行，均非本树（SillyTavern、`cyberlink\cyberboss` 旧树的 checkin 进程）——是刚被杀进程的句柄尚未释放。**32 秒后原样重试即成功**（坑 8 同类：句柄占目录，别硬来，等一下再试） |
| 16:22:51 | D3 换树成功：`telegram` → `telegram.bak-20260805-d6`，`telegram.new-20260805-d6` → `telegram`；`bin/cyberboss.js` 存在=True |
| 16:23:00 | D4 **坑 3 第五次原样复现**：改名后树内 `require.resolve('whereabouts-mcp')` = MODULE_NOT_FOUND（`npm ci` 建的链指向暂存树绝对路径，改名即失效）。本次 `vendor\whereabouts-mcp` 不是 reparse point（`LinkType` 空、`Directory.Delete` 报"目录不是空的"），直接 `npm install` 重建链即恢复；树内复核 = `runtime\app\telegram\vendor\whereabouts-mcp\src\index.js` |
| 16:23:22 | D5 descriptor：备份 `.bak-20260805-d6-predeploy` 后**只改** `deployed_sha`：`b0d8b680…` → `29d22e5763…`；`last_verified_sha`（`993d57f…`）/ `verification_mode` / `active_release_id` 未动；写回前后首 3 字节均 `123,13,10`（`{` CR LF，无 BOM），JSON 可解析、回读逐字段核对通过 |
| 16:23:3x | W4 改 `telegram.env`（第四节） |
| 16:23:41 | D6 启动：先设 `CYBERLINK_ROOT`（第四次交付记的护栏）后跑 `start-telegram.ps1`，一次成功 |
| 16:27:19 | D7 核对：pid file=33572，命令行匹配新树；`bootstrap ok` / `bridge loop started; waiting for Telegram messages` / desire poller 起；`cyberboss.err.log` mtime 与 size 停在 `08/04 18:19:42 / 23631`（启动前=启动后）——**零新增错误** |
| 16:27:20 | D8 恢复监督：`BatteryStatus=2`（市电，避开电池策略坑）；`schtasks /Run` SUCCESS → watchdog 进程数=1，watchdog.log `healthy active release cyberlink-unified-runtime-221a2c: pid 33572 matches …runtime\app\telegram\bin\cyberboss.js` —— **监督链闭环** |
| 16:28:07 | D9 杀掉启动器 shell 后 bot 仍存活（pid 33572 在），**实证已脱离启动器** |

逐行流水：`workdesk\20260805-delivery6-transcript.log`（会话中转，非权威）。

## 四、本次动了 `telegram.env`（前五次都没动）

`settings/secrets/telegram.env` 不在版本控制内。本次三处改动，均为**非 secret 行**，Owner 在 W15 显式授权由工程窗代填：

1. 删 `CYBERBOSS_CLAUDE_EXTRA_ARGS` —— 与 profile 契约互斥，#159 之后它会在 G3 gate 里直接 `conflicting_args` 拒启动。
2. 删 `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON`（500+ 字符单行）。
3. 加 `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE` → `cyberlink\fable-chat-profile\launch-profiles.json`。

纪律执行情况：改前备份 `telegram.env.bak-20260805-w16`；**BOM 状态原样保留**（实测该文件**没有** BOM——W15 交接写的"带 BOM"与实测不符，凭空加 BOM 会让第一个键名变成 `﻿CYBERBOSS_…` 解析即失效，坑 26 的方向不能照搬到这里）；行数 61 → 60；全程未把任何既有 value 打进对话或日志，回读只核对**键名在场与否**：

```text
EXTRA_ARGS 0 / PROFILES_JSON 0 / PROFILES_FILE 1 / BASE_DIR 1
G3_PREFLIGHT 1 / G3_CONTRACT 1 / MAPPING 1
WINDOW_OVERRIDE 0 / ROUTE2_GATE 0   ← D33 首轮故意不开
```

profile 文件本身（`model` / `effort` / `cwd` / 工具面）在交付前已用真实代码链路（`readConfig` → `createTelegramProfileRouter` → `buildProfileLaunch`）验过一次，见 `workdesk\20260805-g3-chat-cutover-runbook.md` 第 2 步。

**启动成功本身就是 profile 链的第一个真机证据**：profile 与 mapping 的解析是 fail-closed 的启动期动作，任何缺陷都会拒绝启动。

## 五、descriptor 元数据再次说谎（记录）

交付前 descriptor 写 `deployed_sha = b0d8b68`，而活代码树逐文件 EOL 归一比对**实测等于 `000960d`**（`g3-preflight.js` 只有 000960d 才有的 `runDefaultAuthProbe` 在活树里）。即某次交付搬了代码却没改 descriptor。本次已把 `deployed_sha` 改为真值。

**判部署真相的唯一可靠办法仍是比对活代码树，不是读 descriptor 元数据**——这与 #77 的"三套真相"缺口同源，仍未系统性解决。

## 六、真机 canary（第一轮，bridge 侧）—— 16:36 Owner 发消息后

Owner 在 Telegram 发消息，chat 链**第一次真实 launch 成功**。以下是 bridge 侧可核的原始证据（Owner 侧的观感项见文末）。

**1. 这一轮是 profile launch，不是 legacy**

```text
[claudecode-runtime] launching command=…\claude.exe cwd=<USERPROFILE>\.claude-profiles\fable-chat\workspace mcp_config=inherit:1
```

> 本节所有原样输出按仓库纪律（坑 24）做了机械替换：本机用户目录 → `<USERPROFILE>`、工作区根 → `<CYBERLINK_ROOT>`、route token → `<64hex>`。**除此之外逐字未改。**

`cwd` 落在 profile 声明的隔离工作区（**S3/W2 的 agentCwd 派生生效**——同一份日志里此前的 legacy launch 都是 `cwd=…\cyberlink\memory`），`mcp_config` 是 profile 管理形态的标签。

**2. 活体子进程 argv（逐 flag 计数，persona 正文不回显）**

```text
--disable-slash-commands x1   --effort x1   --input-format x1   --mcp-config x1
--model x1   --output-format x1   --permission-mode x1   --permission-prompt-tool x1
--setting-sources x1   --settings x1   --strict-mcp-config x1   --system-prompt x1
--tools x1   --verbose x1

--bare present : False
--tools        : Read,Glob,Grep,WebFetch,WebSearch
--model/--effort: claude-fable-5 / medium
--system-prompt: 329 字符（占位 persona，正文不回显）
--permission-mode: bypassPermissions
```

逐项对上本轮设计：**没有 `--bare`**（D33 去 bare，鉴权走 configRoot 的订阅登录）、persona 经 `--system-prompt` 下发、工具面正是首轮裁定的收窄五项、`--model`/`--effort` 由 profile 发射（此前静默丢失）、权限 `bypassPermissions`（D32）。**每个 flag 恰好出现一次**——没有重复的 `--mcp-config`，即 gate 构造的 launch 与实际 spawn 的 argv 在活体上确实是同一份。

**3. tool MCP server 第一次活下来了（11.1 修复的直接证据）**

```text
node.exe  pid 23548  parent 31712(claude.exe)  args: tool-mcp-server --runtime-id claudecode
          --workspace-root <CYBERLINK_ROOT> --route-token <64hex>
```

进程链 `bot 33572 → claude 31712 → tool-mcp-server 23548`。修复前它在 `loadEnv()` 空手而归后死在启动预检，`cyberboss_system_send` / `cyberboss_time` 从来注册不上；现在它持续存活。

**4. 无一条 fail-closed 触发**：`cyberboss.err.log` 的 mtime/size 仍停在 `08/04 18:19:42 / 23631`（交付前=交付后=canary 后）；日志里 `g3_*` / `launch_drift` / `conflicting_args` / `cwd_lock_mismatch` / `exited during launch` 零命中。

**5. Context Trace 正常**：`memory\trace\context_trace.jsonl` 新增该轮记录，`fallback:false`，`total_chars:149`，续接既有 thread（`reentry`/`current_state` 因 `existing_thread` 跳过，符合设计）。

**仍待 Owner 侧确认的观感项**（粘贴件清单 1/2/4/6/7/8 与 runbook 第 11 项）：persona 是否真的成为系统层（能否复述开头、有无 Claude Code Harness 语气）、首轮有无 `PROFILE ROLE` 块、她自述的工具清单、G2 `memory_candidate_submit` 签署、memory 读写、关窗重开的 Re-entry 注入。**这些没过之前，G3 判据不动。**

## 七、没做到的 / 保持原状的
- 两个 route2 开关（`CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED` / `CYBERBOSS_ROUTE2_GATE_ENABLED`）按 D33 首轮保持关闭；升格工具面这一轮不生效属**预期**。
- persona 正文仍是占位（646 字节），足以过 fail-closed 校验；Owner 填正文后 slot 轮换属预期。
- `deployment\current.json` 旧真相、`start-telegram.ps1` 硬编码、正规发布包机制仍未处理（#77 原样）。

## 八、回滚路径

1. `schtasks /End cyberboss-watchdog` + 按 pid file 核对命令行后杀进程树
2. 删 `runtime\app\telegram`（新树），`telegram.bak-20260805-d6` 改名回 `telegram`；改名后**在树内 cwd** 复核 `require.resolve('whereabouts-mcp')`，必要时 `npm install` 重建链
3. descriptor 恢复 `descriptor.startup.json.bak-20260805-d6-predeploy`
4. **env 必须同时回滚**：`telegram.env` 恢复 `telegram.env.bak-20260805-w16`（旧代码不认 `_FILE`，新 profile 的 `chat-subscription` 也会被旧枚举拒——两者必须同进同退）
5. 设 `CYBERLINK_ROOT` 后执行 `start-telegram.ps1`，`schtasks /Run cyberboss-watchdog`
6. Telegram 说一句话确认应答

## 九、对 Gate 的影响

| Gate | 之前 | 现在 | 为什么 |
|---|---|---|---|
| G4 | `PARTIAL` | 仍 `PARTIAL` | 第六次成功交付（停机 1m22s，历次最短）；首次交付含 env 绑定；坑 3 第五次复现同法修复；#77 仍未处理 |
| G3 | `PARTIAL` | 仍 `PARTIAL` | chat 链首次真机 launch 成功（第六节），`fable-chat` 能力行的生产接线由 `DISABLED` 改 `WIRED`；但差分隔离（fable/work 互不串）与 Owner 侧观感项未验，**离 `VERIFIED` 还差 T11 那一场**，Gate 状态词不动 |
| G1 / G2 / G5 | 各自不变 | 不变 | 本次交付不触及其证据面 |

**仍不得切生产。** 判据状态不因本次交付改变。
