# Cyberboss Telegram Memory

> Private working repository for the Telegram + relationship-memory extensions built around [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek).

## Baseline policy

The upstream Cyberboss repository is the runtime baseline and should remain intact unless a core change is proven necessary.

This repository mainly contains additive work:

- relationship memory workspace and `memory-kit`
- candidate / closeout / canon pipeline
- local Windows launch and diagnosis scripts
- Telegram-specific deployment configuration
- the 520 dashboard and related display tools

## Safety rules

1. Do not perform broad refactors of upstream Cyberboss code.
2. Do not delete or replace working behavior merely to make the architecture look cleaner.
3. Audit first; every core-source modification must be explained file by file.
4. Prefer extensions, adapters, hooks, or small patches over editing `src/core/app.js`.
5. All implementation changes must happen on a branch and be reviewed as a diff before merging.
6. Keep the current working deployment available until a clean deployment passes all smoke tests.
7. Never commit live secrets, sessions, Telegram offsets, conversations, logs, or private memory content.

## Planned branches

- `main`: upstream-first, reviewable source of truth
- `legacy-current`: frozen snapshot of the currently running customized version
- `audit/*`: read-only analysis and documentation
- `fix/*`: one narrowly scoped fix per branch

## Current priority

Preserve the original Cyberboss runtime behavior. Review only the custom Telegram patches and the newly added memory, dashboard, and local-launch layers. No destructive cleanup.