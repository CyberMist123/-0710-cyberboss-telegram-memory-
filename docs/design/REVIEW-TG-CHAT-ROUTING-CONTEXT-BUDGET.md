# REVIEW: TG Chat 路由、上下文与 Token 减负 — 架构可行性审查

状态：**Fable 只读审查结论（无生产代码改动，未触碰 live TG，无 PR）**
分支：`fix/p0-fable-chat-profile` @ `c531cda`（main `0480be7` + 2 份文档，与 main 代码零差异）
关联：Issue #15、`DESIGN-TG-CHAT-ROUTING-CONTEXT-BUDGET.md`、`HANDOFF-P0-FABLE-CHAT-PROFILE.md`
审查日期：2026-07-25

## 0. 证据基线（实测，非文档转述）

| 项 | 实测值 | 来源 |
|---|---|---|
| 本机 Claude Code | **2.1.220**（native 安装，`~/.local/share/claude/versions/` 含 2.1.216/217/220，7-24 刚自动更新） | 版本目录直读 |
| 审查用 CC | 2.1.220（与本机同版本），`claude --help` 全量 flag 实测 | 云端同版本 CLI |
| 本机 Codex CLI | **0.145.0**（`~/.codex/sessions/2026/07/23/rollout-*.jsonl` 头部 `cli_version`） | session 文件直读 |
| 运行时状态 | `~/.cyberboss/sessions.json`：当前 bindings 全为 codex（gpt-5.4-mini），模型目录含 gpt-5.6-sol/terra/luna、5.5、5.4、5.4-mini，带 reasoning effort 能力表 | 状态文件直读 |
| tweakcc-fixed | 声明支持 CC **2.0.98–2.1.139**（上游验证到 2.1.62） | 仓库 README |
| lobotomized | live 集面向 Opus 4.8，legacy 含 Fable 5；自报字符降幅 ~-28% | 仓库 README |

CC 2.1.220 `--help` 实测确认存在（本审查的核心版本事实）：
`--effort <level>`、`--settings <file-or-json>`、`--system-prompt` / `--system-prompt-file`、`--append-system-prompt[-file]`、`--exclude-dynamic-system-prompt-sections`、`--fork-session`、`--strict-mcp-config`、`--tools <tools...>`、`--agents <json>`、`--mcp-config`、`--model`、`--fallback-model`、`--permission-mode`、`-p --input-format/--output-format stream-json`。

**结论先行：设计文档想要的东西，官方 CLI 在 2.1.220 已经给全了开关。第一阶段不需要任何 patch、不需要 SDK 重写，甚至大部分实验只靠改 `CYBERBOSS_CLAUDE_EXTRA_ARGS` 环境变量就能跑。**

---

## 1. 现状 launch path 解剖（仓库实读）

TG 消息 → `src/adapters/channel/telegram.js`（private chat 过滤、去重）→ core → `src/adapters/runtime/claudecode/index.js`：

1. `ensureClaudeProjectMcpConfig()`（`project-settings.js:5`）把 `cyberboss_tools`（`bin/cyberboss.js tool-mcp-server`）+ 外部 MCP（netease_music）合并写进 `<workspaceRoot>/.mcp.json`。
2. `ClaudeCodeProcessClient` spawn（`process-client.js:395` `buildArgs`）：
   `--output-format stream-json --input-format stream-json --permission-prompt-tool stdio --verbose [--permission-mode] [--resume <uuid>] [--model <m>] --mcp-config <ws>/.mcp.json` + `CYBERBOSS_CLAUDE_EXTRA_ARGS`。
3. **没有传**：`--effort`、`--settings`、`--strict-mcp-config`、`--system-prompt*`、`--tools`、`--agents`。
4. 人格注入在**首条 user turn**（`shared-instructions.js:4` `buildOpeningTurnText`：WAKE/persona + operations + state relay + pending promises + reentry 块 + current_state 块 + 用户消息），不在 system 层。上下文指纹变化 → 关 client 重开新 thread（`index.js:393-403`）。
5. 每 (binding, workspace) 一条 thread（SessionStore 复用 codex 的 `session-store.js`）；已存在 `runBackgroundTurn()`（`index.js:338`）：一次性隔离 session，只取 `turn.completed` 的 result 文本返回，120s 超时。
6. `cyberboss_tools` 实际暴露 **32 个工具**（`tool-host.js`：github×4、location×2、memory×2、time/diary/reminder/system_send/sleep/weather、发送类×5、sticker×8、timeline×8）。

