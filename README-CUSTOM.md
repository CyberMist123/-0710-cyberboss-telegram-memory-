# Cyberboss Telegram Memory — private extension repository

Private review repository based on `AngeliaSama/cyberboss-deepseek` commit `ecc98cd`.

## Start here

- [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) — 项目介绍、已跑通功能、已收敛边界、半成品、新建外壳与后续路线。
- [`README.md`](./README.md) — bilingual repository overview and current audit stage.
- [`docs/custom/CURRENT_PROJECT_AUDIT_20260710.md`](./docs/custom/CURRENT_PROJECT_AUDIT_20260710.md) — frozen local-project audit.
- [`docs/custom/CORE_PATCH_REVIEW_20260710.md`](./docs/custom/CORE_PATCH_REVIEW_20260710.md) — file-by-file core patch review.

## Branches

- `upstream-baseline`: sanitized snapshot of the trusted upstream baseline.
- `main`: upstream core plus sanitized additive relationship-memory/dashboard/Windows-launch extensions. Review target; not yet a proven deployment.
- `legacy-current`: frozen sanitized snapshot of the locally modified runtime. Compare only; do not deploy.
- `audit/core-patches-20260710`: audit branch with focused diffs and review instructions.

Read `docs/custom/REPO_POLICY.md` before changing core runtime files.
