"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CyberbossApp } = require("../src/core/app");
const { buildWeixinHelpText } = require("../src/core/command-registry");
const {
  Route1DispatchController,
  Route1DispatchIpcClient,
  decideBand,
  route1DispatchEnabled,
} = require("../src/orchestration/route1-dispatch");
const { ProjectToolHost } = require("../src/tools/tool-host");
const { ClaudeCodeIpcServer } = require("../src/adapters/runtime/claudecode/ipc-server");

const ROOT = path.resolve(__dirname, "..");
const BASE_SHA = "a".repeat(40);

function taskArgs(timeout_ms = 60_000) {
  return {
    objective: "Implement the bounded fixture change.",
    allowed_paths: ["src/fixture.js"],
    forbidden_paths: ["memory"],
    base_sha: BASE_SHA,
    acceptance_tests: [{ name: "fixture", command: "node", args: ["--check", "src/fixture.js"] }],
    timeout_ms,
    approval_policy: "never",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function result(taskId, lifecycle = "completed") {
  return {
    capsule: {
      task_id: taskId, status: lifecycle, summary: lifecycle, files_changed: [], tests: [],
      commit_sha: null, risks: [], recommended_action: lifecycle === "completed" ? "accept" : "stop",
    },
    shortStatus: { task_id: taskId, lifecycle, decision: lifecycle === "completed" ? "accept" : "stop", summary: lifecycle },
  };
}

function fixture() {
  const scheduled = [];
  const calls = [];
  const waits = new Map();
  const runtime = {
    runTaskSession({ spec }) {
      const wait = deferred();
      waits.set(spec.task_id, wait);
      calls.push({ type: "run", taskId: spec.task_id });
      return wait.promise;
    },
    continueTaskSession({ taskId }) {
      const wait = deferred();
      waits.set(taskId, wait);
      calls.push({ type: "continue", taskId });
      return wait.promise;
    },
    cancelTaskSession({ taskId }) { calls.push({ type: "soft", taskId }); return { state: "running" }; },
    requestTaskSessionStrongInterrupt({ taskId }) { calls.push({ type: "hard", taskId }); return { state: "interrupted" }; },
  };
  let nextId = 0;
  const traces = [];
  const controller = new Route1DispatchController({
    runtimeAdapter: runtime,
    idFactory: () => `fake-${++nextId}`,
    queueMicrotaskFn: (callback) => scheduled.push(callback),
    trace: (entry) => traces.push(entry),
  });
  const turn = { turnId: "turn-a", workspaceRoot: ROOT, launchProfile: { schemaVersion: 3, profileId: "work-engineering" } };
  controller.registerTurn(turn);
  const flush = () => { while (scheduled.length) scheduled.shift()(); };
  return { calls, controller, flush, runtime, scheduled, traces, turn, waits };
}

test("A1-A5 dispatch is create+queue only, single-flight, and applies 5/15/60 policy", async () => {
  assert.equal(decideBand(5 * 60_000, false), "free");
  assert.equal(decideBand(5 * 60_000 + 1, false), "confirm");
  assert.equal(decideBand(15 * 60_000 + 1, false), "consult");
  assert.equal(decideBand(60 * 60_000 + 1, false), "absolute");

  const f = fixture();
  const first = f.controller.dispatch(taskArgs(5 * 60_000), { turnId: f.turn.turnId });
  assert.equal(first.status, "queued");
  assert.match(first.task_id, /^route1-fake-1$/);
  f.flush();
  assert.deepEqual(f.calls, [], "worker must not start while the foreground turn still owns its lock");

  const pending = f.controller.dispatch(taskArgs(60_000), { turnId: f.turn.turnId });
  assert.equal(pending.status, "confirm_required", "queue pressure enters the self-confirm band");
  assert.ok(pending.confirm_token);
  const confirmed = f.controller.dispatch({ confirm_token: pending.confirm_token }, { turnId: f.turn.turnId });
  assert.equal(confirmed.self_confirmed, true);
  assert.throws(
    () => f.controller.dispatch({ confirm_token: pending.confirm_token }, { turnId: f.turn.turnId }),
    (error) => error.code === "route1_confirm_token_invalid",
  );

  f.controller.releaseTurn(f.turn.turnId);
  f.flush();
  assert.deepEqual(f.calls, [{ type: "run", taskId: first.task_id }]);
  assert.equal(f.controller.getTask(confirmed.task_id).state, "queued", "second worker cannot run concurrently");
  f.waits.get(first.task_id).resolve(result(first.task_id));
  await f.controller.tasks.get(first.task_id).runPromise;
  await Promise.resolve();
  f.flush();
  assert.deepEqual(f.calls.map((entry) => entry.type), ["run", "run"]);
  f.waits.get(confirmed.task_id).resolve(result(confirmed.task_id));
  await f.controller.tasks.get(confirmed.task_id).runPromise;

  const middleFixture = fixture();
  assert.equal(middleFixture.controller.dispatch(taskArgs(10 * 60_000), { turnId: "turn-a" }).status, "confirm_required");
  const consult = middleFixture.controller.dispatch(taskArgs(16 * 60_000), { turnId: "turn-a" });
  assert.equal(consult.status, "confirm_required");
  assert.equal(consult.owner_consult_required, true);
  assert.match(consult.text, /超 15 分钟/);
  assert.equal(middleFixture.controller.getTask(consult.task_id).state, "confirm_required");
  const absolute = middleFixture.controller.dispatch(taskArgs(60 * 60_000 + 1), { turnId: "turn-a" });
  assert.equal(absolute.status, "rejected");

  const expiryFixture = fixture();
  const expiring = expiryFixture.controller.dispatch(taskArgs(10 * 60_000), { turnId: "turn-a" });
  expiryFixture.controller.releaseTurn("turn-a");
  assert.throws(
    () => expiryFixture.controller.dispatch({ confirm_token: expiring.confirm_token }, { turnId: "turn-a" }),
    (error) => error.code === "route1_origin_turn_unknown",
  );
});

test("A1 real authenticated tool IPC reaches the app-owned in-process registry and returns the queued task id", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "route1-ipc-fake-"));
  const server = new ClaudeCodeIpcServer({ stateDir });
  const controller = new Route1DispatchController({
    runtimeAdapter: { runTaskSession() { throw new Error("worker must not start inside the turn"); } },
    idFactory: () => "ipc-fake",
    queueMicrotaskFn() {},
  });
  controller.registerTurn({ turnId: "ipc-turn", workspaceRoot: ROOT, launchProfile: { profileId: "work-engineering" } });
  server.on("clientMessage", (message, socket) => {
    if (message.type !== "route1.dispatch") return;
    try {
      const result = controller.dispatch(message.args, message.context);
      server.reply(socket, { type: "route1.dispatch.result", requestId: message.requestId, result });
    } catch (error) {
      server.reply(socket, { type: "route1.dispatch.result", requestId: message.requestId, error: error.code || error.message });
    }
  });
  try {
    await server.start();
    const client = new Route1DispatchIpcClient({ stateDir });
    const queued = await client.dispatch(taskArgs(), { turnId: "ipc-turn" });
    assert.equal(queued.status, "queued");
    assert.equal(queued.task_id, "route1-ipc-fake");
    assert.equal(controller.getTask(queued.task_id).state, "queued");
  } finally {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("A6-A10 soft interrupt acknowledges before the boundary, preserves the in-flight round, halts, and resumes", async () => {
  const f = fixture();
  const first = f.controller.dispatch(taskArgs(), { turnId: "turn-a" });
  const pending = f.controller.dispatch(taskArgs(), { turnId: "turn-a" });
  const second = f.controller.dispatch({ confirm_token: pending.confirm_token }, { turnId: "turn-a" });
  f.controller.releaseTurn("turn-a");
  f.flush();
  assert.equal(f.controller.getTask(first.task_id).state, "running");

  const interrupted = f.controller.softInterrupt();
  assert.equal(interrupted.acknowledgement, "收到");
  assert.deepEqual(f.calls.map((entry) => entry.type), ["run", "soft"]);
  assert.equal(f.controller.getTask(first.task_id).state, "running", "soft stop must not kill the in-flight atomic round");
  assert.equal(f.controller.getTask(second.task_id).state, "cancelled");
  assert.equal(f.controller.dispatch(taskArgs(), { turnId: "turn-a" }).status, "halted");
  let formalSent = false;
  interrupted.formal.then(() => { formalSent = true; });
  await Promise.resolve();
  assert.equal(formalSent, false, "formal reply must wait for the small-round boundary, unlike the acknowledgement");

  f.waits.get(first.task_id).resolve(result(first.task_id, "cancelled"));
  const formal = await interrupted.formal;
  assert.match(formal, /<route1_interrupt_status>/);
  assert.match(formal, /halted=true/);
  const resumed = f.controller.continueTasks();
  assert.equal(resumed.status, "resumed");
  assert.deepEqual(new Set(resumed.resumed), new Set([first.task_id, second.task_id]));
  f.flush();
  assert.equal(f.calls.at(-1).type, "continue");
});

test("A8 hard interrupt requests process kill, marks resumable work, and resumes only through continue", async () => {
  const f = fixture();
  const queued = f.controller.dispatch(taskArgs(), { turnId: "turn-a" });
  f.controller.releaseTurn("turn-a");
  f.flush();
  const interrupted = f.controller.hardInterrupt();
  assert.equal(interrupted.acknowledgement, "收到");
  assert.equal(f.calls.at(-1).type, "hard");
  f.waits.get(queued.task_id).resolve(result(queued.task_id, "interrupted"));
  assert.match(await interrupted.formal, /level=hard/);
  assert.equal(f.controller.getTask(queued.task_id).capsule.status, "interrupted");
  f.controller.continueTasks();
  f.flush();
  assert.equal(f.calls.at(-1).type, "continue");
});

test("A6/A10 app command sends immediate acknowledgement without awaiting the formal worker status", async () => {
  const formal = deferred();
  const sent = [];
  const fakeApp = {
    route1DispatchController: { softInterrupt: () => ({ acknowledgement: "收到", formal: formal.promise }) },
    channelAdapter: { sendText(payload) { sent.push(payload.text); return Promise.resolve(); } },
  };
  CyberbossApp.prototype.handleRoute1InterruptCommand.call(fakeApp, { senderId: "fixture-user", contextToken: "fixture", provider: "fixture" }, "soft");
  assert.deepEqual(sent, ["收到"]);
  formal.resolve("<route1_interrupt_status>done</route1_interrupt_status>");
  await formal.promise;
  await Promise.resolve();
  assert.deepEqual(sent, ["收到", "<route1_interrupt_status>done</route1_interrupt_status>"]);
});

test("A4 self-confirm reuses recordSelfEscalation and never enters the Owner approval handler", async () => {
  const priorDispatch = process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED;
  const priorTask = process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED = "true";
  process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = "true";
  const escalations = [];
  try {
    const host = new ProjectToolHost({
      services: { route1Dispatch: { dispatch: async () => ({ status: "queued", text: "queued", self_confirmed: true }) } },
      runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
      onSelfEscalation: (entry) => escalations.push(entry),
    });
    await host.invokeTool("route1_dispatch", {}, { turnId: "turn-a", workspaceRoot: ROOT });
    assert.deepEqual(escalations, [{
      type: "toolset_self_escalation", toolset: "", tool: "route1_dispatch", source: "self_escalation",
      scope: "window", approval_required: false,
    }]);
    const appSource = fs.readFileSync(path.join(ROOT, "src/core/app.js"), "utf8");
    assert.doesNotMatch(appSource, /handleApprovalCommand\([^)]*route1/i);
  } finally {
    if (priorDispatch === undefined) delete process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED; else process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED = priorDispatch;
    if (priorTask === undefined) delete process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED; else process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = priorTask;
  }
});

test("A11/A12/A14 flag-off preserves tool and command surfaces while scope guards keep T10-C absent", async () => {
  assert.equal(route1DispatchEnabled({ CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED: "false", CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED: "true" }), false);
  const controllerSource = fs.readFileSync(path.join(ROOT, "src/orchestration/route1-dispatch.js"), "utf8");
  assert.doesNotMatch(controllerSource, /memory_note|memory_candidate_submit|episodes\.jsonl|candidate-authority/i);
  assert.doesNotMatch(controllerSource, /Route1TaskStore|route1_task_status|route1_task_result|route1_task_notice|HandoffDispatcher/);
  const capsuleSource = fs.readFileSync(path.join(ROOT, "src/orchestration/delegation/result-capsule.js"), "utf8");
  assert.match(capsuleSource, /recommended_action/);
  assert.doesNotMatch(controllerSource, /recommended_action\s*[.:[=]/);
  const appSource = fs.readFileSync(path.join(ROOT, "src/core/app.js"), "utf8");
  assert.match(appSource, /route1DispatchEnabled\(\)/);
  assert.doesNotMatch(appSource, /route1_task_notice/);

  const priorDispatch = process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED;
  const priorTask = process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  delete process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED;
  delete process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  try {
    const host = new ProjectToolHost({ services: {}, runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } } });
    assert.equal(host.listTools().some((tool) => tool.name === "route1_dispatch"), false);
    const replies = [];
    await CyberbossApp.prototype.dispatchChannelCommand.call({
      route1DispatchController: null,
      channelAdapter: { async sendText(payload) { replies.push(payload.text); } },
    }, { senderId: "fixture-user", contextToken: "fixture", provider: "fixture" }, { name: "force-stop-now", args: "" });
    assert.deepEqual(replies, [buildWeixinHelpText()]);
    assert.doesNotMatch(replies[0], /force-stop-now|stop-tasks-and-answer-now|continue-tasks/);
  } finally {
    if (priorDispatch === undefined) delete process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED; else process.env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED = priorDispatch;
    if (priorTask === undefined) delete process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED; else process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = priorTask;
  }
});