### Issue #15 三个现象的根因（代码级）

| 现象 | 根因 | 结论 |
|---|---|---|
| `effort=max` | spawn 不传 effort → 继承用户全局 `~/.claude` 设置（本机日常工程用 max） | **配置泄漏，不是 CC 缺陷**。一个 flag 可治 |
| cmx-gpt/cmx-test 等 MCP 混入 | `--mcp-config` 是**叠加**语义；user/global 级 MCP 照常加载 | `--strict-mcp-config` 一刀切断（help 原文：Only use MCP servers from --mcp-config） |
| ~50 deferred tools / 5 agents / 13 skills | 用户全局 plugins/skills/agents + bundled skills 全数进入 chat session | `--settings`(disableBundledSkills) + `--agents {}` + profile 化 settings 可隔离 |

**重要修正：29.8K 固定 prefix 的大头不是 quota 烧钱的大头。** Issue 证据里单条普通回复 4,000–7,400+ output tokens——那是 effort=max 的隐藏推理，是**每轮新增 output**；而 29.8K prefix 建 cache 后每轮走 cache read。按杠杆排序：`--effort` ≫ 砍 MCP/skills 污染 ≫ 砍 harness 文本 ≫ Route 1 隔离长任务（防历史膨胀）≫ tweakcc。

### 29.8K prefix 成分假设（待 Phase 0 实测校准）

CC 2.1.x 基础 system prompt + 内置工具说明 ≈ 12–16K；bundled skills + agents 清单 ≈ 2–4K；用户级 plugins/skills（13 个）描述 ≈ 2–4K；MCP：tool search 生效时 deferred 名单只留名字 ≈ 1–2K（50 个 deferred 恰是证据）；agentCwd（默认= memoryDir，`config.js:21`）下若有 CLAUDE.md / `.claude/` 会再注入；system reminders ≈ 1K；WAKE-CHAT 仅 ≈0.6K tokens。合计与 29.8K 量级吻合 → 设计文档推论 1–3 成立：**只砍 WAKE 无效；tool search 已在工作但救不了固定 harness。**

---

## 2. 逐项可行性判定

