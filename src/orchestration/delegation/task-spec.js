// Task spec for a bounded Codex sub-agent run.
//
// The spec is the ONLY thing an executor is allowed to act on. Everything the
// sub-agent may touch has to be stated here up front: which paths it may write,
// which it may never write, which commit it starts from, what counts as
// acceptance, and how long it may run. Anything not stated is denied.
//
// Validation is fail-closed on purpose: a spec that is missing a field, or that
// carries an unrecognised approval policy, is invalid rather than defaulted.
// Defaulting an approval policy is how a bounded run silently becomes an
// unbounded one.

const path = require("path");

const TASK_SPEC_FIELDS = [
  "task_id",
  "objective",
  "allowed_paths",
  "forbidden_paths",
  "workspace",
  "base_sha",
  "acceptance_tests",
  "timeout_ms",
  "approval_policy",
];

// Mirrors the policies the Codex RPC client already understands
// (src/adapters/runtime/codex/rpc-client.js buildExecutionPolicies). Keeping the
// vocabulary identical avoids a translation layer that could drift.
const APPROVAL_POLICIES = ["never", "on-request", "untrusted"];

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// An upper bound so a malformed spec cannot park a worktree forever.
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// A repo-relative path is only usable as a boundary if it cannot climb out of
// the workspace. Absolute paths, drive letters and any ".." segment are refused
// here rather than being normalised away, so the spec author sees the problem.
function validateRelativePath(value, label, errors, { allowAbsolute = false } = {}) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  const raw = value.trim();
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    if (allowAbsolute) return;
    errors.push(`${label} must be repo-relative, got absolute: ${raw}`);
    return;
  }
  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    errors.push(`${label} must not contain a ".." segment: ${raw}`);
  }
}

function validateAcceptanceTest(entry, index, errors) {
  const label = `acceptance_tests[${index}]`;
  if (!isPlainObject(entry)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!isNonEmptyString(entry.name)) {
    errors.push(`${label}.name must be a non-empty string`);
  }
  if (!isNonEmptyString(entry.command)) {
    errors.push(`${label}.command must be a non-empty string`);
  }
  if (!Array.isArray(entry.args)) {
    errors.push(`${label}.args must be an array`);
    return;
  }
  if (entry.args.some((arg) => typeof arg !== "string")) {
    errors.push(`${label}.args must contain only strings`);
  }
}

function validateTaskSpec(value, { allowAbsoluteForbiddenPaths = false } = {}) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["task spec must be an object"] };
  }

  for (const field of TASK_SPEC_FIELDS) {
    if (!(field in value)) {
      errors.push(`missing field: ${field}`);
    }
  }

  if ("task_id" in value && !TASK_ID_PATTERN.test(String(value.task_id || ""))) {
    errors.push("task_id must be 3-64 chars of [a-z0-9-] and start alphanumeric");
  }
  if ("objective" in value && !isNonEmptyString(value.objective)) {
    errors.push("objective must be a non-empty string");
  }
  if ("workspace" in value && !isNonEmptyString(value.workspace)) {
    errors.push("workspace must be a non-empty string");
  }
  if ("base_sha" in value && !SHA_PATTERN.test(String(value.base_sha || ""))) {
    errors.push("base_sha must be a full 40-character hex commit sha");
  }

  // An empty allowlist would deny everything, which is safe but useless; it is
  // almost always a construction bug, so it is refused rather than accepted.
  if ("allowed_paths" in value) {
    if (!Array.isArray(value.allowed_paths) || value.allowed_paths.length === 0) {
      errors.push("allowed_paths must be a non-empty array");
    } else {
      value.allowed_paths.forEach((entry, index) => {
        validateRelativePath(entry, `allowed_paths[${index}]`, errors);
      });
    }
  }

  if ("forbidden_paths" in value) {
    if (!Array.isArray(value.forbidden_paths)) {
      errors.push("forbidden_paths must be an array");
    } else {
      value.forbidden_paths.forEach((entry, index) => {
        validateRelativePath(entry, `forbidden_paths[${index}]`, errors, {
          allowAbsolute: allowAbsoluteForbiddenPaths,
        });
      });
    }
  }

  if ("acceptance_tests" in value) {
    if (!Array.isArray(value.acceptance_tests) || value.acceptance_tests.length === 0) {
      errors.push("acceptance_tests must be a non-empty array");
    } else {
      value.acceptance_tests.forEach((entry, index) => {
        validateAcceptanceTest(entry, index, errors);
      });
    }
  }

  if ("timeout_ms" in value) {
    const timeout = value.timeout_ms;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
      errors.push(`timeout_ms must be an integer in (0, ${MAX_TIMEOUT_MS}]`);
    }
  }

  if ("approval_policy" in value && !APPROVAL_POLICIES.includes(value.approval_policy)) {
    errors.push(`approval_policy must be one of: ${APPROVAL_POLICIES.join(", ")}`);
  }

  return { ok: errors.length === 0, errors };
}

function assertValidTaskSpec(value, options = {}) {
  const validation = validateTaskSpec(value, options);
  if (!validation.ok) {
    throw new Error(`Invalid task spec:\n${validation.errors.join("\n")}`);
  }
  return value;
}

module.exports = {
  APPROVAL_POLICIES,
  MAX_TIMEOUT_MS,
  TASK_SPEC_FIELDS,
  assertValidTaskSpec,
  validateTaskSpec,
};
