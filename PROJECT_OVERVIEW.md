# Cyberboss Telegram Memory — 项目介绍与实现状态

> 最后更新：2026-07-10  
> 本文专门回答：**哪些功能已经跑通，哪些设计已经收敛，哪些只是有文件/页面但尚未接通，下一步应该先做什么。**

## 1. 项目是什么

本项目基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek)，保留其作为稳定运行时，并在外部增加：

- Telegram + Claude Code + DeepSeek 的本地运行链；
- 关系连续性记忆 `memory/` 与 `memory-kit/`；
- candidate → closeout → canon 的审核思路；
- 520 本地记忆面板；
- Windows 快捷启动、隐藏启动与诊断工具；
- 对历史核心补丁的可审计回退路径。

核心原则：

> **原版 Cyberboss 是运行基线；记忆、面板和启动器是外挂层。**

记忆系统的目标不是让模型背诵旧事，而是让换窗口、`/new` 或换模型之后，关系史不会完全清零。

---

## 2. 先分清三个“现在”

### 2.1 当前本地运行版本

对应 GitHub 分支：`legacy-current`

这是曾经实际跑过的本地定制版本，包含：

- Telegram → Claude Code → DeepSeek 链路；
- 关系记忆 workspace；
- 520 面板；
- Janitor；
- Windows 启动脚本；
- 历史上为代理、重复回复、offset、单实例等问题叠加的补丁。

它能提供真实行为证据，但不是未来继续堆功能的底座。

### 2.2 GitHub `main`

`main` 是目标结构，不是当前部署现场：

```text
原版 Cyberboss 核心
+ extensions/relationship-memory
+ extensions/windows-launcher
+ docs / audit rules
```

它刻意没有带入大部分历史 Telegram 补丁，因此目前更干净，但尚未在全新目录完成端到端部署验证。

### 2.3 私密运行状态

真实运行数据仍在本地，不进入 Git：

```text
~/.cyberboss-deepseek-test/
├─ .env / token
├─ sessions / offsets
├─ conversations / logs
├─ desire state/history
└─ private memory
```

GitHub 仓库只保存代码、结构、脱敏模板和审计材料。

---

## 3. 状态标记

| 标记 | 含义 |
|---|---|
| ✅ RUNNING | 已在本地运行过，或已有明确测试通过记录 |
| 🟢 CONVERGED | 设计边界已经确定，后续不应反复推翻 |
| 🟡 PARTIAL | 已有代码或曾经可用，但路径、边界或部署尚未收敛 |
| 🧱 SCAFFOLD | 已有文件、模板、页面或接口外壳，完整产品闭环尚未接通 |
| ⬜ PLANNED | 尚未实现，仅在路线图中 |
| 🗑 RETIRED | 已放弃或明确不应带回新主线 |

---

## 4. 已经实现并跑通过的部分

### 4.1 Cyberboss 基础运行时

| 功能 | 状态 | 当前结论 |
|---|---|---|
| 上游 Cyberboss 运行时 | 🟢 CONVERGED | 以上游 `ecc98cd` 脱敏基线作为默认正确行为 |
| Telegram 收发 | ✅ RUNNING | 本地 legacy 版本曾实际运行 |
| Claude Code runtime 调用 | ✅ RUNNING | 本地链路可拉起 Claude Code |
| DeepSeek Anthropic-compatible endpoint | ✅ RUNNING | 当前 TG 主线使用过该接入方式 |
| 会话、offset、日志、状态目录 | ✅ RUNNING | 本地 live state 已存在并持续使用 |
| 原版 Cyberboss 在 GitHub 的对照基线 | ✅ RUNNING / 🟢 CONVERGED | `upstream-baseline` 分支与基线 tag 已建立 |

### 4.2 关系记忆文件层

