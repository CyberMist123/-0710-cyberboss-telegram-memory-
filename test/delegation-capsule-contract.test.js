const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const {
  CAPSULE_STATUSES,
  FORBIDDEN_CAPSULE_KEYS,
  RECOMMENDED_ACTIONS,
  validateResultCapsule,
} = require("../src/orchestration/delegation/result-capsule");
const { APPROVAL_POLICIES, validateTaskSpec } = require("../src/orchestration/delegation/task-spec");

function makeValidCapsule(overrides = {}) {
  return {
    task_id: "canary-docs-note",
    status: "completed",
    summary: "done",
    files_changed: ["docs/notes.md"],
    tests: [{ name: "notes-present", passed: true, exit_code: 0 }],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
    ...overrides,
  };
}

function makeValidTaskSpec(overrides = {}) {
  return {
    task_id: "canary-docs-note",
    objective: "Append one line to docs/notes.md",
    allowed_paths: ["docs"],
    forbidden_paths: ["src"],
    workspace: path.join(os.tmpdir(), "workspace"),
    base_sha: "a".repeat(40),
    acceptance_tests: [{ name: "notes-present", command: "node", args: ["--version"] }],
    timeout_ms: 5000,
    approval_policy: "never",
    ...overrides,
  };
}

test("capsule statuses are pinned and invalid statuses are rejected", () => {
  assert.deepEqual(CAPSULE_STATUSES, ["completed", "failed", "timed_out", "cancelled", "interrupted", "rejected"]);
  assert.equal(validateResultCapsule(makeValidCapsule()).ok, true);

  const invalid = validateResultCapsule(makeValidCapsule({ status: "accepted" }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("status must be one of")));
});

test("recommended actions are pinned and invalid actions are rejected", () => {
  assert.deepEqual(RECOMMENDED_ACTIONS, ["accept", "rework", "stop"]);
  assert.equal(validateResultCapsule(makeValidCapsule()).ok, true);

  const invalid = validateResultCapsule(makeValidCapsule({ recommended_action: "retry" }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("recommended_action must be one of")));
});

test("forbidden capsule keys are rejected everywhere the exported list says they are", () => {
  for (const key of FORBIDDEN_CAPSULE_KEYS) {
    // This loops over the source of truth so adding a new forbidden key cannot silently skip coverage.
    const invalid = validateResultCapsule(makeValidCapsule({ [key]: "leak" }));
    assert.equal(invalid.ok, false, `${key} must be rejected`);
    assert.ok(invalid.errors.some((error) => error.includes("raw process output")));
  }
});

test("approval policies are pinned and unknown policies are rejected", () => {
  assert.deepEqual(APPROVAL_POLICIES, ["never", "on-request", "untrusted"]);
  assert.equal(validateTaskSpec(makeValidTaskSpec()).ok, true);

  const invalid = validateTaskSpec(makeValidTaskSpec({ approval_policy: "auto" }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("approval_policy must be one of")));
});

test("commit_sha accepts null and full lowercase hex, and rejects drift-prone shorthands", () => {
  assert.equal(validateResultCapsule(makeValidCapsule({ commit_sha: null })).ok, true);
  assert.equal(validateResultCapsule(makeValidCapsule({ commit_sha: "a".repeat(40) })).ok, true);

  const shortSha = validateResultCapsule(makeValidCapsule({ commit_sha: "a".repeat(7) }));
  assert.equal(shortSha.ok, false);
  assert.ok(shortSha.errors.some((error) => error.includes("commit_sha must be null or a full 40-character hex sha")));

  const nonHex = validateResultCapsule(makeValidCapsule({ commit_sha: "g".repeat(40) }));
  assert.equal(nonHex.ok, false);
  assert.ok(nonHex.errors.some((error) => error.includes("commit_sha must be null or a full 40-character hex sha")));
});