| 设计项 | 判定 | 依据与边界 |
|---|---|---|
| Tool Search / deferred tools | **可行，已在生效** | 官方文档：默认开启，`ENABLE_TOOL_SEARCH`（true/false/auto，auto≈工具定义超上下文 ~10% 才 defer），MCP server 级 `alwaysLoad` 可钉住常驻；headless 同样生效。Issue 日志里 50 个 deferred 即实证。无需自造动态 MCP 机制 |
| Output Style（keep-coding-instructions: false） | **可行，2.1.220 仍受支持** | 文档确认 frontmatter 字段真实存在、headless 可用；把人格放进 system 层且去掉 coding instructions。注意：style 属 settings 维度（可经 `--settings {"outputStyle":...}` 按 session 指定），切换需新 session——与设计预期一致 |
| `--system-prompt` 全量替换 | **可行（更激进的备选）** | 完全替掉 CC harness；风险是连工具使用规范一起没了，tool-calling 可靠性可能下降。配 `--exclude-dynamic-system-prompt-sections` 利于跨机 cache。建议与 Output Style 并列进 A/B/C，实测选择 |
| 隐藏分支 session（Route 1） | **可行，最小落点已在仓库** | `runBackgroundTurn()` 就是雏形：独立 spawn、独立 session id、只回传 result 文本（`waitForIsolatedCompletion` 只取 `turn.completed.text`——**结果胶囊的结构保证天然成立**）。缺的只是：work profile 参数、轻量记忆包注入、异步生命周期（120s 超时必须改）、SessionStore 任务映射 |
| `--fork-session` 用于 Route 1 | **不建议** | fork 语义 = 复制整条 chat 历史开新 id：工程分支会背上全部闲聊史（污染 + token 双输）。fork 的正确用途是"chat 自身分叉试探"。Route 1 应当**fresh session + 记忆包** |
| 轻量记忆包（六段式） | **可行，边界合理** | A 身份种子←WAKE 精简版；B 任务相关事实←`memory_lookup`（vectors.jsonl 检索已有）；C 当前决定←chat 组包；D 任务包←dispatch 参数;E 权限←worker profile 的 `--settings` permissions + `--permission-mode`；F 返回协议←固定模板。1.5–3.5K 预算现实。注意 reentry/current_state 是 chat 连续性资产，**不进 worker** |
| Route 2（chat 按需带工具） | **可行** | chat-core 常驻 + 其余 deferred 由 tool search 承担。关键实现点：`cyberboss_tools` 按 profile 出牌——在 `tool-host.js`/`mcp-stdio-server.js` 加 `--toolset chat-core`（如 memory_lookup、memory_note、cyberboss_time、system_send、task_dispatch/status ≈5–6 个），比依赖 CC 侧过滤更精准可控 |
| Token A/B 边界 | **数值合理；执行方式要改** | 估算侧可行：工具目录预存每工具 schema token 估值 + 预计返回体。**硬 cap 不可行**：headless 无"最大工具轮数"开关，模型隐藏推理不可预算。但本仓库有独门优势：`--permission-prompt-tool stdio` 意味着**每次工具调用都过自家审批通道**（`pendingApprovals`）——可在 runtime 侧数轮数、超 A 级软限即自动 deny + 提示转 Route 1。B 级用结构保证：大 MCP 根本不进 chat 的 `.mcp.json` |
| 模型选择 | **可行，机制已在** | per-binding runtimeParams + observed-model 回写已实现（`index.js:479-528`）；换模型时 client 重建但 `--resume` 保 thread。设计的四条规则可直接落。Codex 侧 0.145.0 + 模型目录（含 per-model reasoning effort）已支撑 worker 廉价档 |
| tweakcc-fixed / lobotomized | **当前版本不适用；仅 Phase 5 备选** | 支持上限 2.1.139 < 本机 2.1.220（差 ~80 个版本，minified 结构大概率已变）。lobotomized live 集面向 Opus 4.8（有 Fable 5 legacy，未对齐现版）。且其 -28% 是**字符数**，对已被 cache 的 prefix 折算成 quota 收益有限。设计文档"官方机制优先、独立安装隔离试验、当候选删除清单不整包搬"的原则**全部正确**，本审查加一条：现在连"隔离试验"都先别做，版本对不上 |
| 多可见 Bot 延后 | **正确** | 状态短讯用现成 `cyberboss_system_send` 即可；BotFather/生命周期成本无必要提前付 |

---

## 3. 设计文档 §14 十五问逐答