| 功能 | 状态 | 当前结论 |
|---|---|---|
| `reentry.md` | ✅ RUNNING / 🟡 PARTIAL | 文件结构和本地循环已存在；TG 是否始终读到最新 v2 prompt 仍需验证 |
| `episodes.jsonl` | ✅ RUNNING | 私密本地曾有正式 episodes；Git 中仅保留脱敏结构 |
| `relationship_timeline.md` | ✅ RUNNING | 已有故事层文件和本地内容 |
| `user_portrait.md` | ✅ RUNNING | 已有证据式画像结构 |
| `ai_self_portrait.md` / `ai_self_notes.md` | ✅ RUNNING | 自画像和自叙述文件已建立 |
| `home.md` / `closeout_guide.md` | 🟢 CONVERGED | 设计目的已明确：说明运转方式与低频 closeout，而非热路径规训 |
| `state_log.jsonl` 冻结 | 🟢 CONVERGED（设计） | v2.1 已明确不再让 AI 手写；实现和面板仍需同步收尾 |

### 4.3 Janitor 与候选提取

| 功能 | 状态 | 当前结论 |
|---|---|---|
| 对断档 session 做增量扫描 | ✅ RUNNING | Janitor 已实现 |
| 写入 `episodes.candidates.jsonl` | ✅ RUNNING | 自动流程只写候选，不直接污染正式 episodes |
| 生成 `reentry.extracted.md` | ✅ RUNNING | 作为补记参考稿，不直接注入 |
| 幂等位点 `.janitor_state.json` | ✅ RUNNING | 用于避免重复处理 |
| Janitor 测试 | ✅ RUNNING | 现有审计记录为 18/18 通过 |
| Candidate → canon 自动晋升 | ⬜ PLANNED | 目前没有稳定审核、去重、合并与晋升闭环 |

### 4.4 520 本地面板

| 功能 | 状态 | 当前结论 |
|---|---|---|
| 本地 HTTP 面板 `127.0.0.1:520` | ✅ RUNNING | 面板代码和启动方式已存在 |
| 健康度页 | ✅ RUNNING / 🟡 PARTIAL | 能显示候选、reentry 预算、Janitor 状态；指标仍需迁移校准 |
| 时间线视图 | ✅ RUNNING | 已有 timeline 渲染与 episode 展开能力 |
| 文件查看/编辑与自动备份 | ✅ RUNNING | 默认只读，编辑保存前有 diff/备份思路 |
| Janitor 手动触发与定时触发 | ✅ RUNNING / 🟡 PARTIAL | 代码存在；需确认新部署是否默认启用以及失败策略 |
| API token 与本地写接口 | ✅ RUNNING / 🟡 PARTIAL | 已实现，但写权限范围仍需收敛 |
| 八维曲线 | 🟡 PARTIAL | 当前仍主要围绕冻结的 `state_log.jsonl`，尚未完全转向 desire runtime |

### 4.5 Windows 本地启动

| 功能 | 状态 | 当前结论 |
|---|---|---|
| `start-safe.ps1` | ✅ RUNNING / 🟡 PARTIAL | 本地可启动，但路径硬编码且混入历史代理/单实例处理 |
| 隐藏启动辅助脚本 | ✅ RUNNING | `.vbs` / hidden child process 方案已存在 |
| Claude CLI 路径自动发现 | ✅ RUNNING / 🟡 PARTIAL | 已有实现，仍需提取为最小 Windows 兼容补丁 |
| `stop-safe.ps1` | ✅ RUNNING | 有显式停止脚本 |
| watchdog | 🟡 PARTIAL | 已实现，但旧日志显示可能放大故障；首个干净部署不应默认启用 |

### 4.6 GitHub 与审计基础设施

