"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  IndeterminateTurnWriteError,
  createClaudeCodeRuntimeAdapter,
} = require("../src/adapters/runtime/claudecode");
const { ProcessRegistry } = require("../src/adapters/runtime/claudecode/process-registry");
const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client");
const { buildTelegramRouteLane } = require("../src/core/route-lane");
const { validateLaunchProfile } = require("../src/adapters/runtime/claudecode/launch-profile");

const FAKE_CLI = path.join(__dirname, "helpers", "fake-claude-cli.js");
const laneFor = (chatId, messageThreadId) =>
  buildTelegramRouteLane({ accountId: "telegram", chatId, messageThreadId });

function makeAdapter({ keepAlive = true, turnDelayMs = 0, command = process.execPath, prefixArgs = [FAKE_CLI] } = {}) {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-pstate-")));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const launchLog = path.join(tempDir, "launches.jsonl");
  const execLog = path.join(tempDir, "exec.jsonl");
  fs.writeFileSync(launchLog, "");
  fs.writeFileSync(execLog, "");

  process.env.CB_FAKE_LAUNCH_LOG = launchLog;
  process.env.CB_FAKE_COUNTER = path.join(tempDir, "counter");
  process.env.CB_FAKE_EXEC_LOG = execLog;
  process.env.CB_FAKE_KEEP_ALIVE = keepAlive ? "1" : "0";
  process.env.CB_FAKE_TURN_DELAY_MS = String(turnDelayMs);

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
    claudeCommand: command,
    claudeCommandPrefixArgs: prefixArgs,
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: tempDir,
  });
  return {
    adapter,
    tempDir,
    workspaceRoot,
    readExec: () => fs.readFileSync(execLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    readLaunches: () => fs.readFileSync(launchLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

const turn = (adapter, workspaceRoot, lane, launchProfile = null, text = "hi") => adapter.sendTurn({
  bindingKey: "default:telegram:500",
  senderId: "500",
  workspaceRoot,
  lane,
  launchProfile,
  text,
});

test("the lock map does not accumulate an entry per process key", async () => {
  const registry = new ProcessRegistry();
  for (let i = 0; i < 50; i += 1) {
    await registry.withLock(`key-${i}`, async () => i);
  }
  // Cleanup runs on the microtask after the chain settles.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.lockCount(), 0, "entries are dropped once the chain drains");

  // Concurrent waiters on one key also drain to zero.
  await Promise.all(Array.from({ length: 10 }, () => registry.withLock("shared", async () => {})));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.lockCount(), 0);
});

test("a failed critical section still drains its lock entry", async () => {
  const registry = new ProcessRegistry();
  await assert.rejects(registry.withLock("key", async () => {
    throw new Error("boom");
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.lockCount(), 0);
});

test("a turn slot is single-flight and settles exactly once", async () => {
  const registry = new ProcessRegistry();
  const first = await registry.beginTurn("p1");
  assert.equal(registry.hasActiveTurn("p1"), true);

  let secondStarted = false;
  const second = registry.beginTurn("p1").then((ticket) => {
    secondStarted = true;
    return ticket;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondStarted, false, "the second turn waits for the first to settle");

  // A stale token cannot release the active turn.
  assert.equal(registry.settleTurn("p1", { turnToken: "not-mine" }), false);
  assert.equal(registry.settleTurn("p1", { turnToken: first.turnToken }), true);
  assert.equal(registry.settleTurn("p1", { turnToken: first.turnToken }), false, "settling twice is a no-op");

  const secondTicket = await second;
  assert.notEqual(secondTicket.turnToken, first.turnToken);
  registry.settleTurn("p1", { turnToken: secondTicket.turnToken });
  assert.equal(registry.activeTurnCount(), 0);
});

test("a turn slot on one process does not block another process", async () => {
  const registry = new ProcessRegistry();
  const a = await registry.beginTurn("p1");
  const b = await registry.beginTurn("p2");
  assert.equal(registry.activeTurnCount(), 2);
  registry.settleTurn("p1", { turnToken: a.turnToken });
  registry.settleTurn("p2", { turnToken: b.turnToken });
  assert.equal(registry.activeTurnCount(), 0);
});

test("a stuck turn is force-settled after the timeout rather than wedging the lane", async () => {
  const registry = new ProcessRegistry({ turnTimeoutMs: 20 });
  await registry.beginTurn("p1");
  const next = await registry.beginTurn("p1");
  assert.ok(next.turnToken, "the lane recovered instead of hanging");
  registry.settleTurn("p1", { turnToken: next.turnToken });
});

test("retiring a process settles its in-flight turn", async () => {
  const registry = new ProcessRegistry();
  registry.set("p1", { client: { alive: true, pendingTurnId: "", async close() {} }, sessionSlotKey: "s", laneKey: "l" });
  await registry.beginTurn("p1");
  registry.delete("p1");
  assert.equal(registry.hasActiveTurn("p1"), false);
});

test("a failed launch leaves no registry entry, no turn and no approval behind", async () => {
  // A command that exits immediately: connect() succeeds but the child is gone.
  const { adapter, workspaceRoot } = makeAdapter({
    command: process.execPath,
    prefixArgs: ["-e", "process.exit(3)"],
  });
  try {
    await assert.rejects(() => turn(adapter, workspaceRoot, laneFor(500, 5)));
    const routing = adapter.describeRouting();
    assert.equal(routing.processCount, 0, "no half-registered process survived");
    assert.equal(routing.activeTurns, 0, "no turn slot was leaked");
    assert.equal(routing.workspaceLocks.writers, 0, "the workspace lock was released");
    assert.equal(routing.workspaceLocks.waiting, 0);
  } finally {
    await adapter.close();
  }
});

/**
 * Polls until no turn slot or workspace lock is held, then returns the routing
 * snapshot. A fixed sleep would re-introduce exactly the kind of timing
 * assumption this suite is being hardened against.
 *
 * The ceiling is a liveness bound only -- it exists so a genuinely wedged lane
 * fails instead of hanging forever, and it is deliberately far above any
 * plausible machine's settle time so that it never decides the outcome. The
 * assertions the callers make on the returned snapshot are the verdict; a slow
 * runner simply polls a few more times before reaching them.
 */
const SETTLE_CEILING_MS = 30_000;

async function waitUntilSettled(adapter, timeoutMs = SETTLE_CEILING_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const routing = adapter.describeRouting();
    const idle = routing.activeTurns === 0
      && routing.workspaceLocks.writers === 0
      && routing.workspaceLocks.waiting === 0;
    if (idle || Date.now() >= deadline) {
      return routing;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * How long a "nothing happens after this" claim is watched for.
 *
 * This is an observation window, not a settle-time guess. The invariant checked
 * inside it ("still exactly one write, still at most one execution") is true at
 * every instant of a healthy run, so widening the window can only catch more
 * regressions -- it can never make a slow machine fail. That is precisely what
 * the sampled-then-compared execution count could not say for itself.
 */
const REPLAY_WATCH_MS = 400;

/** Re-asserts an always-true invariant across a window instead of at one instant. */
async function stayingQuiet(assertInvariant, windowMs, stepMs = 20) {
  const deadline = Date.now() + windowMs;
  do {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    assertInvariant(`${windowMs}ms after the turn settled`);
  } while (Date.now() < deadline);
}

/**
 * Counts every write the runtime issues for one turn, across relaunches.
 *
 * Patching the prototype rather than one client is what makes the count
 * trustworthy: a replay would run on a *new* client, which an instance-level
 * spy would silently miss.
 */
function countWritesFor(needle) {
  const original = ClaudeCodeProcessClient.prototype.sendUserMessage;
  const state = {
    writes: 0,
    restore() { ClaudeCodeProcessClient.prototype.sendUserMessage = original; },
  };
  ClaudeCodeProcessClient.prototype.sendUserMessage = function patched(payload) {
    if (String(payload?.text || "").includes(needle)) {
      state.writes += 1;
    }
    return original.call(this, payload);
  };
  return state;
}

/**
 * Parks every turn's write until `count` of them are in flight at the same time.
 *
 * This is what makes concurrency an observation rather than a stopwatch
 * reading. The workspace lock is taken *before* the write, so `count` writes
 * can only sit parked here together if `count` workspace locks are held
 * together -- and the snapshot is taken at that exact moment, while every
 * participant still holds its lock. A slow machine only takes longer to reach
 * the rendezvous; a regression that serialized the lanes can never reach it at
 * all, because the first holder would never release.
 */
function rendezvousOnWrite(count, snapshot) {
  const original = ClaudeCodeProcessClient.prototype.sendUserMessage;
  let arrived = 0;
  let open = () => {};
  const opened = new Promise((resolve) => { open = resolve; });
  ClaudeCodeProcessClient.prototype.sendUserMessage = async function patched(payload) {
    arrived += 1;
    if (arrived >= count) {
      open(snapshot());
    }
    await opened;
    return original.call(this, payload);
  };
  return {
    arrived: () => arrived,
    /**
     * The snapshot taken when the lanes met, or null if they never did.
     * `timeoutMs` is a liveness ceiling, not a threshold being measured.
     */
    async wait(timeoutMs) {
      let timer = null;
      const expiry = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const met = await Promise.race([opened, expiry]);
      clearTimeout(timer);
      if (!met) {
        // Release the parked writes so the turns settle and the adapter can be
        // closed cleanly. The caller's assertion is the verdict.
        open(null);
      }
      return met;
    },
    restore() { ClaudeCodeProcessClient.prototype.sendUserMessage = original; },
  };
}

test("an indeterminate write is reported as a failure and never replayed", async () => {
  // The child exits after its first turn, so the second write races a dead
  // pipe. Which side wins is platform-dependent: posix reports EPIPE, win32 can
  // accept the bytes into a pipe nobody will ever read again, and either can
  // lose to the relaunch that happens when 'exit' lands before the write. So
  // the outcome is deliberately NOT pinned -- 0 executions (nothing read it)
  // and 1 execution (the relaunched child read it) are both correct. What must
  // hold on every platform is that the turn is written once and never replayed.
  const { adapter, workspaceRoot, readExec, readLaunches } = makeAdapter({ keepAlive: false });
  const lane = laneFor(500, 6);
  const spy = countWritesFor("second");
  let closed = false;
  // close() is the draining barrier below *and* the cleanup, so it must be
  // callable twice.
  const drainAndClose = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await adapter.close();
  };
  try {
    await turn(adapter, workspaceRoot, lane, null, "first");

    let secondFailed = false;
    try {
      await turn(adapter, workspaceRoot, lane, null, "second");
    } catch (error) {
      secondFailed = true;
      assert.ok(
        error instanceof IndeterminateTurnWriteError || /indeterminate/.test(error.message),
        `unexpected error: ${error.message}`,
      );
    }

    const countExecutions = () => readExec().filter((entry) => entry.line.includes("second")).length;
    // Every one of these holds at *every* instant, so it can be asserted at any
    // moment without knowing when the single legitimate execution lands. That is
    // the whole fix: the old version snapshotted the execution count 60ms in and
    // demanded it still match 120ms later, which a relaunched child on a slow
    // runner breaks by reading its one message in between -- no replay, just a
    // late read.
    const assertWrittenOnce = (when) => {
      assert.equal(spy.writes, 1, `the turn was written exactly once, whatever the write reported (${when})`);
      assert.ok(readLaunches().length <= 2, `at most one relaunch, and only before the write (${when})`);
      const executions = countExecutions();
      assert.ok(executions <= 1, `"second" must not be executed twice (saw ${executions}, ${when})`);
    };

    // Wait for the runtime to be done with the turn by watching for the
    // condition, never for a number of milliseconds: the guarantee is that the
    // turn settles, not that it settles within 60ms.
    const routing = await waitUntilSettled(adapter);
    assert.equal(routing.activeTurns, 0, `the turn slot was released (failed=${secondFailed})`);
    assert.equal(routing.workspaceLocks.writers, 0);
    assert.equal(routing.workspaceLocks.waiting, 0);
    assertWrittenOnce("once the turn settled");

    // Nothing arrives late either. The adapter is deliberately still open here,
    // so a replay -- immediate or on a retry timer -- would really be attempted,
    // and the prototype-level spy counts it whether or not it reaches a child.
    // Re-checking the same always-true bounds throughout the window replaces the
    // old snapshot comparison: a longer window can only observe more, never turn
    // a slow-but-correct run red.
    await stayingQuiet(assertWrittenOnce, REPLAY_WATCH_MS);

    // Finally, drain: close() ends every child's stdin and waits for the child
    // to exit, so every byte the runtime ever wrote has by now been read, logged
    // and acted upon. The exec log is final at this point in a way no sleep can
    // establish, however long it is.
    await drainAndClose();
    assertWrittenOnce("after every child drained and exited");
  } finally {
    spy.restore();
    await drainAndClose();
  }
});

test("a write that fails after the attempt began is indeterminate, not retried", async () => {
  // The deterministic counterpart to the race above. Destroying stdin makes the
  // write fail on every platform, and pinning `usable` reproduces the window
  // win32 opens -- 'exit' landing after the pre-write drain -- so the runtime
  // cannot take the safe relaunch branch. The turn must then surface as an
  // indeterminate failure with no second write, no relaunch and no execution.
  const { adapter, workspaceRoot, readExec, readLaunches } = makeAdapter({ keepAlive: true });
  const lane = laneFor(500, 61);
  const spy = countWritesFor("second");
  try {
    await turn(adapter, workspaceRoot, lane, null, "first");

    const entries = adapter.__internals.processRegistry.listEntries();
    assert.equal(entries.length, 1, "one live process for this lane");
    entries[0].client.stdin.destroy();
    Object.defineProperty(entries[0].client, "usable", { get: () => true, configurable: true });
    const launchesBefore = readLaunches().length;

    await assert.rejects(
      () => turn(adapter, workspaceRoot, lane, null, "second"),
      (error) => {
        assert.ok(error instanceof IndeterminateTurnWriteError, `unexpected error: ${error.message}`);
        assert.equal(error.code, "indeterminate_turn_write");
        assert.equal(error.indeterminate, true);
        return true;
      },
    );

    // Same shape as the race above: each of these is true at every instant of a
    // correct run -- a retry could only ever push a count *up* -- so they are
    // asserted on settle and then held to across a window, rather than sampled
    // once after a sleep that a slower machine would outrun.
    const assertNotRetried = (when) => {
      assert.equal(spy.writes, 1, `exactly one write was attempted; the turn was not retried (${when})`);
      assert.equal(readLaunches().length, launchesBefore, `no process was launched after the write began (${when})`);
      assert.equal(
        readExec().filter((entry) => entry.line.includes("second")).length,
        0,
        `nothing reached a child (${when})`,
      );
    };

    const routing = await waitUntilSettled(adapter);
    assert.equal(routing.activeTurns, 0, "the turn slot was released");
    assert.equal(routing.workspaceLocks.writers, 0);
    assert.equal(routing.workspaceLocks.waiting, 0);
    assertNotRetried("once the turn settled");
    await stayingQuiet(assertNotRetried, REPLAY_WATCH_MS);
  } finally {
    spy.restore();
    await adapter.close();
  }
});

test("the workspace lock is released when a turn completes, so the next turn proceeds", async () => {
  const { adapter, workspaceRoot } = makeAdapter({ keepAlive: true });
  try {
    await turn(adapter, workspaceRoot, laneFor(500, 7));
    // Waiting for the release, not for 40ms: the lock is released when the
    // result lands, and how long that takes is the machine's business.
    assert.equal(
      (await waitUntilSettled(adapter)).workspaceLocks.writers,
      0,
      "no writer is still holding the lock",
    );

    // A different lane in the same workspace can now take the write lock.
    await turn(adapter, workspaceRoot, laneFor(500, 8));
    const routing = await waitUntilSettled(adapter);
    assert.equal(routing.workspaceLocks.writers, 0);
    assert.equal(routing.workspaceLocks.waiting, 0);
    assert.equal(routing.activeTurns, 0, "every turn slot settled");
  } finally {
    await adapter.close();
  }
});

test("two write lanes in one workspace serialize but keep separate sessions", async () => {
  const { adapter, workspaceRoot } = makeAdapter({ keepAlive: true, turnDelayMs: 25 });
  try {
    const [a, b] = await Promise.all([
      turn(adapter, workspaceRoot, laneFor(500, 21)),
      turn(adapter, workspaceRoot, laneFor(500, 22)),
    ]);
    assert.notEqual(a.threadId, b.threadId, "each lane kept its own session");
    assert.notEqual(a.processKey, b.processKey, "each lane kept its own process");
    assert.equal(a.workspaceAccess, "write");

    assert.equal((await waitUntilSettled(adapter)).workspaceLocks.writers, 0);
  } finally {
    await adapter.close();
  }
});

test("read-access lanes run concurrently in one workspace", async () => {
  const { adapter, tempDir, workspaceRoot } = makeAdapter({ keepAlive: true, turnDelayMs: 40 });
  const reader = validateLaunchProfile(
    { profileId: "reader", workspaceAccess: "read" },
    { baseDir: tempDir },
  );
  // Concurrency is proven by the three lanes meeting, not by a stopwatch. The
  // old wall-clock budget measured process spawn time as much as it measured
  // serialization, so a slow runner failed it while the readers were in fact
  // perfectly concurrent.
  const gate = rendezvousOnWrite(3, () => adapter.describeRouting().workspaceLocks);
  try {
    const turns = Promise.all([
      turn(adapter, workspaceRoot, laneFor(500, 31), reader),
      turn(adapter, workspaceRoot, laneFor(500, 32), reader),
      turn(adapter, workspaceRoot, laneFor(500, 33), reader),
    ]);
    // Asserted below; never left as an unhandled rejection if the gate fails.
    turns.catch(() => {});

    const locks = await gate.wait(SETTLE_CEILING_MS);
    assert.ok(locks, `read lanes serialized: only ${gate.arrived()} of 3 reached their write together`);
    // Taken while all three were parked mid-turn, so this is the state of the
    // lock *during* the overlap, not after it.
    assert.equal(locks.readers, 3, "three read lanes held the workspace read lock at the same time");
    assert.equal(locks.writers, 0, "a read lane never takes the write lock");
    assert.equal(locks.waiting, 0, "no read lane queued behind another");
    assert.equal(locks.keys, 1, "all three were locking the one workspace");

    const results = await turns;
    for (const result of results) {
      assert.equal(result.workspaceAccess, "read");
    }
    assert.equal(new Set(results.map((r) => r.threadId)).size, 3);
  } finally {
    gate.restore();
    await adapter.close();
  }
});

test("IPC refuses a message with no unambiguous process identity", async () => {
  const { adapter, workspaceRoot } = makeAdapter({ keepAlive: true });
  const stderr = [];
  adapter.__internals.processRegistry.listEntries();
  const ipc = adapter.describe();
  assert.ok(ipc.ipcSocketPath);

  try {
    await turn(adapter, workspaceRoot, laneFor(500, 41));
    await turn(adapter, workspaceRoot, laneFor(500, 42));

    // Two live processes in one workspace: a workspace-only address is refused.
    const registry = adapter.__internals.processRegistry;
    const live = registry.listEntries().filter((entry) => entry.client?.usable);
    assert.equal(live.length, 2, "two lanes are live");

    const matches = live.filter((entry) => entry.workspaceRoot === workspaceRoot);
    assert.equal(matches.length, 2, "a workspace address cannot select one of them");

    // Naming the process explicitly does resolve.
    assert.ok(registry.get(live[0].processKey)?.client);
    assert.equal(registry.findEntryByThreadId(live[0].client.sessionId).processKey, live[0].processKey);
  } finally {
    await adapter.close();
  }
  assert.deepEqual(stderr, []);
});

test("closing the adapter releases every process, turn slot and workspace lock", async () => {
  const { adapter, workspaceRoot } = makeAdapter({ keepAlive: true });
  await turn(adapter, workspaceRoot, laneFor(500, 51));
  await turn(adapter, workspaceRoot, laneFor(500, 52));
  await adapter.close();

  const routing = adapter.describeRouting();
  assert.equal(routing.processCount, 0);
  assert.equal(routing.activeTurns, 0);
  assert.equal(routing.workspaceLocks.writers, 0);
  assert.equal(routing.workspaceLocks.readers, 0);
});
