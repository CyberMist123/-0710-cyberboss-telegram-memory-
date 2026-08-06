# Repository policy

```text
Status: active
Authority: stable architecture
Scope: 仓库策略
Current status: docs/CURRENT_STATUS.md
```


- The trusted runtime reference is upstream commit `ecc98cd`.
- Keep upstream core behavior unless a narrowly reproduced need proves a patch necessary.
- Relationship memory, dashboard, and Windows launch helpers are additive extensions.
- Do not deploy `legacy-current`; it is a frozen comparison snapshot.
- Never commit live `.env`, tokens, sessions, offsets, conversations, logs, caches, or real relationship-memory content.
- Every core change ships in a bounded delivery batch with a smoke test and a rollback path; the batch, not the individual change, is the unit that gets verified on the real machine and pushed to `main` (see `DECISIONS.md` D36). A PR is only required when the change needs isolated review.
