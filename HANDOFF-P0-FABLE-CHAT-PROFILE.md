# P0: Telegram lightweight chat profile + `/effort` control

Repository: `CyberMist123/-0710-cyberboss-telegram-memory-`

Branch: `fix/p0-fable-chat-profile`

Issue: #15

## Operating model

This task has two mandatory stages:

1. **Fable performs architecture review only.** Do not modify runtime code during review.
2. **Codex performs implementation** after reading this handoff and Fable's review artifact.

The user currently has GPT weekly capacity available and wants Codex to execute the heavy implementation. Fable should spend only enough work to inspect and challenge the plan.

## Stage A — Fable review

Read Issue #15 and inspect the current launch/session path, especially:

- `src/adapters/runtime/claudecode/index.js`
- `src/adapters/runtime/claudecode/process-client.js`
- `src/adapters/runtime/claudecode/project-settings.js`
- `src/adapters/runtime/codex/session-store.js`
- `src/core/config.js`
- Telegram command routing and related tests

Also inspect the installed runtime locally:

```text
claude --version
claude --help
codex --version
codex --help
```

Do not assume old documentation matches the installed binaries.

Review these questions:

1. What is the smallest safe boundary for a lightweight ordinary-chat profile?
2. Can the current installed Claude/agent runtime truly replace the system prompt and start with zero engineering tools/MCP?
3. Which context sources remain unavoidable in the chosen runtime?
4. Is a direct Agent SDK or Responses API path materially cheaper than keeping the full Claude Code CLI harness?
5. How should chat/work/CMX profiles be separated so sessions and effort cannot contaminate each other?
6. How should `/effort` work across Claude/Fable and GPT/Codex-backed runtimes?
7. Which proposed changes risk breaking continuity, media intake, approval handling, model switching, or watchdog recovery?
8. Which external implementation patterns are worth borrowing?

Write the result to:

```text
REVIEW-P0-FABLE-CHAT-PROFILE.md
```

The review must contain:

- approved approach
- rejected/unsafe assumptions
- exact recommended files and seams
- installed-runtime capability findings
- `/effort` state and lifecycle design
- test matrix
- external reference projects and what to borrow
- concrete instructions for Codex

Commit and push the review artifact to this branch. Do not open a PR yet and do not implement production code.

## Stage B — Codex implementation

Codex must read both:

```text
HANDOFF-P0-FABLE-CHAT-PROFILE.md
REVIEW-P0-FABLE-CHAT-PROFILE.md
```

Resolve any difference in favour of verified installed-runtime behaviour and repository tests. Keep the patch focused and mergeable.

## Goal 1 — lightweight ordinary-chat profile

Make Telegram ordinary chat start as a deliberately lightweight session instead of inheriting the complete engineering harness and an expensive effort level.

### `fable-chat`

- effort explicitly `medium` by default; optional lower setting through `/effort`
- must not inherit a persisted/global `max`
- no project MCP config generation or registration
- no `cmx-test`
- zero normal MCP servers
- inject `WAKE-CHAT.md` directly through the narrowest verified system-instruction surface
- no startup `Read` call for `WAKE-CHAT.md`
- do not load project `CLAUDE.md`, HANDOVER, hooks, skills, auto-memory, or engineering tool definitions when the installed runtime allows them to be excluded
- a chat session must never reuse a work-session thread/config

### Existing work profile

- preserve current engineering behaviour
- keep project MCP and tools available
- high/max only when explicitly selected
- never inherit the ordinary-chat thread

### Optional CMX profile

- separate session identity from ordinary chat and work
- only register the intended production CMX server
- never register `cmx-test` in a normal user-facing profile

## Goal 2 — Telegram `/effort` command

Add a Telegram command that controls the effective reasoning effort for the currently selected runtime/profile.

### User interface

```text
/effort
```

Show:

- effective effort
- stored effort
- profile default
- runtime/model
- allowed values for that runtime/model
- whether the next message will reuse or recreate a thread

```text
/effort low
/effort medium
/effort high
/effort xhigh
/effort max
/effort none
/effort reset
```

Only expose values supported by the active runtime/model. Unsupported values must return the valid choices and must not mutate state.

### Required semantics

