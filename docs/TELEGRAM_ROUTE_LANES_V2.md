# Telegram / Claude route lanes v2

This branch replaces the C1 profile-selector prototype. It is not a patch on
top of it: the selector is rebuilt fail-closed, and the routing seam it plugged
into is rebuilt around three identities that were previously conflated.

## The three identities

| Identity | Made of | Governs |
| --- | --- | --- |
| **Continuity binding** | `workspaceId + accountId + senderId` | Long-term user memory identity. Stable across chats, topics and profiles. |
| **Route lane** | `accountId + chatId + nullable messageThreadId` | Turn gate, pending buffer, debounce, merge, reply target, typing, outbound `message_thread_id`. |
| **Session slot** | `workspace + route lane + effective profile fingerprint` | The Claude native transcript (`--resume`). |
| **Process identity** | `session slot + effective launch fingerprint + cwd/config identity` | Which child process a turn, approval or result belongs to. |

`profile`, `chatId` and `messageThreadId` deliberately do **not** enter the
continuity binding. Long-term continuity is shared through memory/reentry
injection, never by pointing two lanes at one Claude transcript.

Implemented in `src/core/route-lane.js`,
`src/adapters/runtime/claudecode/session-slot.js` and
`src/adapters/runtime/claudecode/process-registry.js`.

## What changed against `main`

Before, a Telegram turn was scoped by `bindingKey::workspaceRoot` everywhere:

* one turn gate per user, so two topics serialized against each other;
* one pending-inbound buffer per user, so messages from two topics **merged
  into a single prepared turn**;
* one image debounce draft per user, so an image burst in one topic could be
  batched with a burst in another;
* one reply target per binding, so a reply could be delivered to the wrong
  topic;
* one Claude session id per `(binding, workspaceRoot)`, so a second lane
  overwrote the first lane's session id and could be launched with
  `--resume <other lane's session>`;
* one process per `workspaceRoot`, closed and reopened whenever the desired
  model changed — which meant one lane could kill another lane's running child.

The Telegram adapter also never read or wrote `message_thread_id` at all.

## Route lane

`buildTelegramRouteLane({ accountId, chatId, messageThreadId })` produces a
frozen lane with a length-prefixed `laneKey`, so ids containing `|` or `::`
cannot collide across lanes.

Canonical Telegram id rules (`canonicalTelegramChatId`,
`canonicalTelegramMessageThreadId`):

* a finite safe integer, or a strict decimal integer string;
* `chatId` may be negative (supergroups) but not `-0`;
* `messageThreadId` is either `null` (the explicit default lane) or a strictly
  positive integer;
* rejected: floats, exponent form, `+1`, `01`, whitespace padding, arbitrary
  text, bigints, values beyond `Number.MAX_SAFE_INTEGER`;
* **an empty string is not an alias for the default lane.** A missing key means
  "the platform sent no topic"; `""` is a malformed value and is rejected.

An inbound Telegram message whose topic id is present but non-canonical is
dropped by the channel adapter rather than routed on a guess.

Only private chats are accepted today. The nullable-thread semantics are
carried end-to-end anyway so that a future forum/supergroup lane cannot
silently reuse the default lane's gate, buffers, reply target or session. **This
branch does not claim supergroup forum support.**

## Outbound

Every Telegram send verb — `sendText`, `sendTyping`, `sendVoice`, `sendFile`
(document), `sendPhoto` — routes through one payload builder
(`applyThreadId` / `appendThreadIdToForm`) and carries `message_thread_id` when
the lane has a topic. Errors and status messages use `sendText`, so they inherit
the same behaviour. The field is **omitted entirely** for the default lane, so a
non-Telegram payload keeps exactly the shape it had before v2.

Model-initiated sends (`src/services/telegram-service.js`) read the active
turn's topic back out of the runtime context store, so a tool-driven reply lands
in the topic that asked.

## Session slots

A slot key is `sha256(runtimeId, workspaceRoot, laneKey, profileFingerprint)`.
The slot store (`claude-session-slots.json`) maps slot key → session id and
context fingerprint. It stores no chat id, topic id or filesystem path in
plaintext.

* A resume id is read **only** from the current slot. Another lane's session id
  is not reachable from the code path that builds `--resume`.
* The pre-v2 `sessions.json` is still written (mirrored) so `threadId → binding`
  lookups elsewhere keep resolving, but it is never read as a resume source —
  with one deliberate exception: a **profile-free** lane with no slot record yet
  seeds itself from it once, so an upgrade keeps resuming the session it already
  had. A profiled lane never inherits that session.

## Process registry and mutual exclusion

Every start, stop and resume for one process key runs inside that key's lock, so
a burst of inbound turns in one lane cannot fork two children, and no other
lane's key is touched. Locks for different keys are independent.

A hot profile-mapping change produces a *new* process key rather than mutating
the existing one; the stale process is retired only when it is idle, so a lane
that is mid-turn keeps its child until that turn finishes. Capacity eviction
never selects a process that is mid-turn.

Approvals are recorded against the process that raised them and answered
through that process only — not "whichever client happens to be alive".

