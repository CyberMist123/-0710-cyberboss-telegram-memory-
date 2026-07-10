# Repository policy

- The trusted runtime reference is upstream commit `ecc98cd`.
- Keep upstream core behavior unless a narrowly reproduced need proves a patch necessary.
- Relationship memory, dashboard, and Windows launch helpers are additive extensions.
- Do not deploy `legacy-current`; it is a frozen comparison snapshot.
- Never commit live `.env`, tokens, sessions, offsets, conversations, logs, caches, or real relationship-memory content.
- Every core change must be a small branch/PR with a smoke test and rollback.
