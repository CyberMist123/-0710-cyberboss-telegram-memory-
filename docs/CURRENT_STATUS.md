# Current Status

```text
Status: active
Authority: current project status
Last verified: 2026-08-15
Verified against: 5ab4482
```

- `Status: active` —— 这份文件当前有效。
- `Authority: current project status` —— 它是当前进度的**唯一**权威来源。README、`CLAUDE.md`、架构文档都不重复这里的结论，只链接过来。
- `Last verified` / `Verified against` —— 最后一次依据源码和运行证据核对的日期，及对应的 main commit。
- **2026-08-20 结构瘦身**：只压缩表述、把历史叙事移出，**不改任何结论与状态词**；瘦身前全文快照在 `docs/archive/20260820_CURRENT_STATUS_SNAPSHOT.md`。交付过程叙事的正本在 `docs/audit/`（按日期命名的留证文件），决定与裁定在 `docs/DECISIONS.md`。

历史过程见 `docs/archive/`；已定与已翻转的决定见 `docs/DECISIONS.md`。

---

## 一、Gate 总表

这张表只在本文件维护，其他文档一律链接过来，不复制。

| Gate | 状态 | 中文含义 |
|---|---|---|
| G1 Telegram 核心读取路径 | `PARTIAL` | 代码通路与 Trace 验收已接通；真机取证被 Phase 2-5A 启动预检**有意硬禁**（`src/core/startup-preflight.js`：四个 legacy 记忆开关任一为 true 即拒启，2026-08-04 真机实证），非缺陷降级。解锁属设计决策，候选路径见 `DECISIONS.md` Candidates C7 |
| G2 后台记忆写入边界 | `PARTIAL` | 签署→Review→History→递送全链离线闭环并有阻塞 CI；**2026-08-07 生产闭环首次真机全链通过**（首条 `live_subject` 候选发布进正档，留证 `docs/audit/G2_PRODUCTION_CLOSURE_20260807.md`），生产 Review 模型已配。剩余：G2-7 真实存量执行、G2-8 睡眠兜底、nightly 仍为 evidence 档 |
| G3 Chat 成本与 profile 隔离 | `PARTIAL` | fable-chat / work-engineering 双 profile、launch 恒等式（D33）、升格三档与 Route 1 派活链（D37）均已真机闭环（留证 `docs/audit/G3_ROUTE_ESCALATION_LIVE_20260806.md`）。已知不修：成本门控空转（Owner 放行）、Route 1 查询无持久化、失败任务不清理 worktree。剩余：fable/work 差分隔离与 Owner 侧观感项未验，**T11 那一场仍欠** |
| G4 Windows 生产验证 | `PARTIAL` | 真机交付流程已跑通九次以上（逐次留证 `docs/audit/G4_PRODUCTION_DELIVERY_*.md`），监督链失岗根因均已修（BOM / `deployed_sha` / 电池策略，见 `G4_WATCHDOG_*` 留证）。**descriptor 元数据会谎报，判部署真相只能比对活代码树**。剩余：#77（启动入口 / descriptor 单一真相 / 正规 release 包）未处理 |
| G5 备份与回滚验证 | `PARTIAL` | memory 备份恢复已真机演练留证（`docs/audit/G5_MEMORY_RESTORE_DRILL_20260803.md`，含真档原地恢复）。剩余：release 回滚（`phase1-rollback.ps1`）未真机演练；`runtime`/`settings`/`releases` 的备份恢复不在已演练范围 |

**是否允许切生产：否。** 判据见第五节。

---

## 二、状态词典

