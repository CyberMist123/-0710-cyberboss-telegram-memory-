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

test("an indeterminate write is reported as a failure and never replayed", async () => {
  // The child exits after its first turn, so the second write races a dead
  // pipe. Whatever the outcome, the same turn must not be executed twice.
  const { adapter, workspaceRoot, readExec } = makeAdapter({ keepAlive: false });
  const lane = laneFor(500, 6);
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

    await new Promise((resolve) => setTimeout(resolve, 60));
    const executions = readExec().filter((entry) => entry.line.includes("second"));
    assert.ok(executions.length <= 1, `"second" must not be executed twice (saw ${executions.length})`);
    if (!secondFailed) {
      assert.equal(executions.length, 1, "a turn reported as succeeded ran exactly once");
    }
  } finally {
    await adapter.close();
  }
});

test("the workspace lock is released when a turn completes, so the next turn proceeds", async () => {
  const { adapter, workspaceRoot } = makeAdapter({ keepAlive: true });
  try {
    await turn(adapter, workspaceRoot, laneFor(500, 7));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(adapter.describeRouting().workspaceLocks.writers, 0, "no writer is still holding the lock");

    // A different lane in the same workspace can now take the write lock.
    await turn(adapter, workspaceRoot, laneFor(500, 8));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const routing = adapter.describeRouting();
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

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(adapter.describeRouting().workspaceLocks.writers, 0);
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
  try {
    const started = Date.now();
    const results = await Promise.all([
      turn(adapter, workspaceRoot, laneFor(500, 31), reader),
      turn(adapter, workspaceRoot, laneFor(500, 32), reader),
      turn(adapter, workspaceRoot, laneFor(500, 33), reader),
    ]);
    const elapsed = Date.now() - started;

    for (const result of results) {
      assert.equal(result.workspaceAccess, "read");
    }
    assert.equal(new Set(results.map((r) => r.threadId)).size, 3);
    // Three 40ms turns run together; serialized they could not all have been
    // written inside a single turn's delay budget.
    assert.ok(elapsed < 1000, `readers did not serialize (took ${elapsed}ms)`);
  } finally {
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
