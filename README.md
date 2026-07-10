<div align="center">

# Cyberboss Telegram Memory

**中文 · English**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的私有 Telegram + 关系记忆扩展仓库。  
A private Telegram and relationship-memory extension built on top of [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek).

</div>

> [!IMPORTANT]
> 仓库化与冻结现场已经完成。当前阶段是：**只读审计 → 最小接线 → 新目录验证**。  
> `main` 仍不是可以直接覆盖现有本地部署的稳定版。不要删除旧目录，不要直接部署。

## 先看这里 / Start here

| 文档 | 适合什么时候看 |
|---|---|
| [`PROJECT_INTRO_FOR_HUMANS.md`](./PROJECT_INTRO_FOR_HUMANS.md) | **第一次了解项目。** 用人话解释核心功能、你会看到什么、背后怎么实现、现在做到哪一步。 |
| [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) | **确认完成度。** 区分已跑通、已收敛、半成品、外壳、计划和已放弃功能。 |
| [`MEMORY_520_MAP.md`](./MEMORY_520_MAP.md) | **专门理解记忆和 520。** 包含结构图、读写链路、已知 bug、数据权威来源和修复顺序。 |
| [`docs/custom/CORE_PATCH_REVIEW_20260710.md`](./docs/custom/CORE_PATCH_REVIEW_20260710.md) | 给代码审查模型看的核心补丁清单。 |

---

## 中文

### 这个项目是什么

Cyberboss 原仓库负责稳定运行时、Telegram/微信桥接和 Claude Code / Codex 调用。本仓库尽量不改动它的核心行为，只维护外挂能力：

- Telegram + DeepSeek / Claude Code 本地部署；
- 关系连续性记忆 `memory/` 与 `memory-kit/`；
- candidate → review/closeout → canon；
- 520 本地记忆维护面板；
- Windows 启动、隐藏启动与诊断；
- 对历史核心补丁的可审计回退路径。

核心原则：

> **原版 Cyberboss 是运行基线；记忆、面板和启动器是外挂层。**

记忆的目标不是让模型背诵旧事，而是让换窗口、`/new` 或换模型之后，关系史不会完全清零。

### 当前真实状态

```text
本地 legacy-current
  曾实际运行过：Telegram → Claude Code → DeepSeek
  包含完整关系记忆、520、Janitor、Windows 启动器
  也包含后来叠加的代理/去重/offset/单实例等补丁

GitHub main
  原版 Cyberboss 核心
  + extensions/relationship-memory
  + extensions/windows-launcher
  + docs / audit rules
  结构更干净，但尚未在全新目录完成端到端验证

私密 live state（不进 Git）
  ~/.cyberboss-deepseek-test/
  包含 .env、token、sessions、offsets、logs、真实私密 memory
```

### 当前架构

```text
Telegram
   ↓
Cyberboss runtime（以上游为基线）
   ↓
Claude Code / DeepSeek endpoint
   ↓
Workspace
   ├─ memory/                 reentry、episodes、timeline、portraits
   ├─ memory-kit/             Janitor、candidate、提取和维护工具
   ├─ dashboard.py            520 本地控制台
   └─ launcher / scripts      Windows 启动与诊断
```

### 目前已经跑通过

- Telegram → Cyberboss → Claude Code → DeepSeek → 回复；
- 关系记忆文件层；
- Janitor 增量扫描与 candidate 输出；
- Janitor 幂等、缓存和 dry-run；
- 520 面板打开、文件查看、timeline、健康度和 Janitor 触发；
- Windows 本地启动与隐藏启动；
- GitHub 三个主要对照分支和基线 tag。

### 已实现但尚未收敛

- TG 实际使用的 prompt / state-dir；
- 旧 Cyberboss memory 与新关系 memory 的读写边界；
- 520 从 `state_log` 向 `desire-state` 的迁移；
- 520 普通查看与维护写入权限；
- Windows 启动路径、入口和 watchdog；
- auto compact / `/ctx`；
- desire history / backfill。

### 目前只有外壳或计划

- Candidate 去重、合并、证据预览、接受/拒绝/晋升和回滚；
- 自动 closeout；
- 完整证据链；
- memory-vault 风格流转；
- 关怀模块完整链路；
- RPG 剧场运行；
- 语音转文字；
- topic index；
- 语义检索；
- 主动消息；
- 端到端自动 smoke tests。

### 已放弃或默认不带回主线

- Ombre Brain / Haven 主线；
- AI 手写 `state_log.jsonl`；
- Telegram 自建代理层；
- 额外 offset/state 热刷新；
- 入站/出站文本 TTL 去重；
- stateDir 单实例锁补丁；
- 关闭原版 delta 流式；
- 无有效调用链的 runtime outage 逻辑。

### 当前最重要的 bug / 冲突