能力表的每一列只允许使用下列状态词。**不要自造近义词**，也不要用 ✅ / ❌ / "可用" / "部分" 这类自由文本 —— 它们在多轮 PR 之后会各自漂移。

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
| G2 recorder route snapshot / `subject_route` schema | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— recorder 真实写入路径冻结 canonical route/session/window 快照并按 source entry ID/hash 取证；缺身份保持 PARTIAL/ambiguous。G2-2 已改窄鉴权 IPC broker（D31），离线跨进程阻断验收通过 |
| G2 存量候选分类 / companion binding（G2-7） | `WIRED` | `COVERED` | `BLOCKING` | `NOT_WIRED` | **`PARTIAL`** —— 离线 CLI 默认只读、显式 `--apply` 才迁移，未在真实存量上运行；D28 只读 lookup 消费者已落地（#125），生产 companion 数据面为空，暂无可观察行为变化 |
| G2 Review publication intent / History outbox | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | 两层 supersede 拆名、exactly-once 整链闭环，fork/cycle/stale 等一律 fail-closed；发布后 decision 翻转只记冲突不改 canon。与 Review artifact 共用 `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED`，仓库默认关闭 |
| G2 handoff dispatcher / 一次性注入 / ack（G2-5） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_HANDOFF_DISPATCH_ENABLED` 默认关（关闭时零副作用）。语义按 D26：严格实时、window_gone 作废不递继任、补投一次即止、注入块确定性组装。崩溃丢 ack 不重放正文，跨重启补 ack 归后续单 |
| G2 主体签署 capability / 材料包（G2-2） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | 挂 `CYBERBOSS_SUBJECT_SIGNING_ENABLED`。capability 圈禁主进程（D31）、provenance 服务端取证（D35）、签署资格 profile 允许清单（D51）。四处接线债（env 转发 / 真值判定 / schema 自报 sha / 入口取证）均已修并有阻塞回归，2026-08-07 真机全链通过（见 G2 行留证） |
| Telegram 媒体入站（media inbox） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | `test:telegram-media` 已接进主 CI |
| Telegram 图片识别 / OCR（CMX recognize） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 默认关；显式 `caption + cmx-recognize` 后上传 CMX `/files/recognize`，结果以信封外 untrusted 附件块进 turn，purity 剥除，失败不阻断原图原文（D30）。无真机图片 canary |
| Hard context · Re-entry | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— 适配器 opening context 注入；#76 已加 last-known-good 降级、预算硬闸与 configured/effective 分离。**正文压缩归聊天窗主体 AI，尚未做**，生产机无可用副本时首次仍是空注入 |
| 主体节拍调度 E2（consolidation / reflect 触发） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | D42：走既有系统消息队列，consolidation 并入八维菜单，reflect 每 `CYBERBOSS_REFLECT_INTERVAL_DAYS` 天（生产=3），受 `/pause_heartbeat` 总闩；2026-08-09 真机实证暂停拦截与恢复即敲。next_wake 自主节奏见 Desire 行（D48） |
| E5 发布链常态调度 / 回执 / 空档目录 | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | D44：两开关默认关；调度器只调既有 Review→History、经 writer lease 互斥。未部署、未真机 |
| timeline 候选发布通路（E3） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | D43：候选 type `timeline` 走完整发布链，`publishTimeline()` append-only 写 `relationship_timeline.md`。生产接线随签署开关可达，尚无真机发布留证 |
| 慢层注入面 E1（agreements / portrait / wandering） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | D41：开窗小预算缝入，三项独立开关（生产已开），逐项 admit、超限整项跳过、缺失静默跳过（fail-open 只读）。2026-08-09 真机留证 portrait 注入 467 字；agreements/wandering 长出正文后自动生效 |
| 账本（details）外置存储 | `PARTIAL` | `COVERED` | `BLOCKING` | `NOT_WIRED` | #76 目标 1：存储、权限门、发布与 `memory_lookup` 读通路闭环（第三档按需，永不注入）。**写侧没有 producer**，生产无数据 |
| 聊天资产按类分根外置存储 | `WIRED` | `COVERED` | `BLOCKING` | `NOT_WIRED` | D38 批次 B：三类独立根 env、缺省逐字节回落、表情库四路径同根，测试钉住。生产未设这三个 env；Owner 侧建目录 + 设 env + 停机搬文件 + 真机验后方可升 `VERIFIED` |
| Hard context · Current State | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 同 Re-entry 通路；与 memory_context 不是同一条通路 |
| **Telegram memory_context** | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 通路经 `buildRuntimeTurn()` 可达、fail-open；生产随 `CYBERBOSS_MEMORY_RETRIEVAL=0` 默认关闭，真机执行证据缺失（详见证据锚点） |
| Context Trace 覆盖 memory_context | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | trace blocks / skipped 已解释 memory_context（所有 provider）；随上行开关关闭而不执行 |
| `memory_lookup`（Phase 5A，仅 user_pull） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 受控翻档（会话翻档上限已按 D39 撤除）；真机使用情况未核 |
| 工具按需取用（weather / diary / sticker） | `WIRED` | `PARTIAL` | `NONE` | `WIRED` | 工具存在且注册，边界测试不全。sticker 的微信硬编码出口与 GIF 形态坑已修（`test/tg-sticker-outlet.test.js` 进 `test:phase1`），真机 canary 未做 |
| MCP 工具分组隐藏（省 schema token） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | T02/T02.5 目录化 + catalog invoke 通路（D34）：广播面恒 3 工具，非常驻经 `cyberboss_catalog` 调用，权限语义全部沿用。2026-08-05 生产开启并真机验证（广播面 31→3、行为面三项通过）。2026-08-15 修 `authorized` 显示漏算自助升格（D27-1 口径），**行为端待她下次提交 episode 候选验证** |
| Memory 目录化（注入目录而非命中行） | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | D25-A 方向获批；实施未开工 |
| 子代理结果胶囊化 / Route 1 task-session core（T09） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | D14 胶囊契约 + T10-A/B/C（worktree 隔离、5/15/60 上限、两级中断、结果单 writer 留存）全套挂开关。2026-08-06 起真机闭环见 G3 行；D52 增命名 workspace（`CYBERBOSS_ROUTE1_WORKSPACES`，home=Fluffy-SelfHood 家仓，`base_sha` 可自动解析）。无 OS 沙箱，Bash 绝对路径逃逸是明确残余风险 |
| 记忆服务层（validator / resolver） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 9 个测试文件接 `test:memory-services`。extractor 已按 D23 整条退役（守卫钉住）；`memory_note` 与 History writer 同一把 lease、只追加（#74，见证据锚点） |
| Closeout liveness | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 调度器已接 `app.js`；`test:p0-closeout-liveness` 进主 CI；生产开关仓库判不了 |
| nightly closeout | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | **`PARTIAL`** —— D18 业务日/时区/封存语义已实现，仓库默认关闭，生产状态未核 |
| Reflect / 低频重读（rereadings） | `ORPHAN` | `UNIT_ONLY` | `BLOCKING` | `NOT_WIRED` | **`DEFERRED`** —— 后台批处理方向被 D42 主体自做的 reflect 节拍取代；模块按纪律保留，`test:reflect` 只是孤儿回归信号 |
| `/effort`（与 `/model` `/status` 同修） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 切换不生效（slot 连坐清除）与 `/status` 真相源分歧均已修：三命令共用单一 `resolveWindowScopedRuntimeParam` 阶梯；2026-08-07 上机并经 Owner 真机验证 |
| `/pause_heartbeat` / `/continue_heartbeat` | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 单 writer 持久态、三类 poller 与定向队列暂停已接主链；2026-08-09 真机实证暂停拦截与恢复即敲（见 E2 行） |
| Desire（八维状态 + hourly poller） | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 挂 `CYBERBOSS_DESIRE_LOOP_MINIMAL_ENABLED`，开关在不入库 secrets。cadence 可配 15–240 分钟；next_wake 自主节奏（她自填下次唤醒间隔，**替换**默认 cadence，D48）；checkin 提示词外置即时生效（D46） |
| `/probe`（手动激发 checkin） | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | 手动激发一次 desire checkin，不改 cadence、不影响自主节奏；用于当场验证八维链路 |
| 520 · 只读视图与健康度 | `WIRED` | `COVERED` | `BLOCKING` | `UNKNOWN` | 面板由独立计划任务拉起，真机状态未核 |
| 520 · 活跃写端点（提示词 / 分层 / 门控 / 调度） | `WIRED` | `PARTIAL` | `BLOCKING` | `UNKNOWN` | 改生产行为的端点覆盖不全（故 `PARTIAL`）；`test:520-endpoints` 进主 CI；`reentry` 保存与 Node History writer 共用跨语言 writer lease（D29），撞锁 409 |
| 520 · 安全冻结写端点（5 个） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 按设计冻结，见 `DECISIONS.md` D5 |
| 520 · 关怀页写路径（care config / cycle） | `PARTIAL` | `PARTIAL` | `NONE` | `NOT_WIRED` | 后端在、前端未接完；不是安全边界 |
| 520 · 剧场页（theater scripts） | `WIRED` | `NONE` | `NONE` | `UNKNOWN` | 纯展示只读 |
| Claude Code 工作站 MCP/skill 开关面板（7822） | `WIRED` | `COVERED` | `BLOCKING` | `NOT_WIRED` | `tools/claude-config-panel/`，Owner 本机手动起（`--root` 必填）；写前自动备份，开关只对新窗口生效。工作站工具不进 bot 生产链，故按定义 `NOT_WIRED`；`test:claude-config-panel` 进主 CI |
| Windows release / watchdog 控制平面 | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | **`PARTIAL`** —— 交付与监督链多轮真机验证（留证 `docs/audit/G4_*`）。`/status` 可回看 watchdog 心跳（生产 env 已配并验证）。**重启必须走 `start-telegram.ps1`**：watchdog 只认 helper 启动的 poller，直起会被复活成双 poller。剩余：#77 正规发布包机制未启用 |
| 备份与回滚演练 | `WIRED` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | **`PARTIAL`** —— memory 半：工具落地 + 2026-08-03 真机演练留证；release 回滚半：无测试无真机证据。整行按口径保守取值 |
| G3 CLI preflight / 独立 config root（T03） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED`（关闭时与基线逐字兼容）；八个 required flag、env allowlist、auth 探针任一失败均切换前 fail-closed。离线硬边界证据，真机隔离归 T04/T11 |
| `fable-chat` profile 绑定 / per-lane active window pointer | `WIRED` | `COVERED` | `BLOCKING` | `WIRED` | schema v3 双 profile 契约：chat-subscription 鉴权、persona 经 `--system-prompt`（D32/D33）、内建工具面两档 + route2 升格、`/profile` 切换与 EXACT 投递。契约六字段已改代码派生并上机（指纹不变）。真机隔离差分归 T11，未声称通过 |
| G3 Route 2 gate / 单次操作 lease（T07/T08） | `WIRED` | `COVERED` | `BLOCKING` | `DISABLED` | 挂 `CYBERBOSS_ROUTE2_GATE_ENABLED`。触发方 `route2_escalate` 已补、`no_tools` 硬理由已删（闸门是成本路由器不是权限闸，D33 补注）；升格三档 / lease 解绑 turn / 回收不腰斩（D37）2026-08-06 真机闭环（见 G3 行） |
| Codex 作为子代理运行时 | `PARTIAL` | `COVERED` | `BLOCKING` | `NOT_WIRED` | 有界委派协议与离线闭环已实现，2026-07-28 真实 canary 一次通过；adapter 未绑进委派 runner，主 Chat 未接 |
| 语音（voice-service） | `PARTIAL` | `PARTIAL` | `NONE` | `UNKNOWN` | 已注册为工具；能力口径待裁决（P1-4） |
| 天气（weather-service） | `WIRED` | `COVERED` | `NONE` | `WIRED` | 2026-08-18：Open-Meteo provider（`CYBERBOSS_WEATHER_PROVIDER` 切换，默认 amap）+ 日简报；`test:weather` 进主 CI。生产 Waterloo + `open_meteo` 已部署（`c459546`，真 API 冒烟通过） |
| 天气注入八维 checkin（预警日缝一行） | `WIRED` | `COVERED` | `NONE` | `WIRED` | 2026-08-18：hourly poller 按需取日简报（fail-open），notable 时往 checkin 缝一行事实，单 writer 守卫每日一次，`/probe` 也带；挂 `CYBERBOSS_WEATHER_INJECT_ENABLED`（生产已开）。只给事实不写台词（北极星）。真机行为 canary 待 Owner 确认 |
| embedding-service | `PARTIAL` | `PARTIAL` | `NONBLOCKING` | `UNKNOWN` | 由 `app.js` 调用；与 D6 的边界待裁决 |
| Phase 5B 自动 Soft Retrieval / BM25 / reranker | `ABSENT` | `NONE` | `NONE` | `NOT_WIRED` | `DEFERRED` |
| Apple Watch 健康（read-only `health` 目录工具，感知） | `WIRED` | `PARTIAL` | `BLOCKING` | `NOT_WIRED` | 2026-08-19（分支 `feat/health-catalog`，未部署）：只读目录工具接「感知」主题（D50），Python 桥调 Collar_watch `health_store` 两条读路径，**不暴露 `measure_heart_rate`**（写路径禁入）。挂 `CYBERBOSS_HEALTH_ENABLED` 默认关；目录测试进 `test:catalog-metering`，Python 桥仅本机冒烟（故测试 `PARTIAL`）。部署 + 配 env + 真机验后方可升格 |
| 存档/读档 SL（`/sl_save` · `/sl_list` · `/sl_load` 净房 · `/return`） | `WIRED` | `COVERED` | `BLOCKING` | `VERIFIED` | v1 的 `/sl_load` 把存档灌进后台 system 会话（诊断闭环见 `workdesk\20260821-sl-load-clean-branch-spec.md`）已修为**净房分支**：原子 `/new` + 只灌存档（无今天上下文/无八维/无 SYSTEM ACTION MODE 壳）、指针改道、`/return`（`/new` 亦退）退出、八维跟进净房（非暗室）。存档收 `user`+完成 assistant 轮、带 `SL-QUOTE` 标记供消化管线跳过（不变量⑤）。`CYBERBOSS_SL_DIR`→`Fluffy-SelfHood\08-sl`，兼容 v0 手写档。`test:phase1`（sl-archive/sl-commands）+ `test:route-lanes`（system-inbound/净房路由/命令改道）进主 CI。2026-08-22 部署 `54404d7`（Tag=slclean，D5 逐字节核对 169 文件=0 差异）；**Owner 真机验证通过（2026-08-22）**：`/sl_load` 开净房只见存档不见今天 → `/return` → 主线记得今天全部 |

