# Current Status

```text
Status: active
Authority: current project status
Last verified: 2026-08-05
Verified against: b0d8b68
```

- `Status: active` —— 这份文件当前有效。
- `Authority: current project status` —— 它是当前进度的**唯一**权威来源。README、`CLAUDE.md`、架构文档都不重复这里的结论，只链接过来。
- `Last verified` —— 最后一次依据源码和运行证据核对的日期。
- `Verified against` —— 这些结论对应哪个 main commit。

历史过程见 `docs/archive/`；已定与已翻转的决定见 `docs/DECISIONS.md`。

---

## 一、Gate 总表

这张表只在本文件维护，其他文档一律链接过来，不复制。

| Gate | 状态 | 中文含义 |
|---|---|---|
| G1 Telegram 核心读取路径 | `PARTIAL` | 代码通路与 Trace 验收结构已接通；真机取证在 Phase 2-5A 期间被启动预检硬禁（`src/core/startup-preflight.js` `validateLegacyMemoryGates`：四个 legacy 记忆开关（`CYBERBOSS_MEMORY_RETRIEVAL` 等）任一为 true 即拒绝启动，无配置绕过；2026-08-04 真机实证，env=1 启动即被拒 pid 秒死）——代码通路真实存在、被阶段设计有意封存，非缺陷降级也非单纯"缺证据"。解锁属设计决策，候选路径（推进出 Phase 2-5A ／ 给预检开受控例外〔不推荐〕／ 重定义判据对准现行核心读取路径）见 `DECISIONS.md` Candidates C7 |
| G2 后台记忆写入边界 | `PARTIAL` | 候选权限闸门、nightly 登记、#73 effective decision 与 G2-3 Review artifact 已闭环；G2-4/G2-6 已把 publication intent/outbox 与 candidate rewrite lineage 同步接入 Review→History：decision/candidate 两层 supersede 拆名，History 只消费唯一有效叶子的 accepted head，以 lineage publication key 保证 Review 重跑、History 崩溃、state 重放与 decision ID 变化后的整链 exactly-once；stale/digest/fork/cycle/已发布 predecessor 均 fail-closed，发布后 decision 翻转只记冲突、不改 canon（与 artifact 共用显式默认关闭开关，阻塞 CI 覆盖）。G2-5 已闭环 dispatcher/一次性注入/ack 回路（D26：严格实时、window_gone 作废不递继任者、补投一次即止、失败递送只读聚合视图、注入块确定性组装；独立开关默认关闭）。G2-2 此前只有同进程合成测试，生产 `tool-mcp-server` 实际落到 null stub、不可签署；现已改为窄鉴权 IPC broker：capability 圈禁主进程，主 bridge 是 `SubjectCandidateService` 唯一可写 owner，child 保留 schema/hard-ceiling/lease/self-escalation 后经 capability-free 请求交主进程按权威 turn/session/profile/route 独立复核。真实 `bin/cyberboss.js tool-mcp-server` 跨进程正例、work 双拒、turn 终结、鉴权/超时/重放与并发幂等均进入三个阻断组；真机 canary 与生产启用仍缺，故 G2 保持 `PARTIAL`。G2-7 已落离线只读分类器与 companion binding（零升级/零猜路由/可重跑，默认关、未接消费者、未在真实存量上运行）；剩余：真机留证、生产启用（开关默认 false）、G2-7 真实存量执行、G2-8 睡眠兜底（D28 只读 lookup 消费者已随 #125 实施，旧候选按 route 作用域经 `memory_lookup` 只读可查——详见下方能力表 G2-7 行） |
| G3 Chat 成本与 profile 隔离 | `PARTIAL` | T03 preflight、T04 双 profile 身份/permission/MCP ceiling 与 T05 同窗口 mutable override/Context Trace 离线闭环已落地；T05 挂 `CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED` 且默认关闭，model/effort/effective toolset/effective MCP set 与非人格 overlay 不进入 slot 身份，persona/permission identity 变化仍换窗，chat 非成员工具自助升格不走审批且无硬 ceiling；2026-08-05 契约语义按 D32 纠偏：persona 文件整体经 `--system-prompt` 成为系统层（首轮 role card 注入退役、wechat instructions 不回流）、fable-chat 权限映射 CLI `bypassPermissions`（隔离改由 configRoot/session slot/env allowlist/strict MCP 承担）、`chat-ceiling@2` 放行部署配置的外部 MCP 基集（override 子集校验不变）；本地 profile 资产目录已备（cyberlink `fable-chat-profile\`，manifest.csv 为装配真相，粘贴件在 workdesk）；2026-08-05 启动链按 **D33** 修复恒等式——G3 preflight 构造的 launch 即 spawn 的 launch（raw `extraArgs`、route-scoped MCP 路径、window override、两个部署审批全部进 gate，spawn 前重算比对不等即 `launch_drift` fail-closed），`agentCwd` 由 profile `cwd` 派生使 `cwd_lock_mismatch` 退化为恒真保险带；chat 档去 `--bare` 改订阅鉴权（`harnessMode: chat-subscription`，persona 下发与 bare 解绑）、内建工具面默认收窄 + route2 lease 升格全功能、profile 移入独立文件（`CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE`，与 `..._JSON` 互斥 fail-closed）、`tool-mcp-server` 补转发 `CYBERBOSS_ENV_FILE`（此前 G3 剥 env 后该 server 启动即退，两个常驻工具永不注册）；以上均为离线 CI 覆盖（`test:route-lanes`）；2026-08-05 第六次交付已把该代码与 profile 绑定送上活体（`telegram.env` 改走 `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE`，两个 route2 开关按 D33 首轮保持关闭，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260805.md`）——2026-08-05 16:36 **chat 链首次真机 launch 成功**（Owner 发消息触发）：活体 argv 实测无 `--bare`、persona 经 `--system-prompt`、`--tools Read,Glob,Grep,WebFetch,WebSearch`、`--model claude-fable-5 --effort medium`、`bypassPermissions`，每个 flag 恰好一次（gate 与 spawn 同一份），cwd 落在 profile 的隔离工作区，且 **`tool-mcp-server` 第一次持续存活**（11.1 修复），err.log 零新增、无任何 fail-closed 触发——故该能力行生产接线由 `DISABLED` 改 `WIRED`。**仍缺**：fable/work 差分隔离与 Owner 侧观感项（persona 复述、工具清单自述、G2 签署、Re-entry），未到 `VERIFIED`，**T11 那一场仍欠** |
| G4 Windows 生产验证 | `PARTIAL` | 2026-07-30 首次真机交付成功并已留证（`docs/audit/G4_PRODUCTION_DELIVERY_20260730.md`）；2026-07-31 监督链已修复并经真实停机事故验证（BOM 去除 + `deployed_sha` 改真话 + watchdog 判活恢复，留证 `docs/audit/G4_WATCHDOG_RECOVERY_20260731.md`）；2026-08-01 第二次交付成功（main `6fb078e` 上机，首次监督链在位热交付，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260801.md`）；2026-08-03 第三次交付成功（main `91dd0d5` 上机，停机 58 秒，**首次归档预交付全量测试完整输出** `docs/audit/G4_PREDEPLOY_TEST_OUTPUT_20260803.log`，并用对照实验证明两个红组为无 `.git` 的环境因素，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260803.md`）；2026-08-04 第四次交付成功（main `bf31e62` 上机，停机约 10 分钟，预交付测试移回 git 源真相仓库 13/13 全绿——8-03 两红组在真 git 环境如预期转绿，反向印证环境因素定性；坑 3 junction 断裂第三次复现同法修复；停机窗口内含一次 G1 env 实验被启动预检 fail-closed 拦截的实录，已回退、交 fable 审，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260804.md`）；2026-08-04 第五次交付成功（main `a4c5b54` 上机，停机约 5 分钟，**首次带 G2 主体签署 IPC 代码上机**，预交付源真相 13/13 全绿——两红组经 PowerShell 对照证为 Git Bash tar 环境噪声，坑 3 第四次复现同法修复，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260804_2.md`）；2026-08-05 第六次交付成功（main `29d22e5` 上机，**停机 1 分 22 秒，历次最短**，首次带 G3 chat 启动链恒等式代码与**首次由工程窗代改 `telegram.env`**（profile 改走 `..._FILE`，非 secret 行，Owner 授权、备份先行、BOM 原样保留）；预交付源真相 13/13 全绿 + portability，坑 3 第五次复现同法修复；**再次实证 descriptor 元数据说谎**——交付前 `deployed_sha` 写 `b0d8b68`、活代码树实测为 `000960d`，判部署真相只能比对活树，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260805.md`）；2026-08-05 第八次交付成功（main `3447ffd` 上机，停机 4 分 55 秒——含一次失败启动：**robocopy `/MOVE` 顺着 `node_modules` 的 junction 把 `vendor\` 两个 `file:` 依赖搬空**，补回后二次启动成功；本次同批改了三处生产配置：profile 两份资产剥六键、`telegram.env` **首次打开目录开关**；留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260805_3.md`）；2026-08-05 第九次交付成功（main `01810c5` 上机，停机约 2 分 20 秒——含一次失败启动：暂存树 npm ci 给 `file:` vendor 依赖建的**绝对路径 junction 在换名后悬空**（坑 3 新变体），重建两条 junction 后二次启动成功；纯代码树交付无配置变更，预交付源真相 13/13 全绿 + portability，活树 EOL 归一比对与 commit 逐字节一致，留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260805_4.md`）；部署身份其余两套真相与正规发布包机制仍未处理（#77）；监督链此前失岗根因已明并于 2026-08-03 修复（电源策略：`DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` 两开关 + 电池供电致静默失岗，留证 `docs/audit/G4_WATCHDOG_BATTERY_POLICY_20260803.md`），起于电池已证、跨电池→市电已扛，跨夜与切回电池方向的持续性仍在累积 |
| G5 备份与回滚验证 | `PARTIAL` | 2026-08-03 真机 memory 备份恢复演练已完成并留证（`docs/audit/G5_MEMORY_RESTORE_DRILL_20260803.md`）：真档快照 155/155 → 隔离副本破坏后确被检出 → 恢复逐字节还原 → 真档原地恢复后独立复核一致；缺口明确——**release 回滚（`phase1-rollback.ps1`）未真机演练**，`runtime`/`settings`/`releases` 的备份恢复不在本次范围 |

**是否允许切生产：否。** 判据见第五节。

---

## 二、状态词典

能力表的每一列只允许使用下列状态词。**不要自造近义词**，也不要用 ✅ / ❌ / “可用” / “部分” 这类自由文本 —— 它们在多轮 PR 之后会各自漂移。

| 维度 | 允许状态 | 中文解释 |
|---|---|---|
| 代码 | `WIRED` | 已进入目标主运行链，真实调用可达 |
| 代码 | `PARTIAL` | 只有部分 provider、lane 或路径可达 |
| 代码 | `ORPHAN` | 代码存在，但目标主路径不可达或无人调用 |
| 代码 | `ABSENT` | 没有对应实现 |
| 测试 | `COVERED` | 有针对真实目标通路的验收测试 |
| 测试 | `UNIT_ONLY` | 只有函数或组件单测，没有真实主路径测试 |
| 测试 | `PARTIAL` | 部分行为有测试，关键边界仍未覆盖 |
| 测试 | `NONE` | 无对应测试 |
| 主 CI | `BLOCKING` | 已进入阻塞合并的主 CI |
| 主 CI | `NONBLOCKING` | 有自动化信号，但不阻塞合并 |
| 主 CI | `NONE` | 无自动化 CI 信号 |
| 生产接线 | `VERIFIED` | 已在真实生产 Windows 上验证 |
| 生产接线 | `WIRED` | 已接生产入口，但尚无真机验证证据 |
| 生产接线 | `DISABLED` | 已有生产接线，但默认或当前关闭 |
| 生产接线 | `NOT_WIRED` | 没有生产接线 |
| 生产接线 | `UNKNOWN` | 仓库无法判断真机实际状态 |
| 总体结论 | `PASS` | 当前范围已满足 |
| 总体结论 | `PARTIAL` | 部分满足，但仍有明确缺口 |
| 总体结论 | `FAIL` | 当前关键目标未满足 |
| 总体结论 | `DEFERRED` | 明确不在当前阶段施工 |
| 总体结论 | `NOT_VERIFIED` | 可能已具备，但缺少所需证据 |

两条使用纪律：

1. **`BLOCKING` 是对"这条能力的目标通路"说的，不是对"某个相关单测"说的。** 一个 resolver 单测进了 CI 分组，不代表它覆盖的完整通路有 CI 信号。
2. **仓库证明不了的一律 `UNKNOWN`**，不要写成 `NOT_WIRED` 或 `DISABLED`。生产机的环境变量与计划任务状态不在版本控制内。

---

## 三、能力表

| 能力 | 代码 | 测试 | 主 CI | 生产接线 | 说明 / 当前结论 |
|---|---|---|---|---|---|
| Telegram 主链（poller / adapter / envelope） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 信封格式有 CI 测试钉住；真机运行状态未核 |
| Telegram route lanes v2 / profile router | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | `test:route-lanes` 已接进主 CI |
| G2 recorder route snapshot / `subject_route` schema | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— recorder 真实写入路径冻结 canonical route/session/window 快照，closeout 与主体签署材料包按 source entry ID/hash 取证，envelope 只收权威 EXACT schema；缺身份保持 PARTIAL/ambiguous。G2-4 publication intent/outbox 已闭环并进入 `test:phase3`，Review artifact/outbox 共用开关继续默认关闭；G2-5 dispatcher/注入/ack 已闭环（独立开关默认关）；G2-2 的 `memory_candidate_submit` 已从此前生产不可用的 null-stub 路径改接窄鉴权 IPC，离线跨进程阻断验收通过，真机 canary 仍缺 |
| G2 存量候选分类 / companion binding（G2-7） | `WIRED` | `COVERED` | `BLOCKING` | `NOT_WIRED` | **`PARTIAL`** —— 离线 CLI 默认只读，显式 `--apply` 才以 migration 单 writer 幂等追加 companion；严格 route/source 合取、零升级、零猜路由，迁移开关默认关闭，未在真实存量上运行。§10-3 已由 **D28** 裁定并落地只读消费者：`EXACTLY_RECOVERABLE` 旧候选仅在 companion binding 同时匹配当前 `routeToken` / `laneKey` 时，经主体自拉的既有 `memory_lookup` 返回；缺失、损坏、不可判、跨 route 或 `LEGACY_DEFERRED` 均零命中且不影响其它来源；不进任何注入通路，命中明示旧后台存量、非主体笔迹，永不自动升格。生产 companion 数据面仍为空，故当前无可观察行为变化 |
| G2 Review publication intent / History outbox | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | Review 在 decision 与必需 artifact 完成后以稳定 ID append-only 写 intent；candidate rewrite 用 `supersedes_candidate_id`，canon correction 输入用 `canon_supersedes`，两层不混。History 只消费唯一有效 lineage leaf 的 effective accepted head，并在独立 writer state 记录 consumption、publication key 与 lineage root，守住 Review 重跑、History 崩溃、state 重放及 decision ID 变化后的整链 exactly-once。fork/cycle/缺前驱/跨类型/已发布 predecessor、stale decision 与 digest 不符均不发布；发布后 decision 翻转只记 `post_publish_decision_conflict`，canon 不删不改。与 Review artifact 共用 `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED`，仓库默认关闭 |
| G2 handoff dispatcher / 一次性注入 / ack（G2-5） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_HANDOFF_DISPATCH_ENABLED`，仓库默认关闭（关闭时零副作用、payload 逐字节不变）。开启时：EXACT canonical fingerprint 匹配原窗口才注入一次性 `<subject_memory_handoff>` 块；同稳定 slot 但 native transcript 已换判 `window_gone` 作废不递继任者（D26-1）；补投一次即止 + 只读聚合视图（D26-2）；注入块确定性组装（D26-3）；delivery/ack 两账独立 writer + 独立 lease；purity 剥除 handoff/ack 块；Trace 只记解释字段。测试进 `test:phase2` / `test:phase3` / `test:route-lanes`（均阻塞主 CI）。ack 的同 turn 关联为进程内 map（崩溃丢 ack 不重放正文），跨重启补 ack 归后续单 |
| G2 主体签署 capability / 材料包（G2-2） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_SUBJECT_SIGNING_ENABLED`，仓库默认关闭。开启时：真实交互 fable subject turn 签发一次性 turn+route capability；原始值仅存主进程内存，不进 IPC/argv/env/runtime-context/磁盘/日志。`tool-mcp-server` 不持有可写 `SubjectCandidateService`，handler 先过既有 child 执法，再把模型字段与 turn/route 坐标交窄鉴权 IPC；主 bridge 以自身 active context、session/profile/route 与 capability registry 复核后由唯一 owner 落候选，回 child 不含 capability。缺 broker、超时、身份不符、重放或 turn 已终结只拒该工具调用，不中断聊天。真实跨进程 fixture 已进 `test:phase3` + `test:route-lanes` + `test:catalog-metering`。**补记（第二处接线债，2026-08-04）**：MCP 子进程是隔离 env，tool 注册门 `tool-host.js` `registeredProjectTools` 读子进程自身 env 的 `subjectSigningEnabled`；而 `project-settings.js` 此前只把 route2/catalog/override 转发进子进程 env、**漏了 `CYBERBOSS_SUBJECT_SIGNING_ENABLED`**，致真机上开关虽开、工具永不注册（离线 fixture 手搭子进程 env 未能捕获）。已修：adapter 按 fable-chat 作用域转发该开关 + 补 adapter 生成路径测试。**补记（第三处接线债，2026-08-05 首轮 canary 实证）**：转发到位之后工具**仍未注册**——生产 `telegram.env` 写的是 `=1`（仓库惯例），bridge 侧用宽松真值判定判开并转发字符串 `"true"`，而子进程侧 `tool-catalog-manifest.js` 用的是 `=== "true"`；子进程自本轮 `CYBERBOSS_ENV_FILE` 转发起真的会 `loadEnv(override)`，把 `"true"` 换回 `1`，于是同一个开关两侧结论相反。已把真值判定收进 `src/core/env-flag.js` 单一 helper，bridge / 子进程 / `catalogEnabled`（同一颗雷，只是恰好没被 env 文件覆盖过）/ route2 / window override 全部改用它；回归守卫按部署原形 `=1` 断言（含跨进程 MCP 目录），改回严格相等即红。真机 canary 仍未做，生产保持默认关闭 |
| Telegram 媒体入站（media inbox） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | `test:telegram-media` 已接进主 CI |
| Telegram 图片识别 / OCR（CMX recognize） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 默认关闭；显式 `caption + cmx-recognize` 后，已落盘 photo 才上传到当前 CMX 部署的 `/files/recognize`。识别结果以信封外 untrusted 附件块进入该次 turn，用户正文逐字不变，purity 阶段剥除，provider 失败不阻断原图/原文。依赖 CMX 部署实际包含该端点；尚无真实 Windows + Telegram 图片 canary |
| Hard context · Re-entry | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— 由运行时适配器的 opening context 注入；2026-07-30 生产实测 `memory/reentry.md` 954 非空白字 > 300 预算，注入实际为零（err.log 连记 `reentry skipped reason=over_budget`）。#76 已加 last-known-good 降级、发布前预算硬闸门与 trace 的 configured/effective 分离；**正文压缩归聊天窗主体 AI，尚未做**，且生产机上没有可用副本，所以首次仍会是空注入 |
| 账本（details）外置存储 | `PARTIAL` | `COVERED` | `BLOCKING` | `NOT_WIRED` | #76 目标 1：`details.jsonl` 存储、`type: details` 权限门、History writer 发布与 `memory_lookup` 读通路已闭环并有边界测试（第三档完全按需，永不注入）。**写侧没有 producer** —— 主体 AI 产出账本候选的入口未接，也不做自动提取；生产无数据 |
| Hard context · Current State | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 同上；与 memory_context 不是同一条通路 |
| **Telegram memory_context** | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 逻辑经 `buildRuntimeTurn()` Telegram 分支可达，信封外 `<memory_context>` 块，fail-open；生产接线因 `CYBERBOSS_MEMORY_RETRIEVAL=0` 默认关闭（`.env.example:58`；`app.js:1175` 在 flag 为 false 时直接返回 `mode:"disabled"`），真机执行证据缺失 |
| Context Trace 覆盖 memory_context | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | trace blocks / skipped 已解释 memory_context（所有 provider 的 turn 路径）；生产接线随 `CYBERBOSS_MEMORY_RETRIEVAL=0` 默认关闭而不执行，真机证据缺失 |
| `memory_lookup`（Phase 5A，仅 user_pull） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 受控翻档；真机使用情况未核 |
| 工具按需取用（timeline / weather / diary / sticker） | `WIRED` | `PARTIAL` | `NONE` | `WIRED` | 工具存在且注册，边界测试不全；timeline / sticker 组件测试已接入主 CI 的 `test:phase1`，但按第二节纪律 1 不代表整条工具通路为 `BLOCKING`。Windows CI 中 sticker 仅执行 5 条平台无关用例，依赖 macOS `sips` 的 3 条 PNG → GIF 用例恒 skip，因此仍是部分覆盖 |
| MCP 工具分组隐藏（省 schema token） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | T02/T02.5 目录化已落地：单一 manifest（`src/tools/tool-catalog-manifest.js`）为唯一分组与主题 authority，tool-host / MCP resources / CLI / 计量四个消费方共用。挂 `CYBERBOSS_TOOL_CATALOG_ENABLED` 默认关闭（关闭时 tools/resources/route config 与基线逐字兼容）；开启时按八个意图主题分级，常驻面恰好 3 项（单一 `cyberboss_catalog` + `cyberboss_system_send`/`cyberboss_time`，常驻工具 schema 15,810 → 373 chars，只证明 MCP 出牌字符面，不声称模型侧 token 节省），一级计数与二级清单剔除 alias/hidden，完整 schema 可按 handle 跳级加载；目录可见 ≠ 调用权（toolset 白名单 fail-closed，`chat-core@1` 已定义；授权边界仍归 G3/T04）；hidden/deprecated 条目仍可查询打标。**非常驻工具的调用经 catalog invoke**（D34，2026-08-05 补 C8 缺环）：`cyberboss_catalog` 增 `arguments` 用法，`{handle, arguments}` 解析出 canonical 名后重入现有 `invokeTool`，authorizationCeiling / lease / toolset 白名单 / 自助升格记录 / 参数校验 / `max_result_bytes` 全部沿用（invoke 吃 `g3_call_not_authorized` 而非 schema 码），结果原样透传；`listTools()` 与 `listChanged:false` 不动，广播面恒定 3 项。resources 后门同步收窄；测试进 `test:catalog-metering` + `test:route-lanes`（阻塞主 CI），full/resident 计量 fixture 钉住，目录开/关摆动（373 vs 15,810 chars）兼任 D34 回归判据。**2026-08-05 第八次交付首次在生产打开该开关**（此前 `CYBERBOSS_TOOL_CATALOG_ENABLED` 在生产 env 里根本不存在，目录相关代码在活体上一直休眠）：生产机 / 生产树 / 生产 env 下实测广播面由 31 工具 13,811 字节收到 **3 工具 798 字节**，**catalog invoke 真调通一个从未广播过的工具**（`memory/memory_lookup`，`isError=false`），调用前后 `tools/list` 逐字节相同；留证 `docs/audit/G4_PRODUCTION_DELIVERY_20260805_3.md`。**2026-08-05 21:17 行为面亦已真机通过**（Owner 在场，三项，全程未提示使用 catalog）：写日记（`cyberboss_diary_append` → `state\diary6-08-05.md` 实文件落盘）、额外发一条 Telegram（`cyberboss_telegram_send`，Owner 侧真实收到）、翻档查「测试」（`memory_lookup` → `memory
ecall_log.jsonl` 记 `hit_ids:["ep003","ep009"]`、lookup 预算 4→3→2 单调递减）。三个工具**都不在常驻 3 项里**，只能经 catalog invoke 到达；期间 `cyberboss.err.log` 零新增、watchdog 持续 healthy。故生产接线由 `DISABLED` 直升 `VERIFIED` |
| Memory 目录化（注入目录而非命中行） | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | D25-A 已解除 `DEFERRED` —— memory/tool/MCP/skill 统一走分类目录方向获批；实施尚未开工 |
| 子代理结果胶囊化 / Route 1 task-session core（T09） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | D14 胶囊契约与独立 `runTaskSession()` core 已实现；T10-A 在新增 `CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED`（默认关闭且要求 T09 开关同时开启）后补齐离线预防边界：worker 由编排器供给独立 git worktree 以隔离锁域，建卡时 fail-closed 拒绝与活 memory/continuity/state/settings-secrets/profile-configRoot 重叠的 workspace/allowed_paths，并把这些绝对根并入 forbidden_paths；work profile 加 Write/Edit deny，完成后由编排器自跑 git 取证再验胶囊。T10-B 已接主 Chat 的异步单飞派活控制器（turn 内仅建卡入队）、5/15/60 双上限与本窗口自确认、软停小轮边界/硬停杀进程两级中断、立即「收到」与 Context Trace；T10-C 已接独立 `state/route1/task-results.jsonl` 单 writer 结果留存、origin current/pending/expired 三态、一次性确定性通知、主动状态/领取工具及已终结窗口来源标记；全套默认关闭，未做真机。保护对象仅为活运行时数据，不按名称封锁源码；无 OS 沙箱，Bash 绝对路径逃逸仍是明确残余风险 |
| 记忆服务层（validator / resolver） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **9 个**测试文件已接 `test:memory-services`（note-service / resolver / service-cleanup / service-formal / validator / command-router / memory-command / seven-day-cleanup / validator-integration）。**extractor 一侧已按 `DECISIONS.md` D23 整条退役** —— 正则分桶抽取器与 post-response 自动写入 pipeline 已删除，系统不再替主体 AI 决定该记什么；退役由 `test/phase1-offline-config.test.js` 的守卫钉住。#91 修绿的 `memory-command` / `memory-seven-day-cleanup` / `memory-validator-integration` 三个已接进 `test:memory-services`，本行不再有无 CI 信号的测试。本行剩余的 validator / resolver 仍是 memory_context 读取通路与 `/memory` 命令的实现方，读取侧改造归 #42（见 D21。**另**：`memory_note` 的 Self-note 写入通路（#74）已与 History writer 收敛到同一把 writer lease、改为只追加，回归测试进 `test:phase3`（阻塞主 CI）|
| Closeout liveness | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 调度器已接入 `app.js`；`test:p0-closeout-liveness` 已接进主 CI；生产机开关状态仓库无法判断 |
| nightly closeout | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | **`PARTIAL`** —— D18 业务日、时区统一及空结果重试/封存语义已实现，五类边界测试进入 `test:phase3`；仓库默认关闭，生产机实际状态未核 |
| Reflect / 低频重读（rereadings） | `ORPHAN` | `UNIT_ONLY` | `BLOCKING` | `NOT_WIRED` | **`FAIL`** —— 无调度器调它，`runtime.reflect()` 无实现方。`test:reflect` 已接主 CI，但按第二节纪律 1，那只是给这个孤儿模块提供回归信号，**不代表目标通路有 CI 覆盖**；代码仍 `ORPHAN` |
| `/effort` | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 2026-08-05 与 `/model` 一并修复切换不生效：根因是 window override 只存 slot 级、线程轮换连坐清除后静默回退（`clearSlotThreadId` 删整个 slot），修复为 window override 与 workspace runtime params 双写（slot 清空后选择可恢复）；同批把 claudecode 目录扩为与 Claude Code 选单一致的 8 现役型号 + 别名（fable/opus/sonnet/haiku 5 系与 4.x 系），目录非空时未知型号拒绝并回列表；用例进 `test:phase1` + `test:route-lanes`（阻塞主 CI）；已随 2026-08-05 第九次交付上机（`01810c5`，见 `docs/audit/G4_PRODUCTION_DELIVERY_20260805_4.md`），Owner 行为面验证（切换后 argv 实测 + 轮换幸存）待做 |
| `/pause_heartbeat` / `/continue_heartbeat` | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 单 writer 持久态、三类 poller/tick 与来源定向队列暂停均已接主链；窗口聊天和用户 reminder 明确不受影响。已随 `6fb078e` 上生产（2026-08-01），暂停态经文件预置生效。2026-08-04 前端 token 由 `/pause activity` `/continue activity` 改名为单 token `/pause_heartbeat` `/continue_heartbeat`（归入 Autonomy 组）；生产仍跑旧两词形态，改名形态待部署。`/pause` `/continue` 的命令级真机证据仍缺 |
| Desire（八维状态 + hourly poller） | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 最小闭环代码与生产落盘形态集成测试已进仓库；挂 `CYBERBOSS_DESIRE_LOOP_MINIMAL_ENABLED`，默认关闭，生产机实际开关状态由不入库的 secrets 决定 |
| 520 · 只读视图与健康度 | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 面板由独立计划任务拉起，真机状态未核 |
| 520 · 活跃写端点（提示词 / 分层 / 门控 / 调度） | `WIRED` | `PARTIAL` | `BLOCKING` | `UNKNOWN` | 改生产行为的端点覆盖仍不全（故测试记 `PARTIAL`）；`test:520-endpoints` 已接主 CI，覆盖提示词写路径的保存/恢复、50 路由总账、18 个黑盒读端点契约、sleep-window 读写与 Node 同进程即时重读、DeepSeek 密钥处理；`reentry` 保存分支已与 Node History writer 共用同一把跨语言 writer lease，撞锁显式返回 409 |
| 520 · 安全冻结写端点（5 个） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 按设计冻结，见 `DECISIONS.md` D5 |
| 520 · 关怀页写路径（care config / cycle） | `PARTIAL` | `PARTIAL` | `NONE` | `NOT_WIRED` | 后端在、前端未接完；不是安全边界 |
| 520 · 剧场页（theater scripts） | `WIRED` | `NONE` | `NONE` | `UNKNOWN` | 纯展示只读 |
| Windows release / watchdog 控制平面 | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— 2026-07-30 首次真机交付留证已归档（`docs/audit/G4_PRODUCTION_DELIVERY_20260730.md`：方案 A 只搬代码，bot 存活并真实应答 Telegram）。**监督链已于 2026-07-31 修复**：描述文件去 BOM、`deployed_sha` 改为运行树真实来源（48660a9），watchdog 判活恢复 `healthy`，重启自愈链路闭合；修复前发生过一次真实停机（~2.5 小时，机器重启后无人拉起），事故与修复过程留证 `docs/audit/G4_WATCHDOG_RECOVERY_20260731.md`。2026-08-01 第二次交付（`6fb078e`，监督链在位热交付 + junction 断裂坑 3 留证）见 `docs/audit/G4_PRODUCTION_DELIVERY_20260801.md`。**仍未处理**：`deployment/current.json` 旧真相、`start-telegram.ps1` 硬编码、正规发布包机制（`install-descriptor` + 候选启动器）从未启用 —— 归 issue #77。2026-08-04 起 watchdog 存活可经 Telegram `/status` 只读回看（读 `CYBERBOSS_WATCHDOG_LOG` 指向的 `watchdog.log` 最近 `healthy` 心跳新鲜度，>180s=`LOST`；env 未设时显示 `unconfigured`，fail-open 不谎报）——诊断面，不改本行判据；生产机需设该 env 才显示真数据 |
| 备份与回滚演练 | `WIRED` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | **`PARTIAL`** —— memory 备份/恢复：工具 `scripts/memory-backup.js` 已落地，11 条用例进 `test:memory-services`（阻塞 CI），2026-08-03 完成真机演练留证并含真档原地恢复（`docs/audit/G5_MEMORY_RESTORE_DRILL_20260803.md`）；release 回滚：`phase1-rollback.ps1` 无真机演练证据。**四个列词按整行口径保守取值**——本行同时覆盖这两件事，回滚那半既无测试也无真机证据，故不随 memory 那半升格 |
| G3 CLI preflight / 独立 config root（T03） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED`，仓库默认关闭（关闭时 launch 与基线逐字兼容）。开启时：`configRoot` 经 env `CLAUDE_CONFIG_DIR` 归一进 profile fingerprint / slot 身份；八个 required CLI flag、env allowlist、auth 探针、cwd 与 lock key 同源任一失败均在切换前 fail-closed，旧进程继续服务。测试进 `test:route-lanes`（阻塞主 CI）。**离线硬边界证据**，不证明 fable/work 真隔离——差分 canary 与真机验收属 T04/T11 |
| `fable-chat` profile 绑定 / per-lane active window pointer | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 挂 `CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED` 且强依赖 T03 preflight 开关，均默认关闭。schema v3 固化 `fable-chat` / `work-engineering`：persona/configRoot/cwd/permission identity/authorization ceiling 进入 slot 指纹；fable 走 `chat-subscription`（**不发 `--bare`**——该模式下 CLI 只认 API key，订阅登录永不被读；鉴权即 `configRoot` 里的 `claude login`，D33）+ skills disabled + isolated user source，persona 文件整体经 `--system-prompt` 成为系统层（D32：role card 首轮注入退役、wechat instructions 两路不回流、`systemPrompt`/`outputStyle` 字段双拒），CLI 权限映射 `bypassPermissions`、外部 MCP 走 `chat-ceiling@2` 部署基集（隔离由 configRoot/slot/env allowlist/strict MCP 承担，不再靠权限降级）；内建工具面按 D33 分两档：`builtInTools` 默认面（chat 档必填，缺失 fail-closed）+ `escalatedBuiltInTools` 经 route2 lease 升格（升格是 launch 变更，子进程重启并 `--resume` 续会话）；上机按 D33 分两轮，**首轮两个 route2 开关保持默认关**——默认面即唯一面属预期，重活走 route1，升格回路留第二轮单独验；fable 目录与发送/时间核显式启用但不挂硬 toolset ceiling，work 工程能力不减且关系记忆 schema/call 双拒。T06 在同一开关下增加进程内 per-lane active profile 指针与 `/profile`：完整 profile 切换走各自 fingerprint slot，切回只 resume 该 profile 自己的 native session；指针不保存 threadId、不改变 continuity binding，unknown profile 原子失败，退稿仍只在 origin window 再次成为当前窗口时 EXACT 投递，origin transcript 终结则 `WINDOW_GONE` 作废。route-scoped MCP server ceiling 与目录发现独立，关闭时 launch/profile/slot/MCP config、命令/help 与基线逐字兼容；测试进 `test:route-lanes` + `test:catalog-metering`（阻塞主 CI）。2026-08-05 契约形状收窄六个字段（`residentToolSchemas` / `mcpServerCeiling` / `toolsetCeiling` / `envPolicy` / `defaultToolset` / `defaultMcpServerSet`）——它们本就被契约强制等于 `profileId` 决定的常量，改为代码派生，语义与 `launchFingerprint` 均不变（有指纹不变量测试钉住，session slot 不因此轮换）；该剥键已随 2026-08-05 第八次交付在生产完成（profile 与 schema 两份资产同批改，剥键前后 argv/env 键集/`launchFingerprint` 逐字节相同，slot 未轮换）；真实 local profile/mapping 与差分 canary 归 T11，未声称真机隔离通过 |
| G3 Route 2 gate / 单次操作 lease（T07/T08） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_ROUTE2_GATE_ENABLED` 且默认关闭；A/B 成本门与结构硬门只产出“留 Route 2 / 转 Route 1”，不削减 chat 能力。单次 lease 复用既有 session slot 与 window override 指纹，以同一 `storedThreadId --resume` 接管 tool/MCP/带标签非人格 overlay；完成、失败、TTL、cancel、强中断与 restart 均回收，过期成员 schema/call 双拒而目录仍可浏览。真实 `tool.use`、逐工具 `max_result_bytes`、server 截断与成本 Context Trace 已接通；测试进 `test:route-lanes`、`test:catalog-metering`、`test:phase2`（阻塞主 CI），未做真机启用 |
| Codex 作为子代理运行时 | `PARTIAL` | `COVERED` | `BLOCKING` | `NOT_WIRED` | 有界委派协议与离线闭环已实现；2026-07-28 用真实 Codex 跑通一次 canary（只改 `test/`，边界成立，验收测试通过，判定 accept）。**仓库内没有把 Codex adapter 绑进委派 runner 的代码**，运行时由调用方注入，离线测试用 fake；主 Chat 未接 |
| 语音（voice-service） | `PARTIAL` | `PARTIAL` | `NONE` | `UNKNOWN` | 已注册为工具；能力口径待裁决（P1-4） |
| 天气（weather-service） | `PARTIAL` | `PARTIAL` | `NONE` | `UNKNOWN` | 同上 |
| embedding-service | `PARTIAL` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | 由 `app.js` 调用；与 D6 的边界待裁决 |
| Phase 5B 自动 Soft Retrieval / BM25 / reranker | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` |
| Apple Watch bridge | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` —— 仅 5 份规格 |

### 证据锚点

- **Telegram→CMX 图片识别 / OCR**：`MediaInboxService` 在 photo 原子落盘后、recorder/runtime 前调用 `src/services/cmx-image-recognizer.js`；仅向配置的 CMX `POST /files/recognize` 上传字节。结果以信封外 `<attachment_vision_context trust="untrusted">` 进入该次 turn，用户正文逐字不变，输出转义且总长有界；`conversation-purity` 在记忆材料化前剥除。CMX 不可用时原文与 `<media>` 引用继续。契约和主路径回归位于 `test/telegram-media-v2.test.js`，属于阻塞 `test:telegram-media`。
- **G1（Telegram memory_context）**：`src/core/app.js` 的 `buildRuntimeTurn()` Telegram 分支调用 `resolveMemoryContextFailOpen()`（对 `resolveMemoryContextForPrepared()` 的 fail-open 包装，解析失败降级为空记忆），memory_context 作为独立 `<memory_context>` 块拼在 `formatTelegramRuntimeText()` 产出的 `<channel>` 信封外侧上方；无记忆时不出块，payload 与旧格式逐字节一致。格式裁定见 `DECISIONS.md` D15。
- **为什么测试记 `COVERED`**：`test/telegram-runtime-payload.test.js` 新增 4 条钉住新 payload 格式（有记忆 / 无记忆 / 转义 / 信封不变），在 `test:phase1` 分组内，阻塞主 CI。
- **仍缺什么**：真机 Telegram 上 memory_context 实际执行并被 trace 记录的留证，因此 G1 记 `PARTIAL` 而非 `PASS`。**取证目前被 `CYBERBOSS_MEMORY_RETRIEVAL=0` 阻断**：仓库默认姿态（`.env.example:58`）下 `app.js:1175` 直接返回 `mode:"disabled"`、memory_context 不执行，故判据 0 的证据在默认姿态下取不到。停摆时间线取证与默认开关姿态属产品裁定（`NEEDS_FABLE-1` / fable W9 裁定一.3、一.4），**G1 定义不改**。
- **为什么 Re-entry / Current State 仍是 `WIRED`**：它们不走 `buildRuntimeTurn`，而是由运行时适配器调 `prepareOpeningContext()`（`claudecode/index.js:895`、`codex/index.js:245/276`）注入。两条独立通路，不能合记一行。
- **Context Trace 覆盖 memory_context**：`recordContextTrace()` 新增 memoryContext 参数，有记忆行时在 `blocks` 记 `{type:"memory_context", loaded:true, reason:<mode>, chars}`，无记忆时在 `skipped` 记 `{type:"memory_context", reason:<mode|empty>}`；`dispatchPreparedTurn` 的调用点已接入，对所有 provider 的 turn 路径生效（opening refresh 调用点行结构不变）。由 `test/phase2-hard-context.test.js` 钉住，在 `test:phase2` 分组内，阻塞主 CI。
- **为什么 nightly 的生产接线记 `UNKNOWN`**：仓库只能证明 `.env.example` 里 `CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED=false`、`CYBERBOSS_NIGHTLY_MODE=evidence`，以及 `src/core/config.js` 对应的默认值为 `false` 与 `evidence`；`scripts/windows/continuity-nightly.ps1` 的计划任务路径显式允许未设置 / `evidence`，而 `shadow` / `auto` 必须另有 `config_dir/nightly-mode.confirm` 标记。生产机实际环境变量在 `settings/secrets/*.local.json`，不入库；计划任务状态与确认标记状态也不在版本控制内。**因此仓库无法对生产机的历史启用情况作出任何结论 —— 这一格只能记 `UNKNOWN`。**
- **#74 Self-note 单锁域**：`ai_self_notes.md` 的两个 writer —— History writer（`src/continuity/continuity-pipeline.js:412` `publishSelfNote()`）与主体 AI 的 `memory_note` 工具（`src/services/memory-note-service.js`，生产接线 `src/tools/create-project-tooling.js:61` → `src/tools/tool-host.js:228`）—— 现在从 `src/orchestration/memory-writer-lease.js` 同一处解析 lease 路径，两边锁域合一；`memory_note` 的写入改为只追加（`memory-note-service.js:82` `appendNoteLine()`），不再整读整写回。回归测试 `test/phase3-selfnote-writer-lease.test.js` 在 `test:phase3` 分组内，含一条**双进程真并发**用例（父进程先占锁，保证子进程第一次写入必然撞锁，竞态窗口是构造出来的）。fail-open 不变：拿不到锁返回 `note_unavailable`，不阻断聊天。
- **CI 覆盖**：主 CI 只执行 `.github/workflows/phase1-offline.yml` 里列出的**十二个** `npm run test:*` 分组 —— 原九组，加上 issue #78 第 2 批接线的 `test:memory-services` / `test:reflect` / `test:520-endpoints`。红孤儿修理第 2 批的 6 个文件已接入既有分组：Claude/Codex approval 与 Codex RPC 进入 `test:route-lanes`，timeline / sticker 进入 `test:phase1`，tool-host 进入 `test:catalog-metering`；其中 Windows CI 对 sticker 只有 5 条执行、3 条 macOS `sips` 用例恒 skip，不能记为完整覆盖。其余未接线孤儿仍按「不许把红测试直接接进 CI」先修后接；另有若干与 P0/P1 目标通路无关的绿孤儿。

---

## 四、优先级

```text
（2026-08-03 truth-reset：原 NOW/NEXT/LATER 已严重滞后于执行链——所列多项已合入 main。
 下方按事实重列「已完成」与「剩余」；剩余项的前瞻排序（谁先谁后）待 fable 协调，本节不预设。）

已完成（原 NOW/NEXT/LATER 中已落地并合入 main，默认关）
- G2-2 主体签署 + G2-5 dispatcher/注入/ack：已闭环（离线全链 + 阻塞 CI）
- 目录化 T01/T02 + G3 隔离 T03–T06 + Route 2 T07/T08 + Route 1 T09/T10-A/T10-B/T10-C：已实施合入
- Closeout 业务日与 no_output 终态（D18）；#68 睡眠窗口 520 面板化（#122）
- D28 存量候选只读 lookup 消费者（#125）

剩余——分三栏（栏内排序待 fable 协调；Agent 不得把维护/重构自动升级成上线门）：

RELEASE BLOCKERS（第五节切生产判据直接对应，缺一不可）
- G1 真机取证：Telegram 实际加载 memory_context 并留 Trace
- G2 生产闭环：打开开关跑完整 签署→Review→History→递送，并真机留证（让 G2 从 PARTIAL 走向 PASS）
- G3 / T11：真实 fable-chat / work-engineering 隔离 + Route 1/2 真机差分 canary + 生产绑定
- G5：memory 的「真实备份→破坏副本→恢复→核对数据」已于 2026-08-03 完成留证（含真档原地恢复）；**剩余：release 回滚（`phase1-rollback.ps1`）真机演练**（硬门，D20）
- #77 中对应「启动入口 / descriptor 单一真相 / 正规 release 包」的剩余项（整理成剩余项，不照旧事故正文推进）

PRODUCT-COMPLETE DECISION REQUIRED（是否属本次正式上线范围，由 Owner 明确裁，不由 Agent 自动算上线门）
- G2-7 真实存量迁移执行
- G2-8 睡眠兜底 / #65（#65 先按 D26 退稿严格实时、window_gone 作废不递继任重新收窄，再决定是否施工）

POST-RELEASE / PARALLEL
- 520 重构阶段 2 设计稿
- R4 真 Windows 留证等其他增强项

DEFERRED
- Soft Retrieval / 多 Bot / Apple Watch
```

**POST-RELEASE / PARALLEL 栏可以与 RELEASE BLOCKERS 并行推进，但不能替代它们。** 直接去做增强项与外围留证、跳过 G1 真机取证与 G2 生产闭环，是本文件明确要防止的走法。

### G1 修复的已知风险

已消解：memory_context 的位置、无记忆兼容、fail-open 与钉格式测试原由 D15 裁定；D30 保留这些边界，只为显式开启的 CMX 图片识别增加信封外受控例外。通用 `resolveVisionContext()` 仍不回 Telegram 路径。

---

## 五、切生产判据

同时满足下列全部条件才允许切生产，缺一不可：

0. **G1 通过**：Telegram 上 memory_context 实际执行，且 Context Trace 能证明它执行了。当前 `PARTIAL`（缺真机证据）；
1. **G2 通过**：Closeout 后的 owner、Review、History 与 nightly 边界闭环。当前 `PARTIAL`（离线全链已闭环并有阻塞 E2E，缺生产启用与真机证据，**未达 PASS**）—— 与第一节 Gate 表统一；此前本行写 `FAIL` 属 G2-2/G2-5/G2-4/G2-6/G2-7 落地前的旧口径；
2. R4 翻盘清单第 3 条已补：真 Windows 生产机的 release/cutover 测试完整输出已归档进 `docs/audit/`——**已满足**（2026-08-03，`docs/audit/G4_PREDEPLOY_TEST_OUTPUT_20260803.log`，13 组完整 stdout+stderr；两红组经对照实验定性为无 `.git` 环境因素，fable W9 裁定三）；
3. 生产机启动项已固化 `CYBERLINK_ROOT`（否则 `start-dashboard.ps1` / `start-telegram.ps1` fail-closed）；
4. 启动 watchdog 的入口显式传 `--descriptor`；
5. 能力表中「生产接线」列没有任何 `UNKNOWN` 的能力被计入放行范围；
6. **G3 通过**（硬门，`DECISIONS.md` D20）：真实 `fable-chat` profile 绑定与隔离证据，Telegram 陪伴线与工程线互相独立。当前 `PARTIAL`；
7. **G5 通过**（硬门，`DECISIONS.md` D20）：一次真实备份恢复演练留证。当前 `PARTIAL` —— memory 备份恢复演练已于 2026-08-03 在真机完成并留证（含真档原地恢复，`docs/audit/G5_MEMORY_RESTORE_DRILL_20260803.md`）；**尚缺 release 回滚的真机演练**，故本条仍未满足。

**当前状态：条件 0、1、6、7 均未满足。不得切生产。**

### 放行范围与显式排除项（Owner 裁定 2026-08-03）

> **读到这里的 Agent 注意：下列能力被显式排除出本次放行范围，本次上线不做、不验、不阻塞。** 它们不是"忘了"，是裁定过的取舍；上线后按「补验队列」逐项补。判据 5（生产接线无 `UNKNOWN`）只对**放行范围内**的能力生效——排除项不触发判据 5。

**本次放行范围** = 第四节 RELEASE BLOCKERS 五项对应的通路（G1 / G2 生产闭环 / G3·T11 / G5 / #77 启动入口与 descriptor），以及它们直接依赖的 Telegram 主链路。

**显式排除（本次不做）**

| 排除项 | 现状 | 为何不阻塞 | 何时补 |
|---|---|---|---|
| Closeout liveness、nightly closeout、Desire（八维 + hourly poller） | 生产接线 `UNKNOWN`（开关在不入库的 secrets，仓库判不了真机） | 均默认关、与 Telegram 主链路读写路径解耦；不开就不产生生产行为 | 上线后单独一轮真机核对开关状态，把 `UNKNOWN` 变已知态 |
| 520 · 只读视图与健康度 / 活跃写端点 / 剧场页 | 生产接线 `UNKNOWN`；写端点测试 `PARTIAL`，`FROZEN_WRITE_ENDPOINTS` 7 个仍冻结 | 面板由独立计划任务拉起，不在放行链路上；写端点冻结未解，不构成绕过 Review 的风险 | 上线稳定后单列一轮 520 真机核 + 阶段 2 重构（POST-RELEASE） |
| voice-service / weather-service / embedding-service | 生产接线 `UNKNOWN`，能力口径待裁（P1-4 / D6 边界） | 与记忆与人格连续性无关，属外围工具 | 口径裁定后再排 |
| **G2-7 真实存量迁移执行** | D28 已裁只读封存方案并落地消费者（#125，默认关）；"对真实存量跑一遍分类"这个执行动作未做 | 旧候选按只读封存，零写入风险，随时可补跑 | 上线后择期补跑，不改方案 |
| **G2-8 睡眠兜底 / #65** | **未做。**（已做的是 #122 睡眠窗口 520 面板化，与本项不是同一物，勿混） | D26 退稿严格实时、window_gone 作废不递继任已收窄语义；缺兜底只影响睡眠期递送时效，不产生错档 | 上线后按 D26 收窄后的语义重评是否施工 |
| **TG 指令全量接通** | 现存指令有缺失/错乱、后端已有能力未接通（#131 两条症状即此类）；`/model` 多 provider（CC 任意模型 / Codex / DeepSeek）、`/effort` 属**新接能力，尚未实现** | 属人机接口完整度，不影响记忆正确性与单 writer 边界 | 已排队：先出全量普查对照表交 Owner，再定修理与新接清单；排在 #77 发布机制修复之前 |

**补验队列（上线后按序）**：真机核对 `UNKNOWN` 开关三组 → TG 指令普查与修理 → G2-7 存量补跑 → G2-8/#65 重评 → 520 阶段 2。

---

## 六、维护规则

- 一个功能 PR 合并时，只改本文件对应的**那一行**。不要同时改 README、`CLAUDE.md` 或架构文档 —— 它们里没有状态结论可改。
- 改动本文件时更新 `Last verified` 与 `Verified against`。**没有重新核对就不要动这两行。**
- 状态词只能取第二节词典里的值。需要新状态时先改词典并说明理由，不要就地造词。
- 本文件只保留**当前**结论，旧结论移进 `docs/archive/`。
- 补充材料（调研、实验、外部资料）发生变化**不要求**修改本文件。只有当补充材料导致当前结论变化时，才更新这里。