`cancelTurn` resolves to exactly one process (by session id, or by explicit
lane). Without either it closes nothing; the pre-v2 behaviour of closing every
client for a workspace root is what let one topic stop another topic's run.

## Fail-closed configuration

```text
CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON={"safe":{"effort":"low","mcpConfigMode":"clear"}}
CYBERBOSS_TELEGRAM_PROFILE_MAPPING_JSON=[{"accountId":"telegram","chatId":"123","messageThreadId":null,"profileId":"safe"}]
```

This is a schema example only; the repository enables no real mapping.

Both values are parsed by `src/core/bounded-json.js` under hard bounds: raw byte
size, nesting depth, string length, array length, object key count and total
node count. `__proto__`, `prototype` and `constructor` are rejected during
parsing, before the value can become an own property of anything.

The router (`telegram-profile-router.js`) then **throws on any defect**, which
blocks startup:

* malformed JSON or the wrong top-level shape;
* unknown fields in a profile or a mapping entry;
* a route naming a profile that does not exist or does not validate;
* two mapping entries for the same `(accountId, chatId, messageThreadId)`;
* two profile ids that collide after trimming or case folding;
* a non-canonical Telegram id;
* a mapping entry that omits `messageThreadId` (it must be written out
  explicitly, `null` for the default lane).

There is **no fallback to a legacy, more permissive profile**. An operator who
names a restrictive profile must never silently get an unrestricted one.

With both variables unset — or with an empty mapping array — the router reports
every lane as `unmapped` and dispatch keeps its pre-v2 behaviour exactly.

## Launch profile hardening

Accepted fields: `profileId`, `model`, `effort`, `cwd`, `env`, `configDir`,
`settings`, `builtInTools`, `agents`, `mcpConfigPaths`, `mcpConfigMode`,
`strictMcpConfig`, `systemPrompt`, `outputStyle`.

* `effort` is the enum `low | medium | high | max`.
* Every string field is length-bounded; `agents` is bounded in count, per-field
  length and serialized size.
* `agents` is built on a null-prototype object and each entry is fully
  validated, so an operator-chosen name can never reach `Object.prototype`.
* `cwd`, `configDir`, `settings` and `mcpConfigPaths` must exist, be of the
  right type and be readable. The link is followed once at validation time and
  the child is launched against the **realpath**, so a symlink (or Windows
  junction/reparse point) swapped afterwards cannot redirect the launch. A
  relative path may not escape the base directory, and neither may its resolved
  target.
* `env` uses a minimal non-secret allowlist that contains **no authentication
  switch**. `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` require
  `CYBERBOSS_CLAUDE_ALLOW_AUTH_BACKEND_OVERRIDE`, and AWS/GCP credential
  variables are stripped from a profiled child's environment unless
  `CYBERBOSS_CLAUDE_ALLOW_CLOUD_CREDENTIAL_INHERITANCE` is set. Both are
  deployment decisions a profile cannot make for itself. Both parse strictly:
  only `1/0/true/false`, never an arbitrary non-empty string.
* `mcpConfigMode` is `inherit | replace | clear`. `clear` removes every
  inherited server and implies `--strict-mcp-config`, so a safe profile can
  genuinely drop the shared `.mcp.json` instead of always inheriting it.
* `systemPrompt` and `outputStyle` together fail closed.
* A profile cannot be combined with raw `extraArgs`.
* The profile's **logical identity** (`profileId`) is separate from its
  **launch fingerprint** (a hash of the resolved argv, cwd, env overlay and MCP
  mode). Two different efforts under one name produce one logical identity and
  two launch fingerprints.

## Telemetry

`src/core/route-telemetry.js` emits pure counts, route *shapes*, and correlation
tokens produced by an HMAC keyed with a **per-process random secret**. Never an
`accountId`, `chatId`, topic id, raw `profileId`, model-facing prompt, cwd,
config path or environment value. An unsalted hash is explicitly rejected: a
numeric chat id is trivially brute-forced against a fixed digest. Field names
are allowlisted, so a future edit that adds a leaky field fails in tests rather
than shipping.

## System and background isolation

`closeout`, `liveness`, the system-message queue, the background author and the
automation sender each get an explicit system lane
(`buildSystemRouteLane(...)`). They never inherit a Telegram lane's profile or
session:

* `runBackgroundTurn` launches with no profile, creates no session slot and no
  registry entry, so it leaves nothing another lane could resume.
* A system-message turn gets its own lane and slot, while still serializing on
  the workspace-level gate (`anyLane: true`), because those jobs share one
  working directory with whatever lane is running.

## Deliberately out of scope

This branch implements no persona placement of any kind: no Fable persona, no
system-prompt persona, no output-style persona, no opening-turn persona switch,
no Route 1 / Route 2. Instruction placement belongs in a later change, after the
profile/session/lane isolation here has been reviewed independently.

## Tests

```text
npm run test:route-lanes        # the nine focused suites for this branch
npm run test:tg-profile-lanes   # the above plus the Telegram media suite
```