### 证据锚点

- **G1（Telegram memory_context）**：`buildRuntimeTurn()` Telegram 分支 → `resolveMemoryContextFailOpen()`，`<memory_context>` 块在 `<channel>` 信封外侧（格式裁定 D15；钉格式测试在 `test:phase1`）。取证被 `CYBERBOSS_MEMORY_RETRIEVAL=0` 阻断（`.env.example` / `app.js` flag 分支），默认姿态下取不到判据 0 的证据；**G1 定义不改**（fable W9 裁定）。
- **Re-entry / Current State 不走 `buildRuntimeTurn`**：由运行时适配器 `prepareOpeningContext()` 注入，两条独立通路，不能合记一行。
- **Context Trace**：`recordContextTrace()` 对所有 provider 的 turn 路径解释 memory_context（blocks / skipped），由 `test:phase2` 钉住。
- **图片识别边界**：`MediaInboxService` photo 落盘后调 `cmx-image-recognizer.js`，结果 untrusted 附件块、purity 在记忆材料化前剥除；回归在 `test:telegram-media`。
- **#74 Self-note 单锁域**：History writer 与 `memory_note` 工具从 `memory-writer-lease.js` 同一处解析 lease，只追加；含双进程真并发用例（`test:phase3`）。拿不到锁 `note_unavailable`，不阻断聊天。
- **CI 覆盖**：主 CI 只执行 `.github/workflows/phase1-offline.yml` 列出的**十四个** `npm run test:*` 分组；不在其中的测试无 CI 信号。Windows CI 中 sticker 有 3 条 macOS `sips` 用例恒 skip，不算完整覆盖。
- **nightly 为何 `UNKNOWN`**：生产 env 在 `settings/secrets/*.local.json`、计划任务状态与确认标记均不入库，仓库对生产机的启用情况无法作任何结论。

