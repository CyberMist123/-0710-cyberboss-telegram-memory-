"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSubjectRoute } = require("../src/continuity/subject-route");
const { Route1DispatchController } = require("../src/orchestration/route1-dispatch");

const BASE_SHA = "a".repeat(40);

function route({ thread = "native-origin", lane = "lane-main", slot = "slot-main" } = {}) {
  return createSubjectRoute({
    provider: "telegram",
    continuity_binding: {
      workspace_id: "fixture-workspace",
      account_id: "fixture-account",
      sender_id: "fixture-sender",
      binding_key: "fixture-binding",
    },
    route_lane: { lane_key: lane, chat_id: "fixture-chat", message_thread_id: null },
    session: {
      runtime_id: "claudecode",
      session_slot_key: slot,
      runtime_thread_id: thread,
      profile_id: "work-engineering",
      profile_fingerprint: "fixture-profile",
      window_id: thread,
    },
    author_turn_id: "fixture-origin-turn",
    source_entry_ids: ["fixture-entry"],
  });
}

function identity(value) {
  return {
    provider: value.provider,
    continuity_binding: value.continuity_binding,
    route_lane: value.route_lane,
    session: value.session,
  };
}

function taskArgs() {
  return {
    objective: "Update the fixture only.",
    allowed_paths: ["src/fixture.js"],
    forbidden_paths: ["memory"],
    base_sha: BASE_SHA,
    acceptance_tests: [{ name: "fixture", command: "node", args: ["--check", "src/fixture.js"] }],
    timeout_ms: 60_000,
    approval_policy: "never",
  };
}

function capsule(taskId) {
  return {
    task_id: taskId,
    status: "completed",
    summary: "fixture completed",
    files_changed: ["src/fixture.js"],
    tests: [{ name: "fixture", passed: true, exit_code: 0 }],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
  };
}

function fixture({ storedThread = "native-origin" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-task-store-"));
  const runtime = {
    getRoute1StoredThreadId() { return storedThread; },
    runTaskSession({ spec }) {
      return Promise.resolve({
        capsule: capsule(spec.task_id),
        verification: { decision: "accept", reasons: [] },
        shortStatus: { task_id: spec.task_id, lifecycle: "completed", decision: "accept", summary: "fixture completed" },
      });
    },
  };
  const controller = new Route1DispatchController({ runtimeAdapter: runtime, stateDir: root, idFactory: () => "fixture-result" });
  const origin = route();
  controller.registerTurn({
    turnId: "origin-turn",
    workspaceRoot: root,
    launchProfile: { profileId: "work-engineering" },
    routeIdentity: identity(origin),
    originRoute: origin,
  });
  return { controller, origin, root, runtime };
}

async function finish(f) {
  const queued = f.controller.dispatch(taskArgs(), { turnId: "origin-turn" });
  f.controller.releaseTurn("origin-turn");
  await new Promise((resolve) => setImmediate(resolve));
  await f.controller.tasks.get(queued.task_id).runPromise;
  return queued.task_id;
}

test("A1/A12 terminal capsule, verification, origin and claim events use one append-only file", async () => {
  const f = fixture();
  try {
    const taskId = await finish(f);
    const file = path.join(f.root, "route1", "task-results.jsonl");
    assert.equal(fs.existsSync(file), true);
    const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.event), ["terminal"]);
    assert.equal(rows[0].task_id, taskId);
    assert.equal(rows[0].verification.decision, "accept");
    assert.equal(rows[0].origin_route.session.runtime_thread_id, "native-origin");
    const claimed = f.controller.taskResult({ task_id: taskId }, { turnId: "origin-turn" });
    assert.equal(claimed.status, "claimed");
    const afterClaim = fs.readFileSync(file, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
    assert.deepEqual(afterClaim.map((row) => row.event), ["terminal", "claim"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("A2/A3 exact notice is once-only, pending is held, and switching back becomes current", async () => {
  const f = fixture();
  try {
    const taskId = await finish(f);
    const exact = f.controller.prepareRoute1CompletionNotice({ currentRoute: identity(f.origin) });
    assert.equal(exact.taskId, taskId);
    assert.match(exact.block, /^<route1_task_notice>/u);
    assert.ok(exact.block.length <= 200);
    assert.equal(f.controller.prepareRoute1CompletionNotice({ currentRoute: identity(f.origin) }), null);
    f.controller.completeRoute1CompletionNotice(exact);
    assert.equal(f.controller.prepareRoute1CompletionNotice({ currentRoute: identity(f.origin) }), null);

    const second = fixture();
    try {
      const secondTaskId = await finish(second);
      const other = route({ lane: "lane-other" });
      assert.equal(second.controller.getOriginState(second.controller.tasks.get(secondTaskId), identity(other)), "origin_pending");
      assert.equal(second.controller.prepareRoute1CompletionNotice({ currentRoute: identity(other) }), null);
      const current = second.controller.prepareRoute1CompletionNotice({ currentRoute: identity(second.origin) });
      assert.equal(current.taskId, secondTaskId);
    } finally {
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("A4/A5 expired capsules never inject but remain claimable in a same binding and lane new window", async () => {
  const f = fixture({ storedThread: "native-new" });
  try {
    const taskId = await finish(f);
    const expired = route({ thread: "native-new" });
    assert.equal(f.controller.getOriginState(f.controller.tasks.get(taskId), identity(expired)), "origin_expired");
    assert.equal(f.controller.prepareRoute1CompletionNotice({ currentRoute: identity(expired) }), null);
    const claimed = f.controller.taskResult({ task_id: taskId }, { currentRoute: identity(expired) });
    assert.equal(claimed.source, "from_finished_window");
    assert.equal(claimed.source_label, "来自已终结窗口");
    assert.equal(claimed.capsule.task_id, taskId);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
