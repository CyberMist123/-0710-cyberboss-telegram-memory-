# P0: Telegram Fable chat profile token reduction

Repository: `CyberMist123/-0710-cyberboss-telegram-memory-`

Branch: `fix/p0-fable-chat-profile`

Issue: #15

## Goal

Make Telegram ordinary chat start as a deliberately lightweight Claude Code session instead of inheriting the full engineering harness and `effort=max`.

This is a cost emergency. Keep the patch focused and mergeable.

## First actions

1. Fetch origin and switch to `fix/p0-fable-chat-profile`.
2. Confirm the worktree is clean and the branch is based on current `origin/main`.
3. Read Issue #15 completely.
4. Inspect only the files needed for the Claude runtime launch path, especially:
   - `src/adapters/runtime/claudecode/index.js`
   - `src/adapters/runtime/claudecode/process-client.js`
   - `src/adapters/runtime/claudecode/project-settings.js`
   - `src/core/config.js`
   - related runtime/config tests
5. Confirm supported flags/options from the installed Claude Code `2.1.217` using local `claude --help`; do not guess unsupported flags from old docs.

## Required behavior

Introduce an explicit chat profile boundary.

### `fable-chat`

- effort explicitly `medium` by default; optional `low` through config
- must not inherit a persisted/global `max`
- no project MCP config generation or registration
- no `cmx-test`
- zero normal MCP servers
- inject the contents of `WAKE-CHAT.md` directly as the replacement system prompt, without a startup `Read`
- do not load project `CLAUDE.md`, HANDOVER, hooks, skills, auto-memory, or engineering tool definitions
- a chat session must never reuse a work-session thread/config

### Existing work profile

- preserve current engineering behavior
- keep project MCP and tools available
- default effort should not silently become `max`; high/max only when explicitly selected

## Immediate compatibility constraint

The live runtime already supports `CYBERBOSS_CLAUDE_EXTRA_ARGS=--effort,<level>`. Preserve this interface unless a tested migration is added.

Do not solve this by shortening `WAKE-CHAT.md`; evidence shows the dominant startup prefix is the full Claude Code harness.

## Tests

Add focused regression tests that inspect the generated launch arguments/options.

At minimum assert:

- chat profile includes explicit medium/low effort
- chat profile has no project MCP config
- chat profile uses direct WAKE-CHAT system prompt injection
- chat and work profiles cannot share the same persisted thread identity/config
- work profile preserves existing behavior
- invalid/missing WAKE-CHAT fails safely without taking Telegram offline

Run the narrow tests first, then:

```text
npm run check
npm run test:phase1
git diff --check
```

Run additional affected tests discovered during inspection.

## Acceptance evidence

Provide:

- exact changed files
- exact generated chat launch args/options with secrets removed
- test commands and results
- before/after usage for the same short two-turn chat, deduplicated by request/message id
- confirmation that new chat requests no longer log `effort=max`
- confirmation that MCP/tool counts are zero for `fable-chat`

## Boundaries

- Do not change memory semantics, 520 UI, Apple Watch work, media inbox, or unrelated startup scripts.
- Do not merge directly to `main`.
- Commit and push the branch, then open a PR targeting `main`.
- Stop and report a concrete blocker only if the installed Claude Code version cannot provide a true replacement system prompt or zero-tool mode through its supported CLI/SDK interface.
