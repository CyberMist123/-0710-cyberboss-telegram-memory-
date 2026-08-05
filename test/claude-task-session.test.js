"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const {
  StrongInterruptLatch,
  TASK_SESSION_STATES,
  TaskSessionRegistry,
  runAtomicTaskStep,
} = require("../src/adapters/runtime/claudecode/task-session");
const { resolveToolAuthorizationCeiling } = require("../src/adapters/runtime/claudecode/project-settings");
const { buildTelegramRouteLane } = require("../src/core/route-lane");
const { ProjectToolHost } = require("../src/tools/tool-host");

const FAKE_CLI = path.join(__dirname, "helpers", "fake-claude-cli.js");

function makeSpec(workspace, taskId = "fixture-route1-task", timeoutMs = 5_000) {
  return {
    task_id: taskId,
    objective: "Read one bounded fixture and return its source-backed result.",
    allowed_paths: ["src/fixtures"],
    forbidden_paths: ["memory", "runtime"],
    workspace,
    base_sha: "a".repeat(40),
    acceptance_tests: [{
      name: "result source is locatable and bounded",
      command: "fixture-readonly-check",
      args: ["--source", "src/fixtures/item.json"],
    }],
    timeout_ms: timeoutMs,
    approval_policy: "never",
  };
}

function makeReadonlyCapsule(taskId) {
  return {
    task_id: taskId,
    status: "completed",
    summary: "Fixture source src/fixtures/item.json contains one matching item.",
    files_changed: [],
    tests: [],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
  };
}

function makeManagedWorkProfile(root, workspace) {
  const configRoot = path.join(root, "worker-config");
  const settings = path.join(root, "worker.settings.json");
  const personaSource = path.join(root, "worker.role.md");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ fixture: "route1-worker" }), "utf8");
  fs.writeFileSync(personaSource, "FIXTURE_WORKER_ROLE", "utf8");
  return {
    schemaVersion: 3,
    profileId: "work-engineering",
    cwd: workspace,
    configRoot,
    harnessMode: "engineering",
    settingSources: ["user", "project", "local"],
    skillsMode: "enabled",
    settings: [settings],
    personaSource,
    residentToolSchemas: ["engineering-tools"],
    mcpServerCeiling: "work-ceiling@1",
    toolsetCeiling: "work-ceiling@1",
    defaultMcpServerSet: "work-base@1",
    defaultToolset: "work-full@1",
    strictMcpConfig: true,
    permissionMode: "work-engineering-full",
    envPolicy: "work-engineering",
  };
}

