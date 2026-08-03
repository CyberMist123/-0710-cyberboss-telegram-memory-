"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ClaudeCodeProcessClient } = require("../src/adapters/runtime/claudecode/process-client");
const { StrongInterruptLatch, TaskSessionRegistry, runAtomicTaskStep } = require("../src/adapters/runtime/claudecode/task-session");
const { validateResultCapsule } = require("../src/orchestration/delegation/result-capsule");
const { verifyCapsule } = require("../src/orchestration/delegation/verifier");

const SPEC = {
  task_id: "fake-hard-interrupt",
  objective: "Exercise deterministic interrupt behavior.",
  allowed_paths: ["src/fake.js"],
  forbidden_paths: [],
  workspace: ".",
  base_sha: "b".repeat(40),
  acceptance_tests: [{ name: "fake", command: "node", args: ["--check", "src/fake.js"] }],
  timeout_ms: 60_000,
  approval_policy: "never",
};

test("A9 soft latch is checked only between atomic small rounds and outranks queued instructions", async () => {
  const latch = new StrongInterruptLatch();
  let finish;
  const inFlight = new Promise((resolve) => { finish = resolve; });
  const atomic = runAtomicTaskStep(latch, async () => { await inFlight; return "round-finished"; });
  latch.request("owner_soft_interrupt");
  finish();
  assert.deepEqual(await atomic, { ran: true, stopAtBoundary: true, value: "round-finished" });
  let ranNext = false;
  assert.deepEqual(await runAtomicTaskStep(latch, async () => { ranNext = true; }), { ran: false, stopAtBoundary: true, value: undefined });
  assert.equal(ranNext, false);

  const registry = new TaskSessionRegistry();
  registry.create({ spec: SPEC, sessionSlotKey: "fake-slot", profileId: "work-engineering" });
  registry.requestCancel(SPEC.task_id, "owner_soft_interrupt");
  assert.throws(() => registry.addInstruction(SPEC.task_id, "must not queue"), (error) => error.code === "task_session_interrupt_pending");
  assert.throws(() => registry.resume(SPEC.task_id), (error) => error.code === "task_session_interrupt_pending");
  assert.equal(registry.resume(SPEC.task_id, { clearInterrupt: true }).state, "queued");

  const capsule = {
    task_id: SPEC.task_id, status: "interrupted", summary: "current small round discarded",
    files_changed: [], tests: [], commit_sha: null, risks: ["worktree may contain a partial edit"], recommended_action: "stop",
  };
  assert.equal(validateResultCapsule(capsule).ok, true);
  assert.equal(verifyCapsule({ spec: SPEC, capsule, observedChangedPaths: [] }).decision, "stop");
});

test("A8 forceClose kills the worker child immediately and hard-interrupted registry state is resumable", async () => {
  const signals = [];
  const fake = {
    child: { exitCode: null, signalCode: null, kill(signal) { signals.push(signal); } },
    stdin: { destroy() {} },
    alive: true,
    sessionId: "fake-native-session",
    resumeSessionId: "fake-native-session",
    activeThreadId: "fake-native-session",
    pendingTurnId: "fake-turn",
    rejectSessionWaiters() {},
  };
  await ClaudeCodeProcessClient.prototype.forceClose.call(fake);
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.equal(fake.child, null);

  const registry = new TaskSessionRegistry();
  registry.create({ spec: SPEC, sessionSlotKey: "fake-slot", profileId: "work-engineering" });
  registry.transition(SPEC.task_id, "running", "running");
  const interrupted = registry.requestHardInterrupt(SPEC.task_id);
  assert.equal(interrupted.state, "cancelled");
  assert.equal(interrupted.interrupt.reason, "force_stop_now");
  assert.equal(registry.resume(SPEC.task_id, { clearInterrupt: true }).state, "queued");
});