---

## 四、剩余清单

（2026-08-20 重列。Owner 口径：大功能已基本做完；本节只留剩余项。2026-08-03 truth-reset 时的完整已完成清单见 archive 快照第四节。）

**RELEASE BLOCKERS（第五节切生产判据直接对应，缺一不可）**

- G1 真机取证：Telegram 实际加载 memory_context 并留 Trace（解锁路径见 `DECISIONS.md` C7）
- G2 收尾：G2-7 真实存量执行、G2-8 睡眠兜底、nightly 仍为 evidence 档
- G3 / T11：真实 fable-chat / work-engineering 隔离差分 canary 那一场
- G5：release 回滚（`phase1-rollback.ps1`）真机演练（硬门，D20；memory 半已完成留证）
- #77：启动入口 / descriptor 单一真相 / 正规 release 包

**PRODUCT-COMPLETE DECISION REQUIRED（是否属本次上线范围，由 Owner 明确裁）**

- G2-7 真实存量迁移执行；G2-8 睡眠兜底 / #65（先按 D26 收窄后的语义重评）

**POST-RELEASE / PARALLEL**

- 真机核对 `UNKNOWN` 开关三组；TG 指令普查与修理（#131 族）；G2-7 存量补跑；520 阶段 2 重构；R4 其他增强项

