// Orchestrator-side verification of a returned capsule.
//
// The governing assumption is that the capsule is a CLAIM, not evidence. A
// sub-agent that misbehaved is exactly the one whose self-report cannot be
// trusted, so every safety-relevant claim is re-checked against state the
// orchestrator observed itself (the real git diff of the worktree).
//
// The decision is fail-closed: anything unrecognised, mismatched or missing
// resolves to "stop" rather than "accept".

const { validateTaskSpec } = require("./task-spec");
const { validateResultCapsule } = require("./result-capsule");
const { evaluateChangedPaths } = require("./path-policy");

const STOP_STATUSES = ["timed_out", "cancelled", "interrupted", "rejected"];

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}

function verifyCapsule({ spec, capsule, observedChangedPaths, allowAbsoluteForbiddenPaths = false } = {}) {
  const reasons = [];

  const specValidation = validateTaskSpec(spec, { allowAbsoluteForbiddenPaths });
  if (!specValidation.ok) {
    return { decision: "stop", reasons: specValidation.errors.map((error) => `spec: ${error}`) };
  }

  const capsuleValidation = validateResultCapsule(capsule);
  if (!capsuleValidation.ok) {
    return { decision: "stop", reasons: capsuleValidation.errors.map((error) => `capsule: ${error}`) };
  }

  if (capsule.task_id !== spec.task_id) {
    return {
      decision: "stop",
      reasons: [`capsule task_id "${capsule.task_id}" does not match spec task_id "${spec.task_id}"`],
    };
  }

  // No independently observed diff means there is nothing to verify against,
  // and an unverifiable capsule is not acceptable.
  if (!Array.isArray(observedChangedPaths)) {
    return { decision: "stop", reasons: ["observedChangedPaths must be provided by the orchestrator"] };
  }

  // Re-run the boundary check on what was actually observed. This is the check
  // that a lying capsule cannot route around.
  const boundary = evaluateChangedPaths({
    workspace: spec.workspace,
    allowedPaths: spec.allowed_paths,
    forbiddenPaths: spec.forbidden_paths,
    changedPaths: observedChangedPaths,
  });
  if (!boundary.ok) {
    for (const violation of boundary.violations) {
      reasons.push(`observed path boundary violation (${violation.reason}): ${violation.path}`);
    }
    return { decision: "stop", reasons };
  }

  // A capsule whose file list disagrees with the observed diff is either stale
  // or dishonest. Either way it cannot be accepted on its own word.
  const claimed = sortedUnique(capsule.files_changed);
  const observed = sortedUnique(observedChangedPaths);
  if (claimed.length !== observed.length || claimed.some((entry, index) => entry !== observed[index])) {
    return {
      decision: "stop",
      reasons: [
        `capsule files_changed does not match the observed diff; claimed=[${claimed.join(", ")}] observed=[${observed.join(", ")}]`,
      ],
    };
  }

  if (STOP_STATUSES.includes(capsule.status)) {
    return { decision: "stop", reasons: [`capsule status is ${capsule.status}`] };
  }

  const readonlyQuery = capsule.files_changed.length === 0
    && capsule.tests.length === 0
    && capsule.commit_sha === null
    && observed.length === 0;

  // D14's existing query shape carries evidence in the bounded summary and
  // leaves both files_changed and tests empty. The orchestrator still proves
  // the safety-relevant fact itself (there was no observed diff) before this
  // branch. Mutation capsules keep the stronger named-test correspondence.
  if (!readonlyQuery) {
    // Every acceptance test named in the spec must be present in the capsule.
    // Otherwise "no failures reported" could just mean "the test never ran".
    const reported = new Set(capsule.tests.map((entry) => entry.name));
    const missing = spec.acceptance_tests
      .map((entry) => entry.name)
      .filter((name) => !reported.has(name));
    if (missing.length) {
      reasons.push(`acceptance tests missing from capsule: ${missing.join(", ")}`);
    }

    const failed = capsule.tests.filter((entry) => !entry.passed).map((entry) => entry.name);
    if (failed.length) {
      reasons.push(`acceptance tests failed: ${failed.join(", ")}`);
    }
  }

  if (reasons.length) {
    return { decision: "rework", reasons };
  }

  if (capsule.status !== "completed") {
    return { decision: "stop", reasons: [`capsule status is ${capsule.status} with no reported failure`] };
  }

  return { decision: "accept", reasons: [] };
}

module.exports = {
  STOP_STATUSES,
  verifyCapsule,
};