| 功能 | 状态 | 当前结论 |
|---|---|---|
| Private GitHub 仓库 | ✅ RUNNING / 🟢 CONVERGED | 已成为代码和审计材料的统一入口 |
| `upstream-baseline` | ✅ RUNNING | 回答“原版是什么” |
| `legacy-current` | ✅ RUNNING | 回答“本地后来改了什么” |
| `main` | ✅ RUNNING（仓库）/ 🟡 PARTIAL（部署） | 目标结构已建立，尚未干净部署 |
| `audit/core-patches-20260710` | ✅ RUNNING | 核心补丁审计材料已集中 |
| 基线 tag | ✅ RUNNING | `baseline-ecc98cd-sanitized` 已建立 |
| Windows 脚本编码 Skill | 🟢 CONVERGED | 后续 `.ps1/.bat/.cmd` 必须避免 PowerShell 5.1 编码坑 |

---

## 5. 已经收敛的设计边界

这些不是“暂时想法”，而是后续开发应遵守的稳定边界。

### 5.1 上游优先

- 不重新设计 Cyberboss 核心；
- 不因“代码更漂亮”而重写 `src/core/app.js`；
- 核心改动必须有可复现问题、最小补丁、smoke test 和 rollback。

### 5.2 记忆是插件，不是主人格

- Cyberboss 负责人格、对话、session、desire runtime；
- 关系记忆负责 episodes、timeline、reentry、portraits；
- 记忆提供背景，不直接规定下一句话内容。

### 5.3 Candidate 与 canon 必须分离

- 自动流程只写 candidates；
- 正式 episodes / timeline / portrait 由 closeout、人工确认或明确审核流程写入；
- 面板和 API 不应绕过这条边界。

### 5.4 隐私数据不进 Git

- `.env`、token、sessions、offsets、conversations、logs、真实私密 memory 永不提交；
- Git 中只保留结构、代码和虚构/脱敏样例。

### 5.5 热路径必须轻

- 新窗口只需极少量 reentry；
- timeline、episodes、portraits 按需读取；
- 不把整套记忆规则和历史每轮塞给模型。

---

## 6. 已实现但尚未收敛的部分

### 6.1 TG prompt / state 目录

当前风险：

- 记忆模板已经是 v2；
- 历史 TG 运行副本可能仍是 v1；
- `sync_memory_block.py` / `memory_toggle.py` 曾默认指向 `~/.cyberboss`；
- TG 实际使用的是 `~/.cyberboss-deepseek-test`。

目标：所有同步脚本必须显式接收 `--state-dir` 或 `CYBERBOSS_STATE_DIR`，未提供时停止，不再猜路径。

### 6.2 两套 memory 并存

当前风险：

- Cyberboss 旧内置 memory 仍可能启用；
- 新关系 memory 同时存在；
- 历史启动脚本默认 `CYBERBOSS_MEMORY_BACKGROUND_WRITE=1`。

目标：首个干净部署明确设为 `0`，旧 memory 保留代码但停止后台双写。

### 6.3 520 面板半迁移

当前不一致：

- 设计要求 reentry 约 300 字；
- 面板仍写 `REENTRY_BUDGET = 800`；
- `state_log.jsonl` 已声明冻结；
- 面板仍保留 state_log 写入和以其为主要八维来源的逻辑。

目标：第一阶段将面板改为只读运行状态，停止写 state_log；第二阶段再接 desire runtime。

### 6.4 Windows 启动脚本不便迁移

当前问题：

- 硬编码本机路径；
- 混入代理探测、旧 memory 默认开启、PID/stale process 处理；
- 启动入口过多。

目标：一个配置文件 + 一个主入口；其他脚本只作为诊断或兼容层。

### 6.5 Auto compact / `/ctx`

代码和 hooks 已经存在，但它是独立功能岛，牵涉：

- `app.js`；
- runtime adapter；
- command registry；
- compact state / history / pending；
- pre/post compact hooks。

目标：不进入首个稳定版本。先审计价值和副作用，再作为独立 feature 分支决定。

### 6.6 Desire history / backfill

历史实现存在明确风险：

- 同名函数重复定义；
- 同一状态可能从两个事件源重复写；
- 每次启动扫描全部 conversations；
- history 和面板的数据源尚未统一。

