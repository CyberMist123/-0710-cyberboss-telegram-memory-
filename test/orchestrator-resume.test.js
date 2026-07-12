const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadOrchestratorState, updateOrchestratorState } = require("../src/orchestration/orchestrator-state");

const initial = {
  active_phase: "phase1",
  active_writer: "writer",
  branch: "branch",
  worktree: "worktree",
  last_green_sha: "a".repeat(40),
  live_sha: "a".repeat(40),
  rollback_sha: "b".repeat(40),
  tests_passed: ["offline"],
  pending_user_action: null,
  next_action: "verify",
  blockers: [],
};

test("orchestrator state resumes from last atomic file after an interrupted update", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-orchestrator-"));
  const file = path.join(root, "MEMORY_ORCHESTRATOR_STATE.json");
  updateOrchestratorState(file, initial);
  fs.writeFileSync(path.join(root, ".MEMORY_ORCHESTRATOR_STATE.json.interrupted.tmp"), "{", "utf8");
  const resumed = loadOrchestratorState(file);
  assert.equal(resumed.next_action, "verify");
  const updated = updateOrchestratorState(file, { next_action: "complete", tests_passed: ["offline", "live"] });
  assert.equal(updated.next_action, "complete");
  assert.deepEqual(loadOrchestratorState(file).tests_passed, ["offline", "live"]);
});