1. **29.8K 组成？** 见 §1 成分假设；精确分解 Phase 0 用同 flag 交互式 `/context` + init 事件 `tools[]` + 首轮 usage 的 `cache_creation_input_tokens` 三角定位。
2. **Tool Search 是否已启用？** 是（日志 50 deferred 即证）。deferred 定义按需展开进上下文，退出不自动；`ENABLE_TOOL_SEARCH`/`alwaysLoad` 可控粒度。
3. **保留全量 MCP 目录但不预载 schema？** 原生支持（deferred 名单本身就是目录）。补充：自维护一份带"用途/读写风险/预计 token"的目录文档作为 chat 参考，比裸工具名对判断 Route 1/2 更有用。
4. **Output Style 在 headless/TG 可用？** 可用；`keep-coding-instructions: false` 移除 coding instructions（system 层）。与 `--system-prompt` 互斥使用（后者整体替换）；与 WAKE-as-user-turn 需去重，人格上移 system 后 opening turn 相应精简。
5. **分支 session 用什么机制？** 排序：① 扩展现有 adapter 的隔离 spawn + SessionStore 任务映射（最小改动、Windows 无 daemon 依赖）＞② Agent SDK 重写（能力强但迁移面大，Phase 3+ 再议）＞③ `claude agents`/`--bg`（交互向、引入后台守护复杂度）＞④ `--fork-session`（语义不符，见 §2）。
6. **Route 1 如何保证只回胶囊？** 结构上已保证：隔离 client 的完成事件只携带 result 文本；把胶囊格式写进 worker 任务模板（返回协议 F 段），chat 侧只落"一行注记 + 任务索引"。工具日志/中间过程留在 worker 自己的 transcript（`~/.claude/projects/...`），天然可追溯。
7. **六段记忆包够不够？** 够，且应从现有层生成（映射见 §2）；超预算材料落地为 worker 工作目录内的文件由其自行检索，不塞 prompt。
8. **工程分支再分发 Codex 用什么？** 用现有 codex runtime adapter + SessionStore 双 runtime 参数（`sessions.json` 已是 per-runtime 结构）。第一阶段不建 Agent Bus、不强行走 MCP；跨 AI 协议留到确有多实例需求时参考 cc-telegram-bridge。
9. **Route 2 估算法与阈值？** schema 估值预存目录元数据；返回体给每工具加 max-bytes 参数；轮数经 stdio 审批通道计数硬控（本仓库独有优势）。A≤3K schema/≤3 轮/≤6K 新增、B≥8–10K 的初值合理，按 `context.updated` usage 事件回填校准。
10. **模型选择与人格连续性？** 遵设计四规则；chat 模型只经 `--model` 显式指定并被 observed-model 回写钉住，防 fallback 静默换模（`--fallback-model` 不给 chat 配）。
11. **完整 CC harness 对 RP 有无增益？** 待测，倾向设计初判（增益来自模型+WAKE+记忆+行动能力，不来自工程规则）。A/B/C 矩阵见 §5。
12. **tweakcc/lobotomized 取舍？** 现在不用（版本不适配）。未来若做：可移植候选=工具描述精简、重复 reminder 去重、未用功能说明删除；绝不动=诚实/失败直报、破坏性操作确认、外部内容不可信、权限边界、工具错误处理。
13. **最小落点文件？** 见 §4。
14. **做不到/高成本清单？** (a) 轮内精确 token 预算 hard cap（隐藏推理不可预算）——用软限+审批计数+事后校准替代；(b) `--fork-session` 式"干净分支"（语义相反）；(c) 同 thread 跨 profile 热切换（settings/system prompt 决定于 session 启动，切 profile=新 session，需 re-entry 支付）；(d) tweakcc 于 2.1.220（版本墙）；(e) 每轮卸载已展开的 deferred schema（CC 不支持收回）。均不破坏 continuity/watchdog/media/approval 现有边界。
15. **PR 拆分？** 见 §6。

---

## 4. 推荐最小架构与文件落点

**Profile 三元组（第一阶段只做前两个）：**

```text
fable-chat:  --effort medium --strict-mcp-config --mcp-config .mcp.chat.json(chat-core 5–6 工具)
             --settings chat-profile.json(disableBundledSkills、outputStyle "Fable Chat"、permissions 收紧)
             --agents {}  [+ A/B/C 决出的 system 层人格方案]
fable-work:  现状 stock harness + 全量 cyberboss_tools + 工程 effort（沿用今日行为）
```

落点（全部是已读文件的窄改）：

| 文件 | 改动 |
|---|---|
| `src/adapters/runtime/claudecode/process-client.js` `buildArgs()` | 接受 profile 对象 → 追加 `--effort/--settings/--strict-mcp-config/--agents/--system-prompt-file` |
| `src/adapters/runtime/claudecode/index.js` | binding→profile 解析；`runBackgroundTurn` 演化为 `runTaskSession(profile, memoryPack)`：异步生命周期（去 120s 墙）、任务 id、状态回报 |
| `src/adapters/runtime/claudecode/project-settings.js` | 按 profile 生成 `.mcp.chat.json` / `.mcp.work.json` |
| `src/tools/mcp-stdio-server.js` + `tool-host.js` | `--toolset chat-core|full` 工具子集出牌 |
| `src/adapters/runtime/shared-instructions.js` | 人格上移 system 层后精简 opening turn（保留 reentry/current_state 胶囊块） |
| `src/adapters/runtime/codex/session-store.js` | bindingKey 之外增加 task-session 命名空间（`threadIdByWorkspaceRootByRuntime` 结构可直接扩展） |
| `src/core/config.js` | `CYBERBOSS_CLAUDE_CHAT_*` 环境组 |