目标：首版只读当前 desire state；history 以后作为独立 service 重做。

### 6.7 Watchdog

代码已存在，但历史上可能反复拉起 TG/dashboard，放大代理或启动故障。

目标：干净部署首轮不启用；先确认单入口运行稳定，再决定健康检查与重启策略。

---

## 7. 目前只有外壳或新建文件的功能

### 7.1 Candidate 审核与晋升界面 — 🧱 SCAFFOLD / ⬜ PLANNED

已有：

- candidates 文件；
- 面板基础设施；
- API 和文件编辑能力。

缺少：

- 候选去重；
- 同一事件合并；
- 证据预览；
- 接受 / 拒绝 / 延后；
- 晋升到 episodes / timeline / portrait；
- 冲突与回滚。

### 7.2 自动 closeout — 🧱 SCAFFOLD

已有：

- `closeout_guide.md`；
- 三问模板；
- 正史文件结构。

缺少：

- 稳定触发时机；
- 每日 0–1 条 episode 的自动/半自动流程；
- closeout 失败后的 Janitor 补偿；
- 提交前 diff 与确认。

### 7.3 Memory-vault 风格流转 — ⬜ PLANNED

目标：

```text
inbox / candidates
    → review
    → canon
    → archive / retired
```

目前只有候选与正式文件分离，尚未完成统一目录、frontmatter、MCP 工具和软删除流程。

### 7.4 Topic index — ⬜ PLANNED

尚未建立“话题别名 → episode id”的轻量索引。当前 episodes 数量还不大，可以延后。

### 7.5 语义检索 — ⬜ PLANNED

没有接入向量库或 embedding 检索。当前策略仍是策展 Markdown + 按需读取；等 episodes 规模明显增长再评估。

### 7.6 证据链 — 🧱 SCAFFOLD

部分文件要求记录 episode id，但尚未统一：

- source message / conversation ref；
- timeline → episode 链接；
- portrait 判断 → 证据链接；
- reentry 钩子 → 未完成事件来源。

### 7.7 关怀模块 — 🧱 SCAFFOLD

已有：

- 面板关怀页；
- care config / cycle 录入思路；
- 本地存储边界。

尚未实现完整产品链：

- 天气数据接入；
- 月经数据的明确授权与读取边界；
- 轻触提醒频率控制；
- 与对话姿态的安全集成；
- 禁止数据进入 portrait / episodes 的自动检查。

### 7.8 剧场 / RPG — 🧱 SCAFFOLD

已有：

- `theater/` 模板；
- 剧本索引；
- 面板只读展示位。

尚未实现：

- 战役创建/结束流程；
- NPC 与剧情状态管理；
- 戏内/戏外记忆隔离的自动校验；
- 与 Telegram 对话运行时的接线。

### 7.9 语音转文字 — ⬜ PLANNED

尚未接入本地 Whisper 或 API。未来应作为输入层存在，不直接修改记忆核心。

### 7.10 主动消息 — ⬜ PLANNED

尚未实现，并且属于高风险功能。必须等基础循环、边界和频率控制稳定后再做。

### 7.11 自动 smoke tests / CI — ⬜ PLANNED

目前有部分单元测试和人工验证记录，但没有覆盖以下完整链路的自动测试：

```text
Telegram 输入
→ runtime 调用
→ 回复
→ reentry 加载
→ candidate 生成
→ dashboard 展示
→ 安全停止 / 恢复
```

---

## 8. 已放弃或不应带回主线