1. `sync_memory_block.py` 和 `memory_toggle.py` 可能默认写到 `~/.cyberboss`，而 TG 实际使用 `~/.cyberboss-deepseek-test`。
2. `main` 已移动目录，但 prompt 同步脚本仍按旧 cyberlink 相对路径找模板。
3. 旧启动脚本可能默认 `CYBERBOSS_MEMORY_BACKGROUND_WRITE=1`，导致两套 memory 同时写。
4. v2.1 设计要求 reentry 约 300 字，但 dashboard 仍按 800 字检查。
5. `state_log.jsonl` 已宣布冻结，但 520 仍暴露写 API。
6. 520 名义上是“外显”，实际同时承担查看、编辑、配置和调度。

详见 [`MEMORY_520_MAP.md`](./MEMORY_520_MAP.md)。

### 分支约定

| 分支 | 用途 | 是否部署 |
|---|---|---|
| `upstream-baseline` | 上游 `ecc98cd` 的脱敏基线 | 否，只作比较 |
| `main` | 原版核心 + 外挂扩展目标结构 | 暂未稳定 |
| `legacy-current` | 当前本地定制版的脱敏冻结现场 | 否，只作救援与对照 |
| `audit/core-patches-20260710` | 核心补丁和审计材料 | 否 |
| `fix/*` | 一个问题一个小修复 | 新目录验证后再合并 |

### 核心需求

1. 不宽泛重构 `src/core/app.js` 等上游核心。
2. 换窗口、`/new` 或换模型后关系史不清零。
3. 自动流程只写 candidates；canon 必须经过 closeout 或确认。
4. 记忆改变下一句话的姿态，不直接规定内容。
5. 每个核心改动都有原因、smoke test 和 rollback。
6. 真实 token、会话、日志和私人记忆永不提交。
7. Windows 脚本必须避免 PowerShell 5.1 编码坑。

### 当前任务 / Tasks

- [x] 冻结本地项目与私密冷备份。
- [x] 建立 private GitHub 仓库与安全规则。
- [x] 上传 `upstream-baseline`、`main`、`legacy-current`。
- [x] 建立唯一 audit 分支和基线 tag。
- [x] 标出真正修改过逻辑的核心文件。
- [x] 添加 Windows 脚本编码 Skill。
- [x] 写出人话项目介绍、功能状态表、记忆/520 结构图。
- [ ] 修正 state-dir 与 prompt/template-root。
- [ ] 默认关闭旧 memory background write。
- [ ] 提取最小 Windows Claude 启动兼容。
- [ ] 把 520 收成默认只读版。
- [ ] 在全新目录完成 TG + memory smoke test。
- [ ] 建立 Candidate review → canon 闭环。

### 下一版最小目标

```text
原版 Cyberboss
+ 最小 Windows Claude 启动兼容
+ 显式 state-dir
+ 正确的 v2 relationship-memory prompt
+ 旧 memory 后台写入关闭
+ Janitor 只写 candidates
+ 520 默认只读
+ 一个启动入口
```

### Definition of Done

- [ ] 从 `main` 在全新目录 clone；
- [ ] Telegram 连续发送 10 条消息，每条只回复一次；
- [ ] 原版流式行为正常；
- [ ] `/new` / resume 正常；
- [ ] TG 实际读取 v2 prompt 与正确的 `reentry.md`；
- [ ] 旧 Cyberboss memory 不后台双写；
- [ ] Janitor 只生成 candidate；
- [ ] 520 默认只读可用；
- [ ] 关闭后无残留 poller；
- [ ] 所有变更都有 diff、测试和 rollback。

### 隐私边界

绝不提交：

```text
.env
API keys / Telegram token
sessions / offsets
conversations / logs
真实私人 memory
desire live state
PID / lock / cache
```

---

## English summary

This repository separates a previously running but heavily patched deployment (`legacy-current`) from a cleaner upstream-first target (`main`).

### Core functions

- Telegram → Cyberboss → Claude Code → DeepSeek chat flow;
- relationship continuity through reentry, episodes, timeline and portraits;
- Janitor extraction from conversation logs into candidates;
- a local 520 dashboard for viewing and maintaining memory;
- Windows launch and diagnostic helpers;
- auditable comparison against a trusted upstream baseline.

### Current status

Already running locally:

- Telegram chat flow;
- relationship-memory files;
- Janitor candidate extraction;
- the 520 dashboard;
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
- dashboard migration from `state_log` to the desire runtime;
- portable single-entry Windows startup;
- care, theater, speech-to-text, semantic retrieval and proactive messaging.

Read first:

- [`PROJECT_INTRO_FOR_HUMANS.md`](./PROJECT_INTRO_FOR_HUMANS.md)
- [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md)
- [`MEMORY_520_MAP.md`](./MEMORY_520_MAP.md)

## License and upstream

The runtime derives from [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek). Upstream licensing and notices remain applicable. Local private extensions are maintained in this repository for personal deployment and review.