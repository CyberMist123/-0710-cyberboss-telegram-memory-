# Core change boundary

## Authority

Runtime baseline: `AngeliaSama/cyberboss-deepseek`

Local baseline commit captured from the current installation:

- commit: `ecc98cd`
- message: `feat: finalize location v2 event-driven runtime`
- branch at capture time: `local-safe-test`

The upstream runtime is assumed good. Do not redesign or broadly refactor it.

## What the local snapshot actually changed

The working tree appeared to modify more than 150 tracked files, but most differences were CRLF/LF line-ending noise. Ignoring end-of-line whitespace, real logic changes were concentrated in these 16 paths:

1. `package.json`
2. `scripts/start-deepseek-telegram.sh`
3. `scripts/switch_shared_runtime.sh` (deleted locally)
4. `src/adapters/channel/telegram-utils.js`
5. `src/adapters/channel/telegram.js`
6. `src/adapters/runtime/claudecode/index.js`
7. `src/adapters/runtime/claudecode/process-client.js`
8. `src/adapters/runtime/codex/rpc-client.js`
9. `src/core/app.js`
10. `src/core/command-registry.js`
11. `src/core/config.js`
12. `src/core/stream-delivery.js`
13. `src/core/system-message-dispatcher.js`
14. `src/index.js`
15. `src/services/telegram-service.js`
16. `templates/weixin-instructions.md`

## Initial classification

### Likely necessary platform patches

These solve concrete Windows / Telegram deployment problems and should be reviewed conservatively rather than removed blindly:

- Telegram proxy support
- Telegram state refresh, bounded deduplication, and request timeout changes
- Windows `.cmd` launch handling and hidden child windows
- single-instance lock for one state directory
- duplicate Telegram outbound suppression
- Claude CLI warning filtering

### Custom behavior that needs isolation

These may be useful, but should preferably live behind small modules, hooks, or extensions instead of accumulating inside the core runtime:

- automatic compact and `/ctx`
- compact-state and compact-history management
- outage recovery messages
- runtime switching additions
- relationship-memory prompt injection

### Highest-risk file

`src/core/app.js` contains roughly 785 added and 53 removed lines compared with the captured upstream baseline. Do not rewrite it wholesale. First map each added block to one feature, add behavior tests, then move one feature at a time only when the move is proven equivalent.

## Review rule

For every core-source change, record:

1. the user-visible problem it fixes;
2. whether the problem still exists on the upstream baseline;
3. the smallest safe patch;
4. a smoke test;
5. a rollback path.

Unknown code is preserved until its behavior is understood. Cleanup is not a valid reason by itself to delete working code.