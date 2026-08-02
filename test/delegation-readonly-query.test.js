"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTaskShortStatus,
  parseTaskSessionCapsule,
} = require("../src/adapters/runtime/claudecode/task-session");
const {
  validateResultCapsule,
} = require("../src/orchestration/delegation/result-capsule");
const { verifyCapsule } = require("../src/orchestration/delegation/verifier");

function readonlySpec() {
  return {
    task_id: "fixture-readonly-query",
    objective: "Inspect bounded fixture facts without modifying the workspace.",
    allowed_paths: ["src/fixtures"],
    forbidden_paths: ["memory"],
    workspace: "C:\\fixture\\workspace",
    base_sha: "a".repeat(40),
    acceptance_tests: [{
      name: "source is locatable and query evidence matches",
      command: "fixture-readonly-check",
      args: ["--bounded"],
    }],
    timeout_ms: 5_000,
    approval_policy: "never",
  };
}

function readonlyCapsule(extra = {}) {
  return {
    task_id: "fixture-readonly-query",
    status: "completed",
    summary: "Fixture source src/fixtures/item.json reports one matching item.",
    files_changed: [],
    tests: [],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
    ...extra,
  };
}

test("T09 A5/A8 readonly runtime text follows parse, D14 validate, verify, short-status chain", () => {
  const spec = readonlySpec();
  const capsule = parseTaskSessionCapsule(JSON.stringify(readonlyCapsule()));
  assert.deepEqual(validateResultCapsule(capsule), { ok: true, errors: [] });

  const verification = verifyCapsule({ spec, capsule, observedChangedPaths: [] });
  assert.deepEqual(verification, { decision: "accept", reasons: [] });

  const shortStatus = buildTaskShortStatus({
    task: {
      taskId: spec.task_id,
      state: "completed",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    },
    capsule,
    verification,
  });
  assert.equal(shortStatus.decision, "accept");
  assert.equal(shortStatus.summary, capsule.summary);
  assert.equal(Object.hasOwn(shortStatus, "transcript"), false);
  assert.equal(spec.acceptance_tests.length, 1);
  assert.deepEqual(capsule.files_changed, []);
  assert.deepEqual(capsule.tests, []);
  assert.equal(capsule.commit_sha, null);
});

test("T09 A6 nested transcript-shaped keys are rejected before verification", () => {
  const capsule = readonlyCapsule({
    risks: [{ evidence: { history: "fixture raw output" } }],
  });
  const validation = validateResultCapsule(capsule);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /raw process output: risks\[0\]\.evidence\.history/);
  assert.equal(
    verifyCapsule({ spec: readonlySpec(), capsule, observedChangedPaths: [] }).decision,
    "stop",
  );
});

test("T09 A7 observed boundary violation stops before acceptance-test correspondence", () => {
  const capsule = readonlyCapsule({ files_changed: ["memory/forbidden.jsonl"] });
  const verdict = verifyCapsule({
    spec: readonlySpec(),
    capsule,
    observedChangedPaths: ["memory/forbidden.jsonl"],
  });
  assert.equal(verdict.decision, "stop");
  assert.match(verdict.reasons[0], /observed path boundary violation/);
  assert.equal(verdict.reasons.some((reason) => /acceptance tests missing/.test(reason)), false);
});

test("T09 A8 readonly exception does not weaken mutation acceptance-test evidence", () => {
  const capsule = readonlyCapsule({
    files_changed: ["src/fixtures/item.json"],
    commit_sha: "b".repeat(40),
  });
  const verdict = verifyCapsule({
    spec: readonlySpec(),
    capsule,
    observedChangedPaths: ["src/fixtures/item.json"],
  });
  assert.equal(verdict.decision, "rework");
  assert.match(verdict.reasons.join("\n"), /acceptance tests missing/);
});