**DEFERRED**

- Soft Retrieval / 多 Bot

**POST-RELEASE 栏可以与 RELEASE BLOCKERS 并行推进，但不能替代它们。** 跳过 G1 真机取证与 G2 生产闭环去做增强项，是本文件明确要防止的走法。（G1 修复的历史风险已按 D15/D30 消解，见 archive 快照。）

---

## 五、切生产判据

同时满足下列全部条件才允许切生产，缺一不可：

0. **G1 通过**：Telegram 上 memory_context 实际执行且 Trace 能证明。当前 `PARTIAL`（缺真机证据）；
1. **G2 通过**：Closeout 后的 owner、Review、History 与 nightly 边界闭环。当前 `PARTIAL`（离线全链 + 生产首验已过，G2-7/G2-8/nightly 未收，未达 PASS）；
2. 真 Windows 生产机 release/cutover 测试完整输出已归档 —— **已满足**（`docs/audit/G4_PREDEPLOY_TEST_OUTPUT_20260803.log`，两红组经对照定性为环境因素）；
3. 生产机启动项已固化 `CYBERLINK_ROOT`（否则启动脚本 fail-closed）；
4. 启动 watchdog 的入口显式传 `--descriptor`；
5. 能力表「生产接线」列没有任何 `UNKNOWN` 的能力被计入放行范围（排除项不触发本条）；
6. **G3 通过**（硬门，D20）：真实 fable-chat profile 绑定与隔离证据。当前 `PARTIAL`；
7. **G5 通过**（硬门，D20）：一次真实备份恢复演练留证。当前 `PARTIAL`（memory 半已留证，release 回滚未演练）。