**零代码即可先跑的实验**：`CYBERBOSS_CLAUDE_EXTRA_ARGS=--effort,medium,--strict-mcp-config`（`readListEnv` 逗号分隔；过滤器只挡 `-c/-e` 开头短 flag，实测 `--effort` 可通过）。适合在独立 config_dir/state_dir 的实验 release 上验证，**不碰 live**。

---

## 5. Phase 顺序（修订版）与 A/B/C 矩阵

- **Phase 0 只读测量**：`claude --version`/`codex --version`（已完成，见 §0）；查 `~/.claude/settings.json` 与 cc-switch 产物定位 effort=max 来源；确认 `CYBERBOSS_CLAUDE_EXTRA_ARGS` 现值（`--print` 应在其中，spawn 代码本身未传 `-p`）；检查 memoryDir（agentCwd）下 CLAUDE.md/.claude 注入；同 flag 起一次性 session 抄 init `tools[]` + 首轮 usage，做 29.8K 精确分解。
- **Phase 1 官方机制实验**（独立实验 release）：A=现状；B1=Output Style(keep-coding-instructions:false)；B2=`--system-prompt-file`；C=B 胜者 + `--strict-mcp-config` + chat-core 工具子集 + `--effort medium`。每臂 3 轮闲聊 + 1 次 Route 2 式小工具调用，记录：`cache_creation/cache_read/input/output` tokens、首 token 延迟、工具调用成功率、RP 主观分（任务腔/机械感/行动感/连续性 1–5）、两三轮后漂移。**先比 output tokens（effort 杠杆），再比 prefix。**
- **Phase 2 Route 1**：task-session + 六段记忆包 + 胶囊模板 + TG 注记；先只接"查询型"任务（天气/记忆/todo 类），再放工程任务。
- **Phase 3 Route 2 gate**：工具目录元数据 + 审批通道轮数计数 + usage 回填校准。
- **Phase 4 可见多 Bot / Phase 5 tweakcc**：均维持"不做，除非前序不足"；Phase 5 另加硬前提：tweakcc 生态追上所用 CC 版本，且在**独立安装**上做。

## 6. 给 Codex 的施工拆分（可独立合并）

1. **PR1 profile 管道**：buildArgs 参数化 + config 环境组 + chat-profile settings 文件；默认关闭，行为零变化。
2. **PR2 chat-core 工具子集**：tool-host/mcp-stdio-server `--toolset` + 按 profile 的 `.mcp.*.json` 生成；含工具目录元数据（token 估值）。
3. **PR3 Route 1 task-session**：异步任务生命周期 + SessionStore 任务映射 + 记忆包组装 + 胶囊模板 + TG 状态注记；带 fake-runtime 回归测试（参考 tap 的 spawn/pipe/parse 思路，不烧额度）。
4. **PR4 Route 2 gate 与遥测**：审批计数软限 + usage 记录（复用 context-trace/desire-usage 轨道）+ 校准报告脚本。

## 7. 风险与回滚

- 实验全部走 deployment 的独立 release/config_dir/state_dir（`current.example.json` 结构已支持 rollback_release），live TG 零接触；回滚=环境变量与 release 指针还原。
- `--strict-mcp-config` 会切掉 claude.ai connectors 与用户级 MCP——对 chat 是目的，对 work profile 不启用。
- `--system-prompt` 整替有工具可靠性风险 → 必须经 Phase 1 对照后再定，不直接上。
- `.claude/settings.local.json` 现有 `Read(//c/Users/18717/**)` 全盘读授权过宽，chat profile 的 settings 应显式收窄（顺带修复项，不在本轮改）。
- 切 profile/换 style = 新 session：re-entry 成本已有机制（reentry/current_state 胶囊）承接，但应避免高频切换。
- 版本漂移：CC 自动更新（7-24 刚跳 2.1.220）可能改 flag/行为；Phase 0 测量脚本应可重跑，作为升级后的回归探针。

## 8. 本次审查的取证限制

- 本机 `~/.claude` 全局 settings、memoryDir 内容、TG 实际 `CYBERBOSS_CLAUDE_EXTRA_ARGS` 未直读（沙箱授权范围外），对应结论标注为 Phase 0 确认项；不影响可行性判定方向。
- Tool Search 阈值细节（auto≈10%）与 `alwaysLoad` 来自官方文档核对，未在本机 headless 逐项复测——Phase 0 一并覆盖。