| 功能/方向 | 状态 | 结论 |
|---|---|---|
| Ombre Brain / Haven 主线 | 🗑 RETIRED | 已放弃，不再作为当前记忆底座 |
| 独立 `reading_policy` 热路径规则 | 🗑 RETIRED | v2.1 已并入 `home.md`，原文件只作占位/历史 |
| AI 手写 `state_log.jsonl` | 🗑 RETIRED | 八维归 Cyberboss desire runtime |
| Telegram 自建代理层 | 🗑 RETIRED（默认） | 不带回 `main`，除非干净部署可复现明确必要性 |
| 额外 offset/state 热刷新 | 🗑 RETIRED（默认） | 不再容忍错误多进程状态 |
| 入站/出站文本去重 | 🗑 RETIRED（默认） | 不在末端吞消息，应修发送源头 |
| stateDir 单实例锁补丁 | 🗑 RETIRED（默认） | 新部署先用单一启动入口解决 |
| 关闭原版 delta 流式 | 🗑 RETIRED | 恢复上游流式行为 |
| runtime outage 死代码 | 🗑 RETIRED | 未形成有效调用链 |

---

## 9. 下一版最小稳定目标

首个稳定版本不追求“功能最多”，只要求一条干净、可解释、可回滚的链路：

```text
原版 Cyberboss
+ 最小 Windows Claude 启动兼容
+ 显式 state-dir
+ 极小 relationship-memory prompt
+ 旧 memory 后台写入关闭
+ Janitor 只写 candidates
+ 520 面板先只读
+ 一个启动入口
```

### Definition of Done

- [ ] 从 `main` 在全新目录 clone；
- [ ] 不复制旧源码，只挂载必要的私密 state；
- [ ] Telegram 连续发送 10 条消息，每条回复一次；
- [ ] 原版流式行为正常；
- [ ] `/new` / resume 行为正常；
- [ ] TG 实际读取 v2 memory prompt；
- [ ] 只读取正确的 `reentry.md`；
- [ ] 旧 Cyberboss memory 不后台双写；
- [ ] Janitor 可生成 candidate，但不能写 canon；
- [ ] 520 面板能只读展示；
- [ ] 关闭程序后无残留 poller；
- [ ] 所有变更都有 diff、smoke test 和 rollback。

---

## 10. 推荐开发顺序

### Phase 0 — 当前

1. 完成只读代码审计；
2. 明确 `app.js` 各功能块；
3. 不把 legacy Telegram 补丁带回 `main`。

### Phase 1 — 最小接线

1. 修正 state-dir / prompt 同步；
2. 关闭旧 memory background write；
3. 保留最小 Windows Claude 启动兼容；
4. 建立单一启动入口；
5. 在全新目录做 smoke test。

### Phase 2 — 记忆闭环

1. Candidate 审核；
2. 去重/合并/晋升；
3. closeout 半自动化；
4. 证据链；
5. 面板与 desire runtime 统一。

### Phase 3 — 产品扩展

1. memory-vault 文件流转；
2. topic index；
3. 关怀模块；
4. 剧场；
5. 语音转文字；
6. 规模足够后再评估语义检索和主动消息。

---

## 11. 给后续 AI / 代码模型的阅读顺序

```text
1. PROJECT_OVERVIEW.md
2. README.md
3. docs/custom/CURRENT_PROJECT_AUDIT_20260710.md
4. docs/custom/CORE_PATCH_REVIEW_20260710.md
5. extensions/relationship-memory/PROJECT.md
```

第一轮只允许审计，不直接大改核心。

---

## English summary

This repository separates a previously running but heavily patched local deployment (`legacy-current`) from a cleaner upstream-first target (`main`).

Already running locally:

- Telegram → Claude Code → DeepSeek;
- relationship-memory files;
- Janitor candidate extraction;
- the local 520 dashboard;
- Windows launch helpers.

Converged boundaries:

- upstream Cyberboss remains the runtime baseline;
- memory is an additive plugin, not the personality engine;
- automation writes candidates, never canon;
- private live state stays outside Git.

Not yet complete:

- clean deployment from `main`;
- prompt/state-dir alignment;
- old-memory isolation;
- candidate review and promotion;
- dashboard migration to the desire runtime;
- portable single-entry Windows startup;
- care, theater, speech-to-text, semantic retrieval and proactive messaging.
