<div align="center">

# Cyberboss Telegram Memory

**中文 · English**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的私有 Telegram + 关系记忆扩展仓库。  
A private Telegram and relationship-memory extension built on top of [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek).

</div>

> [!IMPORTANT]
> 仓库化与冻结现场已经完成。当前阶段是：**只读审计 → 决定保留/回退边界 → 新目录验证**。  
> `main` 仍不是可以直接覆盖现有本地部署的稳定版。不要删除旧目录，不要直接部署。  
> Repository import and snapshotting are complete. The current phase is **read-only audit → retention/revert decisions → clean-directory validation**.

---

## 中文

### 这个项目是什么

Cyberboss 原仓库负责稳定的运行时、Telegram/微信桥接和 Claude Code / Codex 调用。本仓库尽量不改动它的核心行为，只维护后装扩展：

- Telegram + DeepSeek / Claude Code 的本地部署配置；
- 关系连续性记忆 `memory/` 与 `memory-kit/`；
- candidate → closeout → canon 的审核链；
- 520 记忆面板和状态展示；
- Windows 快捷启动、隐藏启动、诊断和 watchdog；
- 对本地历史补丁的逐文件审计与最小回退。

项目原则：**原版 Cyberboss 是基线，新增能力尽量作为外挂层存在。**

### 当前节点

仓库已经完成四条核心分支与基线 tag 的建立：

```text
upstream-baseline
  上游 ecc98cd 的脱敏基线，用来回答“原版是什么”

legacy-current
  当前本地定制版的脱敏冻结现场，用来回答“后来改了什么”

main
  原版核心 + 已整理的外挂结构，暂不部署

audit/core-patches-20260710
  给 Fable / Codex / 其他代码模型的审计材料

tag: baseline-ecc98cd-sanitized
  固定上游比较基准
```

现在不再卡在“上传和备份”。真正进入的是下一道决策门：

> **哪些历史补丁恢复上游，哪些产品功能保留，哪些功能应移出核心。**

### 当前架构

```text
Telegram
   ↓
Cyberboss runtime（以上游原仓库为基线）
   ↓
Claude Code / DeepSeek Anthropic endpoint
   ↓
Workspace
   ├─ memory/                 关系正史、reentry、episodes、timeline
   ├─ memory-kit/             candidate、janitor、closeout、审核工具
   ├─ dashboard / 520 panel   可视化与人工审核
   └─ launcher / scripts      Windows 本地启动与诊断

Live state（不进 Git）
   └─ ~/.cyberboss-deepseek-test/
      ├─ .env / token
      ├─ sessions / offsets
      ├─ conversations / logs
      └─ private memory / desire state
```

### 项目结构

```text
.
├─ src/                       上游 Cyberboss 运行时源码
├─ bin/                       CLI 入口
├─ scripts/                   上游与通用脚本
├─ templates/                 运行时提示词模板
├─ extensions/
│  ├─ memory-workspace/       脱敏后的关系记忆结构与模板
│  ├─ memory-kit/             提取、候选、审核、closeout
│  ├─ dashboard/              520 面板与展示工具
│  └─ windows-launcher/       快捷启动、隐藏启动、诊断脚本
├─ docs/
│  ├─ custom/                 当前架构、核心补丁审计、仓库规则
│  └─ ...                     上游文档
├─ .agents/skills/            给 Codex/Fable/其他代理的项目级约束
├─ UPSTREAM_BASELINE.md       上游基线说明
└─ README*.md                 上游 README 与本项目说明
```

> 目录会在审计过程中继续收敛，但不会为了“整洁”大改能跑的核心。

### 分支约定

| 分支 | 用途 | 是否部署 |
|---|---|---|
| `upstream-baseline` | 上游 `ecc98cd` 的脱敏基线快照 | 否，只作比较 |
| `main` | 原版核心 + 审核通过的外挂扩展 | 暂未稳定 |
| `legacy-current` | 当前本地定制版的脱敏冻结现场 | 否，只作救援与对照 |
| `audit/core-patches-20260710` | Fable/代码模型审计材料 | 否 |
| `fix/*` | 一个问题一个小修复 | 新目录验证后再合并 |

