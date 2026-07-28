// Runs one bounded sub-agent task and reduces it to a single result capsule.
//
// Every collaborator is injected (runtime, git, testRunner, clock) so the whole
// loop can be exercised offline against a fake runtime, with no Codex quota and
// no production credentials. That is the only way this loop gets CI signal.
//
// Ordering matters and is deliberate:
//
//   run -> collect changed paths -> boundary check -> acceptance tests
//
// The boundary check runs BEFORE the acceptance tests. A run that already wrote
// outside its allowlist has broken the contract, and executing its tests would
// mean running code it was never authorised to produce.

const { assertValidTaskSpec } = require("./task-spec");
const { MAX_SUMMARY_CHARS, assertValidResultCapsule } = require("./result-capsule");
const { evaluateChangedPaths } = require("./path-policy");

const TRUNCATION_NOTE = " [truncated]";

// The capsule is a conclusion, not a log. A runtime that returns something long
// is truncated here rather than allowed to fail validation later, so a chatty
// runtime degrades to a short summary instead of losing the whole capsule.
function boundSummary(value, risks) {
  const text = typeof value === "string" && value.trim() ? value.trim() : "(no summary reported)";
  if (text.length <= MAX_SUMMARY_CHARS) {
    return text;
  }
  risks.push("runtime summary exceeded the capsule limit and was truncated");
  return `${text.slice(0, MAX_SUMMARY_CHARS - TRUNCATION_NOTE.length)}${TRUNCATION_NOTE}`;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Best effort: ask the runtime to stop. Whether it obeys is its problem;
      // the orchestrator stops waiting either way.
      try {
        onTimeout();
      } catch (error) {
        // A cancel that throws must not mask the timeout itself.
      }
      resolve({ timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  return Promise.race([
    promise.then((value) => ({ timedOut: false, value }), (error) => ({ timedOut: false, error })),
    timeout,
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function runDelegatedTask({ spec, runtime, git, testRunner } = {}) {
  assertValidTaskSpec(spec);

  if (!runtime || typeof runtime.run !== "function") {
    throw new Error("runtime.run is required");
  }
  if (!git || typeof git.changedPaths !== "function") {
    throw new Error("git.changedPaths is required");
  }
  if (typeof testRunner !== "function") {
    throw new Error("testRunner is required");
  }

  const risks = [];

  const outcome = await withTimeout(
    Promise.resolve().then(() => runtime.run({ spec })),
    spec.timeout_ms,
    () => {
      if (typeof runtime.cancel === "function") {
        runtime.cancel({ spec });
      }
    },
  );

  if (outcome.timedOut) {
    return assertValidResultCapsule({
      task_id: spec.task_id,
      status: "timed_out",
      summary: `run exceeded timeout_ms=${spec.timeout_ms} and was cancelled`,
      files_changed: [],
      tests: [],
      commit_sha: null,
      risks: ["worktree may hold partial edits from the cancelled run"],
      recommended_action: "stop",
    });
  }

  if (outcome.error) {
    return assertValidResultCapsule({
      task_id: spec.task_id,
      status: "failed",
      summary: boundSummary(`runtime threw: ${outcome.error.message}`, risks),
      files_changed: [],
      tests: [],
      commit_sha: null,
      risks,
      recommended_action: "rework",
    });
  }

  const result = outcome.value || {};

  if (result.cancelled) {
    return assertValidResultCapsule({
      task_id: spec.task_id,
      status: "cancelled",
      summary: boundSummary(result.summary || "run was cancelled", risks),
      files_changed: [],
      tests: [],
      commit_sha: null,
      risks,
      recommended_action: "stop",
    });
  }

  const changedPaths = git.changedPaths({ workspace: spec.workspace, baseSha: spec.base_sha });
  const boundary = evaluateChangedPaths({
    workspace: spec.workspace,
    allowedPaths: spec.allowed_paths,
    forbiddenPaths: spec.forbidden_paths,
    changedPaths,
  });

  if (!boundary.ok) {
    for (const violation of boundary.violations) {
      risks.push(`path boundary violated (${violation.reason}): ${violation.path}`);
    }
    return assertValidResultCapsule({
      task_id: spec.task_id,
      status: "rejected",
      summary: boundSummary(
        `run wrote ${boundary.violations.length} path(s) outside its boundary; acceptance tests were not run`,
        risks,
      ),
      files_changed: changedPaths,
      tests: [],
      commit_sha: null,
      risks,
      recommended_action: "stop",
    });
  }

  const tests = [];
  for (const acceptanceTest of spec.acceptance_tests) {
    const testResult = testRunner({ workspace: spec.workspace, test: acceptanceTest });
    tests.push({
      name: acceptanceTest.name,
      passed: Boolean(testResult && testResult.passed),
      exit_code: Number.isInteger(testResult && testResult.exit_code) ? testResult.exit_code : -1,
    });
  }

  const allPassed = tests.every((entry) => entry.passed);
  const commitSha = typeof git.headSha === "function"
    ? git.headSha({ workspace: spec.workspace })
    : null;

  return assertValidResultCapsule({
    task_id: spec.task_id,
    status: allPassed ? "completed" : "failed",
    summary: boundSummary(result.summary, risks),
    files_changed: changedPaths,
    tests,
    commit_sha: allPassed ? commitSha || null : null,
    risks,
    recommended_action: allPassed ? "accept" : "rework",
  });
}

module.exports = {
  runDelegatedTask,
};
