# Memory Loop Worklog

This file is the single running ledger for incremental memory-loop changes.

## Branch policy

- Stable branch: `main`
- Active implementation branch: `impl/codex-cheap-prework-20260711-170034`
- Long-lived design branch: `design/living-memory-rfc`
- Temporary implementation branches must be merged or archived after acceptance.
- Historical rollback points should use annotated tags rather than permanent parallel branches.

## Current topology

- GitHub default branch: `main`
- `main` baseline: `d8bc0b5c603bdc6050df5967e3140a0c85bbd24d`
- Active implementation baseline: `bac410f74bebd0f04c37d15cdeb37188089b9261`
- Relationship: active implementation is 82 commits ahead of `main` and 1 commit behind it.
- The `main`-only commit adds `.github/workflows/secret-audit.yml` and must be preserved before the implementation line is promoted.

## Safety rules

1. One behavior change per commit whenever practical.
2. No real-model calls during code-loop tests.
3. No processing of the 119 real candidates during fixture tests.
4. No direct writes to live `memory/` during GitHub-side development.
5. Every entry records: parent SHA, new SHA, changed files, tests, deployment status, and rollback command.
6. Runtime deployment and GitHub commits are separate steps.
7. `main` is updated only after local sync, offline tests, and explicit acceptance.

## Rollback pattern

Before local sync, record the accepted SHA.

```powershell
git -C "C:\Users\18717\Documents\cyberlink\cyberboss-codex-cheap-prework-20260711-170034" reset --hard <accepted-sha>
```

For a change already pushed and shared, prefer:

```powershell
git revert <bad-commit-sha>
```

Do not force-push `main`.

## Change ledger

### V0 — Baseline

- Date: 2026-07-12
- Branch: `impl/codex-cheap-prework-20260711-170034`
- SHA: `bac410f74bebd0f04c37d15cdeb37188089b9261`
- State:
  - stale writer lease recovery implemented and pushed;
  - Review still accumulates all decisions in memory and writes only after the full loop;
  - nightly still invokes `run-phase3.js all`;
  - real Review/History publication must remain disabled operationally until mode gating and semantic policy are settled.
- Deployment: writer-lease fix deployed locally; Telegram restart status is tracked separately.
- Rollback point: `bac410f74bebd0f04c37d15cdeb37188089b9261`

## Planned increments

### V1 — Review checkpoint only

Scope:
- write each completed decision immediately using existing idempotent storage;
- preserve completed decisions across interruption;
- skip already-decided candidates on rerun;
- fixture tests only;
- do not change prompts, nightly mode, or real memory.

### V2 — Nightly mode gate

Scope:
- introduce `manual | shadow | auto`;
- default to `manual`;
- prevent real Review and History Writer publication unless explicitly enabled;
- fixture and command-construction tests only.

### V3 — Semantic review contract

Scope:
- separate mechanical validation from relationship/identity judgment;
- relationship-sensitive candidates defer to the subject AI in TG context;
- version prompt and schema;
- no bulk run until explicitly approved.

### V4 — Promotion to `main`

Prerequisites:
- preserve the `main`-only secret-audit workflow;
- local formal repository is clean or its local-only changes are committed separately;
- all accepted tests pass;
- deployment SHA and Git SHA match;
- create an annotated pre-promotion tag.