### 核心需求

1. **保住原版行为**：不对 `src/core/app.js` 等核心文件做宽泛重构。
2. **关系连续性**：换窗口、`/new` 或换模型后，关系史不清零。
3. **正史可控**：自动流程只写 candidates；canon 由 closeout 或用户确认。
4. **记忆不抢话**：记忆改变下一句话的姿态，不直接决定内容。
5. **可审计与可回退**：每个核心改动必须有原因、smoke test 和 rollback。
6. **隐私隔离**：真实 token、聊天、session、日志和私人记忆永不提交。
7. **Windows 友好**：脚本必须避免 PowerShell 5.1 编码坑，并可被普通用户直接运行。

### 下一道决策门

#### 倾向恢复上游并重新测试

这些是后续修 Telegram 问题时叠加的补丁，不再默认保留：

- Telegram 自建代理层；
- state/offset 从磁盘额外刷新；
- inbound/outbound 文本去重；
- stateDir 单实例锁；
- 重复回复抑制；
- runtime outage 通知；
- Telegram timeout 修改；
- 为“治重复”而关闭原版 delta 流式。

#### 需要单独审计，不能和上面一起删

- auto compact 与 `/ctx`；
- desire-state history / backfill；
- Windows Claude Code `.cmd/.bat` 启动与隐藏窗口；
- Codex RPC timeout 与 pending reject；
- `src/core/app.js` 中混杂的各个功能块。

#### 明确想保留

- `memory/` 与 `memory-kit/`；
- candidate → closeout → canon；
- 520 dashboard；
- Windows 本地快捷启动与诊断；
- 极小的关系记忆 prompt 入口；
- 上游核心与本地扩展之间的清晰边界。

### 当前任务 / Tasks

- [x] 冻结三个时间点的本地项目和私密冷备份。
- [x] 建立 private GitHub 仓库与安全规则。
- [x] 上传并验证 `upstream-baseline`、`main`、`legacy-current`。
- [x] 合并为唯一的 `audit/core-patches-20260710` 审计分支。
- [x] 推送 `baseline-ecc98cd-sanitized` 基线 tag。
- [x] 标出 16 个真正修改过逻辑的核心文件。
- [x] 生成 Fable 审计提示词、全文对照和脱敏 patch。
- [x] 添加 Windows 脚本编码 Skill。
- [ ] 让 Fable 只做第一轮只读审计，不直接改代码。
- [ ] 为 `src/core/app.js` 建立功能块地图、调用链和死代码清单。
- [ ] 对历史 Telegram 补丁逐项给出 restore / keep / move / reproduce 判断。
- [ ] 统一 TG 实际使用的 prompt/state 目录。
- [ ] 明确停用或隔离 Cyberboss 旧内置 memory，避免与关系 memory 双写。
- [ ] 修复 520 面板与 desire-state / state_log 的半迁移状态。
- [ ] 在全新目录完成端到端 smoke test，再决定是否切换部署。

### 当前已知卡点

1. **审计尚未完成**：知道哪些文件被改过，但还没有逐功能确认调用链和真实必要性。
2. **`src/core/app.js` 功能混杂**：Telegram 健康/去重、compact、desire history 等逻辑叠在同一文件。
3. **TG prompt/state 路径可能错位**：模板已是 v2，历史运行态可能仍吃到 v1。
4. **两套 memory 并存**：Cyberboss 旧内置 memory 与新关系 memory 尚未正式划清读写边界。
5. **候选有生产、无稳定晋升闭环**：提取不是瓶颈，审核、合并、晋升才是。
6. **520 面板半迁移**：reentry 预算、state_log 与 desire-state 的设计和实现尚未完全一致。
7. **Windows 启动入口过多**：历史 409/重复 poller 更可能来自多个 OS 进程和旧入口，需要在新部署中只保留一个入口。
8. **旧日志中的代理故障需重新复现**：快照曾出现 `127.0.0.1:7897` 连接失败，但不能直接假设它仍是当前故障。

