const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("./atomic-json");

const STATE_FIELDS = [
  "active_phase", "active_writer", "branch", "worktree", "last_green_sha", "live_sha",
  "rollback_sha", "tests_passed", "pending_user_action", "next_action", "blockers",
];

function validateState(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["state must be an object"] };
  for (const field of STATE_FIELDS) if (!(field in value)) errors.push(`missing field: ${field}`);
  if ("tests_passed" in value && !Array.isArray(value.tests_passed)) errors.push("tests_passed must be an array");
  if ("blockers" in value && !Array.isArray(value.blockers)) errors.push("blockers must be an array");
  return { ok: errors.length === 0, errors };
}

function loadOrchestratorState(filePath) {
  const state = readJson(path.resolve(filePath));
  const validation = validateState(state);
  if (!validation.ok) throw new Error(`Invalid orchestrator state:\n${validation.errors.join("\n")}`);
  return state;
}

function updateOrchestratorState(filePath, patch, options = {}) {
  const destination = path.resolve(filePath);
  let previous = {};
  if (fs.existsSync(destination)) previous = loadOrchestratorState(destination);
  const next = { ...previous, ...patch, updated_at: new Date().toISOString() };
  const validation = validateState(next);
  if (!validation.ok) throw new Error(`Invalid orchestrator state:\n${validation.errors.join("\n")}`);
  if (typeof options.beforeCommit === "function") options.beforeCommit(next);
  writeJsonAtomic(destination, next);
  return next;
}

module.exports = { STATE_FIELDS, loadOrchestratorState, updateOrchestratorState, validateState };
