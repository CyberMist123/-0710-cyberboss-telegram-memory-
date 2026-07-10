<div align="center">

# Cyberboss Telegram Memory

**中文 · English**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的私有 Telegram + 关系记忆扩展仓库。  
A private Telegram and relationship-memory extension built on top of [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek).

</div>

> [!WARNING]
> 当前仓库仍处于“冻结现场 → 审计 → 干净部署”阶段。`main` 暂时不是可直接替换现有本地部署的稳定版本。请先审计，再在新目录做 smoke test。  
> This repository is still in the **freeze → audit → clean deployment** stage. `main` is not yet a drop-in replacement for the current local deployment. Audit first, then test in a fresh directory.

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

### 当前任务 / Tasks

- [x] 冻结三个时间点的本地项目和私密冷备份。
- [x] 建立 private GitHub 仓库与安全规则。
- [x] 标出 16 个真正修改过逻辑的核心文件。
- [x] 生成 Fable 审计提示词、全文对照和脱敏 patch。
- [x] 添加 Windows 脚本编码 Skill。
- [ ] 完成 `upstream-baseline`、`main`、`legacy-current` 三条分支上传。
- [ ] 让 Fable 只做第一轮审计，不直接改代码。
- [ ] 将 Telegram 代理、额外 offset/去重、单实例锁、重复回复抑制逐项恢复上游并测试。
- [ ] 为 `src/core/app.js` 建立功能块地图，识别死代码和重复定义。
- [ ] 统一 TG 实际使用的 prompt/state 目录。
- [ ] 明确停用或隔离 Cyberboss 旧内置 memory，避免与关系 memory 双写。
- [ ] 修复 520 面板与 desire-state / state_log 的半迁移状态。
- [ ] 在全新目录完成端到端 smoke test，再决定是否切换部署。

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

### Architecture

```text
Telegram
  → upstream-first Cyberboss runtime
  → Claude Code / DeepSeek endpoint
  → workspace memory + memory-kit + dashboard + launcher

Private live state remains outside Git:
  ~/.cyberboss-deepseek-test/
```

### Current goals

- Preserve upstream Cyberboss behavior.
- Keep relationship memory additive and reviewable.
- Allow automation to create candidates, not canon.
- Isolate private runtime state from source code.
- Replace broad historical fixes with small, tested patches.
- Deploy only from a clean directory after smoke tests pass.

### Branches

- `upstream-baseline`: sanitized upstream baseline at `ecc98cd`.
- `main`: target upstream-first implementation plus reviewed extensions.
- `legacy-current`: frozen sanitized snapshot of the current customized deployment.
- `audit/core-patches-20260710`: audit package for Fable and other code-review models.
- `fix/*`: one narrowly scoped change per branch.

### Status

The repository is currently being uploaded and audited. Do not deploy `main` over the existing local installation yet. Keep the current deployment frozen until Telegram messaging, runtime resume, memory loading, dashboard access and failure recovery pass end-to-end smoke tests.

### Privacy

Never commit live `.env` files, API keys, Telegram tokens, sessions, offsets, conversations, logs, private memory content, PID/lock files, or cached runtime state.

---

## License and upstream

The runtime derives from [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek). Upstream licensing and notices remain applicable. Local private extensions are maintained in this repository for personal deployment and review.