**当前状态：条件 0、1、6、7 均未满足。不得切生产。**

### 放行范围与显式排除项（Owner 裁定 2026-08-03）

**本次放行范围** = 第四节 RELEASE BLOCKERS 对应的通路（G1 / G2 生产闭环 / G3·T11 / G5 / #77），以及它们直接依赖的 Telegram 主链路。下列能力**显式排除**出本次放行（裁定过的取舍，不是遗漏；上线后按补验队列逐项补）：

| 排除项 | 为何不阻塞 | 何时补 |
|---|---|---|
| Closeout liveness / nightly / Desire（接线 `UNKNOWN`） | 均默认关、与主链路读写解耦，不开就无生产行为 | 上线后一轮真机核对开关状态 |
| 520 全家（`UNKNOWN` / 写端点 `PARTIAL`） | 独立计划任务拉起，不在放行链路；冻结端点未解不构成绕过 Review 的风险 | 上线稳定后单列一轮真机核 + 阶段 2 重构 |
| voice / weather / embedding | 与记忆与人格连续性无关，属外围工具 | 口径裁定后再排 |
| G2-7 真实存量迁移执行 | D28 只读封存已落地，零写入风险，随时可补跑 | 上线后择期补跑 |
| G2-8 睡眠兜底 / #65 | D26 已收窄语义；缺兜底只影响睡眠期时效，不产生错档 | 上线后重评是否施工 |
| TG 指令全量接通（含 `/model` 多 provider 等新接能力） | 属人机接口完整度，不影响记忆正确性与单 writer 边界 | 先出全量普查对照表交 Owner，排在 #77 之前 |

**补验队列（上线后按序）**：真机核对 `UNKNOWN` 开关三组 → TG 指令普查与修理 → G2-7 存量补跑 → G2-8/#65 重评 → 520 阶段 2。

---

## 六、维护规则

- 一个交付批次收尾时，只改本文件对应的**那一行**（一批动了几条能力就改几行，不是每个 commit 改一次）。不要同时改 README、`CLAUDE.md` 或架构文档 —— 它们里没有状态结论可改。
- 改动本文件时更新 `Last verified` 与 `Verified against`。**没有重新核对就不要动这两行。**
- 状态词只能取第二节词典里的值。需要新状态时先改词典并说明理由，不要就地造词。
- 本文件只保留**当前**结论，旧结论移进 `docs/archive/`。
- 补充材料（调研、实验、外部资料）发生变化**不要求**修改本文件。只有当补充材料导致当前结论变化时，才更新这里。
- **说明列只写当前结论 + 指针，单格以 400 字符为上限**（2026-08-20 起）。交付过程、根因叙事、"第 N 处接线债"式补记一律写进 `docs/audit/` 留证文件或 `DECISIONS.md` 补注，本文件只留一句结论和指向它的指针。批次收尾改行是**替换结论**，不是往格子里追加一段——本文件曾因此膨胀到 67KB（快照见 archive），别让它长回去。