### 待新增功能 / Planned features

- [ ] Candidate 审核、去重、合并与晋升界面；
- [ ] 每日 0–1 条关系 episode 的 closeout 流程；
- [ ] reentry / timeline / portrait 的可追溯证据链接；
- [ ] memory-vault 风格的 inbox → canon → archive 文件流转；
- [ ] 语义检索作为按需工具，而非每轮强制注入；
- [ ] Git 变更审计、自动备份和一键回滚；
- [ ] 更可靠的 Windows 单入口启动与健康检查；
- [ ] 面板中的运行状态、候选记忆、正史和任务统一视图；
- [ ] 使用虚构测试数据的自动 smoke tests。

### 明确不做

- 不重新设计上游 Cyberboss；
- 不为了代码漂亮删除未知但能跑的行为；
- 不让 AI 自动直接写入关系正史；
- 不把真实记忆库、聊天记录或密钥放进 GitHub；
- 不在未经测试的情况下覆盖当前本地部署。

### 给代码审查模型

第一轮请从以下文件开始：

```text
docs/custom/CORE_PATCH_REVIEW_20260710.md
docs/custom/CURRENT_PROJECT_AUDIT_20260710.md
docs/custom/REPO_POLICY.md
```

审查目标：比较 `upstream-baseline` 与 `legacy-current`，逐文件判断：

```text
restore upstream
keep as minimal patch
move to extension/service
needs reproduction before deciding
```

不要整文件重写 `src/core/app.js`。所有建议必须附 smoke test 与 rollback。

### 环境要求

- Windows 10/11；
- Node.js `>= 22`；
- Git for Windows；
- Claude Code CLI 或 Codex CLI；
- Python 3（用于 `memory-kit` / dashboard）；
- Telegram Bot token；
- DeepSeek 或其他 Anthropic-compatible endpoint；
- 私密配置放在本地 `.env`，不要提交。

---

## English

### Overview

This private repository keeps the stable upstream Cyberboss runtime as the baseline and layers local extensions around it:

- Telegram + DeepSeek / Claude Code deployment;
- relationship continuity memory and `memory-kit`;
- candidate → closeout → canon review flow;
- the 520 memory dashboard;
- Windows launch, hidden-process and diagnostic scripts;
- a file-by-file audit of accumulated local core patches.

**Upstream behavior is the default source of truth.** Core changes are kept only when a concrete local requirement and a reproducible test justify them.

### Current phase

Repository import, branch setup and baseline tagging are complete. The project is now at the decision gate between **read-only audit** and **minimal implementation changes**.

Do not deploy `main` over the current installation yet. Keep the existing deployment frozen while Fable or another review model maps the call paths and classifies every core modification as:

```text
restore upstream
keep as minimal patch
move to extension/service
needs reproduction before deciding
```

### Architecture

```text
Telegram
  → upstream-first Cyberboss runtime
  → Claude Code / DeepSeek endpoint
  → workspace memory + memory-kit + dashboard + launcher

Private live state remains outside Git:
  ~/.cyberboss-deepseek-test/
```

### Immediate blockers

- core audit is not complete;
- `src/core/app.js` contains several unrelated feature islands;
- runtime prompt/state paths may still point to an older memory prompt;
- old built-in memory and new relationship memory can both remain active;
- candidate extraction works, but review and promotion are not closed-loop;
- the dashboard is only partially migrated from `state_log` to `desire-state`;
- historical proxy failures must be reproduced before being treated as current.

### Privacy

Never commit live `.env` files, API keys, Telegram tokens, sessions, offsets, conversations, logs, private memory content, PID/lock files, or cached runtime state.

---

## License and upstream

The runtime derives from [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek). Upstream licensing and notices remain applicable. Local private extensions are maintained in this repository for personal deployment and review.