function makeFixture({ taskId = "fixture-route1-task", timeoutMs = 5_000, delayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-t09-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(workspace, "src", "fixtures"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const launchLog = path.join(root, "launches.jsonl");
  fs.writeFileSync(launchLog, "", "utf8");
  const spec = makeSpec(workspace, taskId, timeoutMs);
  const profile = makeManagedWorkProfile(root, workspace);
  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(stateDir, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
    claudeCommand: process.execPath,
    // The log path travels as a prefix argument, not as CB_FAKE_LAUNCH_LOG: a
    // profiled launch strips the child's environment to the G3 host allowlist,
    // so an env-configured fixture would record nothing for exactly the
    // launches these tests need to observe.
    claudeCommandPrefixArgs: [FAKE_CLI, "--cb-launch-log", launchLog],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: root,
    claudeG3AuthProbe: async () => ({ ok: true }),
  });
  return { adapter, delayMs, launchLog, profile, root, spec, workspace };
}

async function withTaskEnv(fixture, run) {
  const values = {
    CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED: "true",
    CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED: "true",
    CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED: "true",
    CB_FAKE_LAUNCH_LOG: fixture.launchLog,
    CB_FAKE_COUNTER: path.join(fixture.root, "counter"),
    CB_FAKE_KEEP_ALIVE: "0",
    CB_FAKE_TURN_DELAY_MS: String(fixture.delayMs),
    CB_FAKE_RESULT_JSON: JSON.stringify(makeReadonlyCapsule(fixture.spec.task_id)),
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readLaunches(filePath) {
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("T09 A1/A13 feature-off refuses task sessions without launch or routing mutation", async () => {
  const fixture = makeFixture();
  const previous = process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  delete process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED;
  try {
    const before = fixture.adapter.describeRouting();
    await assert.rejects(
      () => fixture.adapter.runTaskSession({
        spec: fixture.spec,
        launchProfile: fixture.profile,
        observedChangedPaths: [],
      }),
      (error) => error.code === "route1_task_session_disabled",
    );
    assert.deepEqual(fixture.adapter.describeRouting(), before);
    assert.equal(fixture.adapter.getTaskSessionStatus({ taskId: fixture.spec.task_id }), null);
    assert.deepEqual(readLaunches(fixture.launchLog), []);
  } finally {
    if (previous !== undefined) process.env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED = previous;
    await fixture.adapter.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("T09 A1-A5/A12 independent worker returns only validated capsule and bounded status", async () => {
  const fixture = makeFixture();
  await withTaskEnv(fixture, async () => {
    try {
      const foregroundLane = buildTelegramRouteLane({
        accountId: "fixture-account",
        chatId: 500,
        messageThreadId: null,
      });
      const foreground = await fixture.adapter.sendTurn({
        bindingKey: "fixture-binding",
        senderId: "500",
        workspaceRoot: fixture.workspace,
        lane: foregroundLane,
        launchProfile: fixture.profile,
        text: "fixture foreground turn",
      });
      const result = await fixture.adapter.runTaskSession({
        spec: fixture.spec,
        launchProfile: fixture.profile,
        taskMaterials: [{ source: "fixture request", text: "Find the single fixture item." }],
        observedChangedPaths: [],
      });

      assert.deepEqual(Object.keys(result).sort(), ["capsule", "shortStatus"]);
      assert.equal(result.shortStatus.lifecycle, "completed", JSON.stringify(result));
      assert.equal(result.shortStatus.decision, "accept");
      assert.equal(result.capsule.task_id, fixture.spec.task_id);
      assert.equal(Object.hasOwn(result, "originWindowId"), false);
      assert.equal(Object.hasOwn(result, "resultQueue"), false);
      assert.equal(Object.hasOwn(result, "transcript"), false);

      const task = fixture.adapter.getTaskSessionStatus({ taskId: fixture.spec.task_id });
      assert.equal(task.profileId, "work-engineering");
      assert.notEqual(task.nativeSessionId, foreground.threadId);
      assert.equal(
        fixture.adapter.__internals.sessionSlotStore.getThreadId(task.sessionSlotKey),
        task.nativeSessionId,
      );

      const foregroundResume = await fixture.adapter.resumeThread({
        threadId: task.nativeSessionId,
        workspaceRoot: fixture.workspace,
        bindingKey: "fixture-binding",
        senderId: "500",
        lane: foregroundLane,
        launchProfile: fixture.profile,
      });
      assert.equal(foregroundResume.resumed, false);
      assert.equal(foregroundResume.refused, "slot_mismatch");

      assert.equal(fixture.spec.timeout_ms, 5_000);
    } finally {
      await fixture.adapter.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("T09 A1/A4 task timeout uses spec timeout and remains resumable", async () => {
  const fixture = makeFixture({ taskId: "fixture-route1-timeout", timeoutMs: 20, delayMs: 200 });
  await withTaskEnv(fixture, async () => {
    try {
      const result = await fixture.adapter.runTaskSession({
        spec: fixture.spec,
        launchProfile: fixture.profile,
        observedChangedPaths: [],
      });
      assert.equal(result.capsule.status, "timed_out");
      assert.equal(result.shortStatus.lifecycle, "timed_out");
      const queued = fixture.adapter.addTaskSessionInstruction({
        taskId: fixture.spec.task_id,
        instruction: "Retry with the same bounded fixture source.",
      });
      assert.equal(queued.queuedInstructions, 1);
      const resumed = fixture.adapter.__internals.taskSessionRegistry.resume(fixture.spec.task_id);
      assert.equal(resumed.state, "queued");
    } finally {
      await fixture.adapter.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("T12 route1 worker is spawned with the launch its own gate verified", async () => {
  const fixture = makeFixture({ taskId: "fixture-route1-identity" });
  await withTaskEnv(fixture, async () => {
    try {
      const result = await fixture.adapter.runTaskSession({
        spec: fixture.spec,
        launchProfile: fixture.profile,
        observedChangedPaths: [],
      });
      assert.equal(result.shortStatus.lifecycle, "completed", JSON.stringify(result));
      const [worker] = readLaunches(fixture.launchLog);
      // The worker's route-scoped MCP config reached its gate: it is in the
      // spawned argv exactly once, from the profile launch the gate built.
      assert.equal(worker.argv.filter((arg) => arg === "--mcp-config").length, 1);
      const mcpPath = worker.argv[worker.argv.indexOf("--mcp-config") + 1];
      assert.equal(mcpPath.includes(path.join("claude-mcp", "route-")), true);
      assert.equal(fs.existsSync(mcpPath), true);
      assert.equal(worker.argv.includes("--strict-mcp-config"), true);
    } finally {
      await fixture.adapter.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("T12 route1 refuses raw extraArgs in the gate instead of at spawn time", async () => {
  const fixture = makeFixture({ taskId: "fixture-route1-extra-args" });
  // Same production shape as the chat lane: a deployment-wide extra arg that a
  // profiled launch may never combine with.
  fixture.adapter.__internals.processRegistry.listEntries();
  const withExtraArgs = createClaudeCodeRuntimeAdapter({
    stateDir: path.join(fixture.root, "state"),
    sessionsFile: path.join(fixture.root, "state", "sessions-extra.json"),
    claudeSessionSlotsFile: path.join(fixture.root, "state", "slots-extra.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [FAKE_CLI, "--cb-launch-log", fixture.launchLog],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: fixture.root,
    claudeExtraArgs: ["--effort", "medium"],
    claudeG3AuthProbe: async () => ({ ok: true }),
  });
  await withTaskEnv(fixture, async () => {
    try {
      const result = await withExtraArgs.runTaskSession({
        spec: fixture.spec,
        launchProfile: fixture.profile,
        observedChangedPaths: [],
      });
      assert.equal(result.capsule.status, "failed", JSON.stringify(result));
      assert.deepEqual(readLaunches(fixture.launchLog), []);
    } finally {
      await withExtraArgs.close();
      await fixture.adapter.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("T09 A4 lifecycle registry exposes every state plus bounded add-instruction/cancel/resume", () => {
  assert.deepEqual(TASK_SESSION_STATES, [
    "create", "queued", "running", "waiting_approval", "completed", "failed", "timed_out", "cancelled",
  ]);
  const registry = new TaskSessionRegistry();
  const spec = makeSpec("C:\\fixture\\workspace", "fixture-lifecycle-task");
  registry.create({ spec, sessionSlotKey: "a".repeat(64), profileId: "work-engineering" });
  registry.transition(spec.task_id, "running", "x".repeat(2_000));
  assert.equal(registry.get(spec.task_id).progress.length <= 500, true);
  registry.transition(spec.task_id, "waiting_approval", "approval required");
  registry.addInstruction(spec.task_id, "Use the bounded fixture only.");
  registry.transition(spec.task_id, "cancelled", "cancelled at boundary");
  assert.equal(registry.resume(spec.task_id).state, "queued");
});

test("T09 A9/A10 worker ceiling denies both memory schemas and calls even with explicit request", async () => {
  const workerProfile = { schemaVersion: 3, profileId: "work-engineering" };
  const ceiling = resolveToolAuthorizationCeiling(workerProfile);
  assert.equal(ceiling, "work-memory-readonly@1");
  assert.throws(
    () => resolveToolAuthorizationCeiling({ schemaVersion: 3, profileId: "fixture-unknown" }),
    (error) => error.code === "g3_tool_authorization_identity_unknown",
  );
  const host = new ProjectToolHost({
    services: {},
    runtimeContextStore: { resolveActiveContext: () => ({}) },
    authorizationCeiling: ceiling,
  });
  const previousCatalog = process.env.CYBERBOSS_TOOL_CATALOG_ENABLED;
  const previousSigning = process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
  process.env.CYBERBOSS_TOOL_CATALOG_ENABLED = "true";
  process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED = "true";
  try {
    for (const toolName of ["memory_note", "memory_candidate_submit"]) {
      await assert.rejects(
        () => host.invokeTool("cyberboss_catalog", { handle: `memory/${toolName}` }),
        (error) => error.code === "g3_schema_not_authorized",
      );
      await assert.rejects(
        () => host.invokeTool(toolName, { text: "fixture", explicitlyAuthorized: true }),
        (error) => error.code === "g3_call_not_authorized",
      );
    }
  } finally {
    if (previousCatalog === undefined) delete process.env.CYBERBOSS_TOOL_CATALOG_ENABLED;
    else process.env.CYBERBOSS_TOOL_CATALOG_ENABLED = previousCatalog;
    if (previousSigning === undefined) delete process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
    else process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED = previousSigning;
  }
  const productionSource = [
    fs.readFileSync(path.join(__dirname, "..", "src", "adapters", "runtime", "claudecode", "task-session.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "src", "adapters", "runtime", "claudecode", "index.js"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(productionSource, /Episode candidate|Desire|canon writer|memory_candidate_submit/);
});

test("T09 A11 strong interrupt latch waits for the atomic-step boundary", async () => {
  const latch = new StrongInterruptLatch();
  const events = [];
  let releaseStep;
  const inFlight = runAtomicTaskStep(latch, async () => {
    events.push("step-started");
    await new Promise((resolve) => { releaseStep = resolve; });
    events.push("step-completed");
    return "fixture-result";
  });
  await new Promise((resolve) => setImmediate(resolve));
  latch.request("strong_interrupt");
  events.push("interrupt-requested");
  assert.deepEqual(events, ["step-started", "interrupt-requested"]);
  releaseStep();
  const finished = await inFlight;
  assert.equal(finished.ran, true);
  assert.equal(finished.stopAtBoundary, true);
  assert.equal(finished.value, "fixture-result");
  const skipped = await runAtomicTaskStep(latch, async () => events.push("must-not-run"));
  assert.equal(skipped.ran, false);
  assert.deepEqual(events, ["step-started", "interrupt-requested", "step-completed"]);
});
