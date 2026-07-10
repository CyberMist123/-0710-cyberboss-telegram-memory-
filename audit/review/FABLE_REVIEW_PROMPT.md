# 给 Fable / 代码审查模型的任务

请只做审查与回退规划，不要直接改代码。

项目基于 `AngeliaSama/cyberboss-deepseek`。原仓库运行逻辑本来正常；后续为修 Telegram 代理、409、重复回复、offset、单实例等问题，核心文件逐渐叠加大量补丁。用户明确认为这些补丁大多不需要，甚至可能是“修 bug 产生更多 bug”。

真正需要保留的主要是 DeepSeek + Claude Code 必要接入、新建关系记忆 `memory/` 与 `memory-kit/`、520 网页面板、Windows 本地快捷启动/隐藏启动，以及极小的 memory prompt 入口。

## Git 对照

- `upstream-baseline`: 对应原版基线 `ecc98cd1510c659f70ed7ac2dcc9b64c05ae7119` 的脱敏快照
- `legacy-current`: 当前脱敏现场
- `main`: 原版核心 + 外挂扩展的目标形状（尚未部署验证）
- 详细清单：`audit/review/CORE_PATCH_REVIEW_20260710.md`

## 要求

1. 以上游行为为默认正确答案。
2. 对核心改动逐个判断：`restore upstream` / `keep minimal patch` / `move to extension` / `needs reproduction`。
3. 特别审查 `src/core/app.js`、Telegram proxy/state/dedupe、stream-delivery、PID lock、auto compact、desire history/backfill。
4. 已知疑点：重复定义、死代码、desire history 双写、启动全量扫描、deleteWebhook 误治多 poller。
5. 不要整文件重写 `src/core/app.js`。
6. 输出最小回退顺序；每一步附影响范围、smoke test、rollback。
7. 目标是“原版 Cyberboss 核心 + 外挂式 memory/dashboard/launcher”，不是重新设计 Cyberboss。
