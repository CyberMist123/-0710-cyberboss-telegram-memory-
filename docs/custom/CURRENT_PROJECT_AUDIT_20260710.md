# Cyberboss / TG / 关系记忆项目盘点

日期：2026-07-10

## 一、三个压缩包分别是什么

### 1. `.cyberboss-deepseek-test(1).zip`

这是 `%USERPROFILE%/.cyberboss-deepseek-test` 的运行状态快照，不是源码仓库。

包含 `.env`、runtime token、Telegram offset、sessions、conversations、compact history/pending、desire state/history、日志、PID/lock，以及 Cyberboss 旧内置 memory。它决定“现在这个 TG 实例跑到哪了”，但包含真实密钥与私密聊天，禁止原样提交 GitHub。

### 2. `cyberboss-deepseek-workspace.zip`

这是较早的 Claude/Codex 工作区快照。与 `cyberlink(1).zip` 中的同名 workspace 对比：排除缓存与日志后，旧包有 29 个文件；当前大包有 81 个；13 个完全相同，16 个后来发生变化，当前版另新增 52 个。旧包没有独有的有效文件，因此应作为历史备份，不能覆盖当前 workspace。

### 3. `cyberlink(1).zip`

这是目前最完整的工程快照，包含：

- `cyberboss-deepseek-test/`：Node 主程序与原 Git 历史；
- `cyberboss-deepseek-workspace/`：当前 Claude/Codex 工作区、关系记忆、memory-kit、520 面板、janitor 与 watchdog；
- `cyberboss-workspace/`：基本只剩 `.git/.agents` 的旧壳，不是当前主线；
- `node_modules` 等大体积本地依赖。

因此当前真实主线是：大包中的源码 + 大包中的 workspace + 单独运行状态包中的 live state。不是一个简单目录，也不是三个平级项目。

## 二、当前架构理解

```text
Telegram
  → scripts/windows/start-safe.ps1
  → cyberboss-deepseek-test/bin/cyberboss.js
  → Telegram adapter / poller
  → Claude Code runtime adapter
  → DeepSeek Anthropic-compatible endpoint
  → cyberboss-deepseek-workspace/
      ├─ CLAUDE.md / PROJECT.md
      ├─ memory/：关系连续性正史与候选
      ├─ memory-kit/：janitor、提取、520 面板、同步脚本
      └─ launcher/watchdog.py：TG / 微信 / dashboard 监督

运行状态另存：
%USERPROFILE%/.cyberboss-deepseek-test/
  ├─ .env / sessions / telegram-state
  ├─ conversations / compact context
  ├─ desire-state / desire-history
  ├─ logs / locks / token
  └─ memory/：Cyberboss 旧内置记忆
```

目前有两套记忆栈并存：源码内置的旧工具型 memory，以及 workspace 中新关系连续性 memory。新系统没有完全替换旧系统，只是主要靠 Claude 在工作区中读写文件运行。

## 三、当前卡点（按优先级）

### P0：源码与版本正史尚未建立

源码仍停在上游 commit `ecc98cd`、分支 `local-safe-test`，工作区有大量未提交改动。普通 Git diff 显示 158 个 tracked 文件变化，但绝大多数是 CRLF/LF 换行噪声；忽略行尾差异后，真正有内容变化的 tracked 文件约 16 个，另有 18 个 untracked 文件。workspace 本身没有可用 Git 历史，当前大 ZIP 事实上是唯一正史。

### P0：TG 实际使用的记忆提示词仍是旧版

源码模板 `templates/weixin-instructions.md` 已是 v2；运行状态目录中的 `weixin-instructions.md` 仍是 v1，并继续指向已经废弃的 `memory/reading_policy.md`。

根因很可能是 `sync_memory_block.py` 与 `memory_toggle.py` 默认写 `%USERPROFILE%/.cyberboss`，而 TG 实际状态目录是 `%USERPROFILE%/.cyberboss-deepseek-test`。双击同步若没有显式继承 `CYBERBOSS_STATE_DIR`，会同步到微信线而不是 TG 线。

### P0：代理/网络是当前活故障

运行日志尾部持续出现 `ECONNREFUSED 127.0.0.1:7897`、TLS reset、Telegram 发送/轮询失败。Python janitor 的 `requests` 也会继承同一代理环境，所以 TG 聊天和记忆提取被同一个代理故障同时拖死。

### P1：两套记忆仍并存

旧 Cyberboss memory 的 pre-response retrieval 仍接在 `src/core/app.js`；Windows 启动脚本在未设置时默认开启 `CYBERBOSS_MEMORY_BACKGROUND_WRITE=1`。当前旧 memory 文件基本为空，所以暂时污染不重，但架构上仍有两个独立读写者，未来会漂移。

### P1：候选生产成功，晋升环节没闭环

janitor 测试 18/18 通过，当前有 11 条正式 episode、70 条合法 candidate。短板已经不是“提取不出来”，而是没有稳定的候选审核、晋升、合并与压缩流程。

### P1：520 面板只迁了一半到 v2.1

`PROJECT.md` 已规定 reentry ≤300 字、`state_log.jsonl` 冻结、desire runtime 为准；但 `dashboard.py` 仍把预算写成 800，API 文档仍暴露 state-log 写入，部分 UI 文案仍围绕旧 state_log。设计与工具没有完全对齐。

### P1：watchdog 会放大故障

日志中存在大量 TG/dashboard 被判死后反复重启直至耗尽每小时 quota 的记录。当前代码里的第二个 poller 已受 channel 条件限制，因此历史 409 更像多个 OS 进程、旧启动入口或残留实例，不是当前单进程里两个无条件 loop。

### P2：旧计划与硬编码路径干扰理解和恢复

`WORKPLAN.md` 仍有已放弃的 Haven/Ombre 工作项；旧文档和当前 v2.1 文档并列。大量脚本硬编码 `C:\Users\18717\...`，无法在新机器上靠 clone + 一个配置文件恢复。

## 四、已完成的备份产物

- `cyberboss-raw-private-backup-20260710.zip`：三个原包与架构问询包的原样冷备份，带 SHA-256；包含密钥和私密聊天，只能私存。
- `cyberboss-review-snapshot-20260710.zip`：GitHub 可审查的脱敏 Git 仓库快照；真实密钥、会话、日志、缓存与关系记忆正文已排除/模板化。
- `cyberboss-review-snapshot-20260710.bundle`：同一脱敏快照的完整 Git bundle，可直接 clone。

## 五、验证

- Node `npm run check`：通过（语法检查）。
- dashboard / janitor / extractor / config / watchdog Python 编译：通过。
- `memory-kit/tests/test_janitor.py`：18/18 通过。
- JSONL：episodes 11/11、candidates 70/70、state_log 9/9 合法。
- 两个备份 ZIP：完整性测试通过。
- Git bundle：验证通过，包含完整本地历史。
