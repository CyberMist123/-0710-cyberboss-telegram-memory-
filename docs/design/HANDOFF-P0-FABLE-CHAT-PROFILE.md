> **Status: active（未开始）** — 设计交接文档，代码侧零实现。
> `fable-chat` profile 的当前状态见 [`docs/CURRENT_STATUS.md`](../CURRENT_STATUS.md)。

# P0: Fable review for TG Chat routing and context reduction

Repository: `CyberMist123/-0710-cyberboss-telegram-memory-`  
Branch: `fix/p0-fable-chat-profile`  
Issue: #15

## Current stage

**Fable performs architecture review only. Do not implement production code.**

The complete user intent, discussion, candidate architecture, token boundaries, resources, uncertainties and phased path are recorded in:

```text
DESIGN-TG-CHAT-ROUTING-CONTEXT-BUDGET.md
```

Treat that document as the current product-direction source. It supersedes the earlier ideas of:

- zero-tool/zero-MCP ordinary chat;
- adding a Telegram `/effort` command;
- immediately creating several visible Telegram bots;
- solving the problem only by shortening `WAKE-CHAT.md`.

## What Fable should do

1. Read:

```text
DESIGN-TG-CHAT-ROUTING-CONTEXT-BUDGET.md
GitHub Issue #15
```

2. Inspect only the repository and runtime seams needed to judge feasibility, including the current TG command/session path, Claude Code runtime adapter, Codex runtime adapter, SessionStore, memory/re-entry injection, MCP config generation, usage logging, watchdog/startup boundaries and relevant tests.

3. Verify the installed binaries rather than relying on old documentation:

```text
claude --version
claude --help
codex --version
codex --help
```

Also inspect the real Claude stream-json/init events, current deferred tools/Tool Search behaviour, Output Style support, session fork/background capabilities and the source of the current startup prefix.

4. Review the external references listed in the design document only as narrow architecture references. Do not replace cyberboss wholesale.

5. Produce:

```text
REVIEW-TG-CHAT-ROUTING-CONTEXT-BUDGET.md
```

The review must state:

- which ideas are feasible now;
- which assumptions are wrong, unsafe or version-dependent;
- measured sources of the current token prefix;
- the smallest safe Chat profile;
- how full-memory access can remain available without full-memory injection;
- how Tool Search and selective MCP loading should work;
- the best hidden-branch/session mechanism for Route 1;
- the exact lightweight memory package boundary;
- how result capsules return to Chat without importing worker context;
- the Route 2 A/B token gate and model-selection constraints;
- whether Output Style is enough for the first experiment;
- whether/when an isolated tweakcc/lobotomized Chat installation is justified;
- exact repository files and interfaces for later implementation;
- a phased test matrix and rollback plan;
- a short 2–4 PR implementation split for Codex.

## Boundaries

- Do not modify production/runtime code.
- Do not edit the live TG deployment.
- Do not create a PR.
- Do not implement `/effort`.
- Do not touch CMX, 520 UI, Apple Watch, media inbox or unrelated memory semantics.
- Do not apply tweakcc or lobotomized prompts to the current Claude Code installation.
- Commit and push only the review document to this branch.

The goal is to challenge and tighten the design before Codex receives any implementation `/goal`.
