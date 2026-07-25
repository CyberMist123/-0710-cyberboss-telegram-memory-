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

## Session authority

The slot store is the **only** runtime authority for a resume id. `sessions.json`
remains a continuity / reverse-index mirror, and is never read as a resume
source, command target, approval target, restore target or process selector.

One exception, tightly scoped: a **one-shot migration** of the private/default
legacy lane. It applies only when no profile is in force *and* the lane is
either a non-Telegram legacy lane or a Telegram lane with no topic whose chat id
equals the binding's own sender id. A topic lane, a group lane and any profiled
lane are never eligible — which is what stops two unmapped topics inheriting one
transcript. The migration reads a snapshot of `sessions.json` taken at adapter
construction, before any lane can mirror a new id into it, and writes a
permanent marker keyed by (binding, workspace) so it cannot run twice, not even
after the slot is cleared.

`resumeThread` refuses a session id that is not the slot's own rather than
adopting it. Startup restore iterates session slots, rebuilding each lane from
its own persisted route descriptor; a descriptor that cannot be rebuilt is
skipped, never restored as a bare legacy process.

## Runtime events are self-describing

Every runtime event carries `bindingKey`, `workspaceRoot`, `laneKey`,
`sessionSlotKey`, `processKey`, `sessionId` and `messageThreadId`. Turn-boundary,
approval, telemetry and recorder handlers read identity off the event instead of
inferring it from a binding. Stream delivery no longer falls back to the binding
reverse lookup at all: a run it cannot locate resolves to `null` rather than to
whichever topic replied most recently.

## Commands and approvals

`/status`, `/new`, `/reread`, `/compact`, `/switch`, `/stop`, approval
allow/deny and the conversation recorder all resolve the current route through
`resolveRouteSession` — current lane → profile fingerprint → slot → session.
Topic A cannot query, cancel, compact or approve topic B.

shared-open IPC must name a process by `processKey`, `sessionId` or `laneKey`.
A workspace address is accepted only when exactly one live process matches;
otherwise it is refused. Approvals answer through their registry owner.

## Tool runtime context

The workspace-singleton active context was a cross-topic hazard: whichever turn
wrote last owned every outbound tool send. Each Claude child is now launched
against a per-slot MCP config whose `cyberboss_tools` entry carries
`--route-token` (and `CYBERBOSS_ROUTE_TOKEN`), and the runtime context store is
keyed by that token.

A token resolves exactly its own lane and never falls through. Without a token,
the store reports how many lanes are mid-turn in the workspace; if more than
one, an outbound tool send is **refused** rather than delivered to a guess.

## Process state machine

* The per-key lock chain drops its map entry once the last waiter drains.
* A failed `connect()` removes the registry row, closes any child that did
  start, and clears pending approvals and the in-flight turn before the error
  propagates.
* **Full-turn single-flight.** The attach lock only covers attach; a turn spans
  the write *and* the streamed result. `beginTurn` holds the process key from
  the write until the turn settles (result, cancel or failure), so a second turn
  cannot overwrite `pendingTurnId` / `activeThreadId`. A turn that never settles
  is force-settled after a timeout and logged.
* **An indeterminate write is never replayed.** If the child is known-unusable
  *before* the write, nothing was sent and a relaunch is provably safe. Once the
  write has been attempted, delivery cannot be proven, so the turn surfaces as
  `IndeterminateTurnWriteError` rather than being re-sent into a possible
  duplicate execution.

## Workspace read/write lock

Lanes keep independent sessions and processes; only concurrent access to one
filesystem workspace is serialized.

```text
workspaceAccess: "read" | "write"     (profile field, default write)

read  + read   -> concurrent
write + read   -> mutually exclusive
write + write  -> mutually exclusive
```

The lock is held for the whole turn and released on result, cancel or failure.
Waiters are first-in-first-out, so a stream of readers cannot starve a writer.
Keys are realpath-canonicalized (and case-folded on Windows/macOS), so a
drive-letter path, the same path written through .., and a symlink to that
directory are one workspace. `workspaceAccess` schedules turns; it is never
passed to the CLI. System and background turns declare their access mode
explicitly.

## Claude CLI compatibility

Verified against Claude Code **2.1.220**, whose help declares `--effort
low|medium|high|xhigh|max`, `--settings`, `--mcp-config`,
`--strict-mcp-config`, `--tools`, `--agents` and `--system-prompt`.

`--config-dir` and `--output-style` are **not** declared by that help output, so
a profile using `configDir` or `outputStyle` fails validation before launch. A
deployment whose CLI does support them declares it:

```text
CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON=["--output-style"]
```

Only those two flags are declarable; an arbitrary flag cannot be whitelisted
into the launch this way. A final guard re-checks every emitted flag immediately
before spawn, so nothing unverified can reach the child.

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
npm run test:route-lanes        # the focused suites for this branch
npm run test:tg-profile-lanes   # the above plus the Telegram media suite
```

## Portability

No launch path resolves against the process working directory. A profile base
directory must be supplied explicitly; a relative profile path with no
configured base fails with `missing_base_dir` instead of silently resolving
against wherever the bridge happened to be started. A test enforces that the
source tree has no such call sites.
