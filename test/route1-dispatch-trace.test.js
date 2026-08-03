"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { Route1DispatchController } = require("../src/orchestration/route1-dispatch");
const { sanitizeTraceEntry } = require("../src/core/context-trace");

const BASE = {
  objective: "Trace the bounded fake task.", allowed_paths: ["src/fake.js"], forbidden_paths: [],
  base_sha: "c".repeat(40), acceptance_tests: [{ name: "fake", command: "node", args: ["--check", "src/fake.js"] }],
  approval_policy: "never",
};

test("A13 dispatch, confirm, escalate, and interrupt traces carry explanations but no task body", () => {
  const trace = [];
  let id = 0;
  const controller = new Route1DispatchController({
    runtimeAdapter: { runTaskSession() { return new Promise(() => {}); }, cancelTaskSession() {} },
    idFactory: () => `trace-${++id}`,
    queueMicrotaskFn() {},
    trace: (entry) => trace.push(entry),
  });
  controller.registerTurn({ turnId: "trace-turn", workspaceRoot: path.resolve(__dirname, ".."), launchProfile: { profileId: "work-engineering" } });
  controller.dispatch({ ...BASE, timeout_ms: 60_000 }, { turnId: "trace-turn" });
  controller.dispatch({ ...BASE, timeout_ms: 10 * 60_000 }, { turnId: "trace-turn" });
  controller.dispatch({ ...BASE, timeout_ms: 16 * 60_000 }, { turnId: "trace-turn" });
  controller.softInterrupt();
  assert.deepEqual(new Set(trace.map((entry) => entry.action)), new Set(["dispatch", "confirm", "escalate", "interrupt"]));
  for (const entry of trace) {
    assert.equal(typeof entry.explanation, "string");
    assert.ok(entry.explanation.length > 0);
    assert.equal(Object.hasOwn(entry, "objective"), false);
    assert.equal(Object.hasOwn(entry, "task_materials"), false);
    const row = sanitizeTraceEntry({ route1_dispatch: entry });
    assert.equal(row.route1_dispatch.action, entry.action);
    assert.equal(row.route1_dispatch.explanation, entry.explanation);
    assert.equal(JSON.stringify(row).includes(BASE.objective), false);
  }
});