- command handling itself must not call a model
- persist effort per `bindingKey + workspaceRoot + runtime/profile`, not globally
- extend `SessionStore` runtime params in a backward-compatible way
- changing effort must close the current runtime client and clear the active thread before the next model turn
- do not resume a thread created with a different effort/profile
- `/effort reset` restores the profile default and also recreates the thread when the effective value changes
- changing ordinary-chat effort must not change work or CMX effort
- restarting Telegram must preserve the selected effort
- the launch/request log must include requested and effective effort without logging message text or hidden reasoning

### Runtime mapping

Use verified installed-runtime interfaces:

- GPT/Responses-style runtimes: map to `reasoning.effort`
- Claude/Fable/Claude Code runtime: use the installed CLI/SDK field or flag confirmed by local help/runtime traces
- do not emulate effort by prompt text
- do not rely only on process-global `CYBERBOSS_CLAUDE_EXTRA_ARGS`

If a runtime cannot change effort safely per session, report that runtime as fixed/default rather than silently pretending the command worked.

## Immediate compatibility constraint

The live runtime may currently accept `CYBERBOSS_CLAUDE_EXTRA_ARGS=--effort,<level>`. Preserve existing deployments while migrating ordinary chat to explicit per-profile/per-session configuration.

Do not solve the cost problem by shortening `WAKE-CHAT.md`; evidence indicates the dominant startup prefix is the full agent/Claude Code harness.

## External projects to inspect before implementation

### `OctavianTocan/claude-agent-sdk-telegram-bot` (`tap`)

Useful patterns:

- single-owner Telegram gate
- subprocess `stream-json` boundary
- persistent session ID and `/reset`
- extra runtime argument plumbing
- deterministic `fake_claude` integration tests that exercise spawn/pipe/parse without API quota

MIT licensed; preserve attribution/license when copying substantial code.

### `yanhs/claude-code-telegram`

Useful patterns:

- SDK-primary / CLI-fallback separation
- `/new` and per-project session persistence
- usage/cost tracking
- tool allowlist/disallowlist controls
- explicit command routing

Verify the repository's current license before copying code; concepts may be reused regardless.

### `cloveric/cc-telegram-bridge`

Useful patterns to inspect:

- Claude/Codex engine switching
- isolated per-instance state
- usage and budget commands
- service lifecycle and health checks

Use as an architecture reference unless license and current source are verified.

Do not replace this repository wholesale with any external bot. Borrow only narrow, tested patterns.

## Tests

Add focused regression tests at the smallest seams.

At minimum assert:

- chat profile includes explicit default effort
- chat profile has no project MCP config
- chat profile uses direct WAKE-CHAT instruction injection
- chat and work profiles cannot share a persisted thread identity/config
- work profile preserves existing behaviour
- missing/invalid WAKE-CHAT fails open without taking Telegram offline
- `/effort` reads current state without model invocation
- valid `/effort` persists per runtime/profile
- effort change closes client and clears thread
- invalid effort does not mutate state
- restart reloads persisted effort
- older `sessions.json` files without `effort` migrate safely
- generated GPT request uses `reasoning.effort`
- generated Claude/Fable launch options use the verified native effort surface
- usage logs deduplicate repeated events by request/message ID

Prefer a fake process/runtime boundary inspired by `tap`, so launch-argument and session-reset tests consume no model quota.

Run narrow tests first, then:

```text
npm run check
npm run test:phase1
git diff --check
```

Run additional affected tests discovered during inspection.

## Acceptance evidence

Provide:

- Fable review commit
- exact changed files
- exact generated launch/request options with secrets removed
- test commands and results
- before/after usage for the same short two-turn chat, deduplicated by request/message ID
- confirmation that new ordinary-chat requests do not inherit `max`
- confirmation of MCP/tool counts for each profile
- `/effort` smoke results for query, valid change, invalid change, reset, restart persistence, and profile isolation

## Boundaries

- Do not change memory semantics, 520 UI, Apple Watch work, media inbox, or unrelated startup scripts.
- Do not directly edit the live deployment before tests pass.
- Do not merge directly to `main`.
- Commit and push the implementation branch, then open a PR targeting `main`.
- Stop and report a concrete blocker only when a verified runtime limitation prevents a required behaviour; otherwise make the best safe implementation without waiting for confirmation.
