const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { validateTaskSpec } = require("../src/orchestration/delegation/task-spec");
const {
  CAPSULE_FIELDS,
  MAX_SUMMARY_CHARS,
  validateResultCapsule,
} = require("../src/orchestration/delegation/result-capsule");
const { evaluateChangedPaths } = require("../src/orchestration/delegation/path-policy");
const { runDelegatedTask } = require("../src/orchestration/delegation/delegation-runner");
const { verifyCapsule } = require("../src/orchestration/delegation/verifier");
const { changedPaths, headSha } = require("../src/orchestration/delegation/git-workspace");
const { createFakeCodexRuntime } = require("./helpers/fake-codex-runtime");

// realpathSync.native matches the existing fixture idiom in this repo: the CI
// runner's TEMP is an 8.3 short path, and an uncanonicalised spelling breaks
// path containment comparisons.
function tempRoot() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delegation-")));
}

// A real single-commit git repo, so changedPaths() is exercised against real
// git output rather than a stub that could agree with a wrong assumption.
function makeWorkspace(base) {
  const dir = path.join(base, "workspace");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "core"), { recursive: true });

  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  // Keeps the fixture's diff output free of CRLF-conversion warnings, which
  // would otherwise drown the real test output on a Windows runner.
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, "docs", "notes.md"), "baseline\n");
  fs.writeFileSync(path.join(dir, "src", "core", "app.js"), "// baseline\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  return { dir, baseSha: git(["rev-parse", "HEAD"]) };
}

function makeSpec(workspace, baseSha, overrides = {}) {
  return {
    task_id: "canary-docs-note",
    objective: "Append one line to docs/notes.md",
    allowed_paths: ["docs"],
    forbidden_paths: ["src"],
    workspace,
    base_sha: baseSha,
    acceptance_tests: [{ name: "notes-present", command: "node", args: ["--version"] }],
    timeout_ms: 5000,
    approval_policy: "never",
    ...overrides,
  };
}

const passingTestRunner = ({ test: acceptanceTest }) => ({
  name: acceptanceTest.name,
  passed: true,
  exit_code: 0,
});

const failingTestRunner = ({ test: acceptanceTest }) => ({
  name: acceptanceTest.name,
  passed: false,
  exit_code: 1,
});

const realGit = { changedPaths, headSha };

// --- Phase A: protocol validation -----------------------------------------

test("task spec is fail-closed: unknown approval policy and escaping paths are rejected", () => {
  const base = makeSpec("C:/workspace", "a".repeat(40));

  assert.equal(validateTaskSpec(base).ok, true);

  const badPolicy = validateTaskSpec({ ...base, approval_policy: "auto" });
  assert.equal(badPolicy.ok, false);
  assert.ok(badPolicy.errors.some((error) => error.includes("approval_policy")));

  const escaping = validateTaskSpec({ ...base, allowed_paths: ["../outside"] });
  assert.equal(escaping.ok, false);
  assert.ok(escaping.errors.some((error) => error.includes("..")));

  const absolute = validateTaskSpec({ ...base, allowed_paths: ["/etc"] });
  assert.equal(absolute.ok, false);

  const emptyAllowlist = validateTaskSpec({ ...base, allowed_paths: [] });
  assert.equal(emptyAllowlist.ok, false);

  for (const field of ["task_id", "base_sha", "timeout_ms", "approval_policy"]) {
    const missing = { ...base };
    delete missing[field];
    const result = validateTaskSpec(missing);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.ok(result.errors.some((error) => error.includes(`missing field: ${field}`)));
  }
});

test("forbidden_paths beats allowed_paths and case tricks do not escape on Windows", () => {
  const workspace = path.resolve("C:/ws");
  const evaluate = (changed) => evaluateChangedPaths({
    workspace,
    allowedPaths: ["docs", "src"],
    forbiddenPaths: ["src/core"],
    changedPaths: changed,
  });

  assert.equal(evaluate(["docs/notes.md"]).ok, true);

  const denied = evaluate(["src/core/app.js"]);
  assert.equal(denied.ok, false);
  assert.equal(denied.violations[0].reason, "forbidden_path");

  const unlisted = evaluate(["package.json"]);
  assert.equal(unlisted.ok, false);
  assert.equal(unlisted.violations[0].reason, "not_allowed");

  const escaped = evaluate(["../secrets.env"]);
  assert.equal(escaped.ok, false);
  assert.equal(escaped.violations[0].reason, "outside_workspace");

  // On a case-insensitive filesystem SRC/CORE names the same file as src/core,
  // so the deny rule has to survive the re-spelling.
  if (process.platform === "win32" || process.platform === "darwin") {
    const recased = evaluate(["SRC/CORE/app.js"]);
    assert.equal(recased.ok, false);
    assert.equal(recased.violations[0].reason, "forbidden_path");
  }
});

// --- Phase B, case 5: capsule schema is fail-closed ------------------------

test("result capsule missing a required field is rejected", () => {
  const capsule = {
    task_id: "canary-docs-note",
    status: "completed",
    summary: "done",
    files_changed: ["docs/notes.md"],
    tests: [{ name: "notes-present", passed: true, exit_code: 0 }],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
  };
  assert.equal(validateResultCapsule(capsule).ok, true);

  for (const field of CAPSULE_FIELDS) {
    const missing = { ...capsule };
    delete missing[field];
    const result = validateResultCapsule(missing);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.ok(result.errors.some((error) => error.includes(`missing field: ${field}`)));
  }

  const unknownField = validateResultCapsule({ ...capsule, extra: "nope" });
  assert.equal(unknownField.ok, false);
});

// --- Phase B, case 6: transcript never reaches the orchestrator ------------

test("a capsule carrying raw transcript is rejected, at top level and when nested", () => {
  const capsule = {
    task_id: "canary-docs-note",
    status: "completed",
    summary: "done",
    files_changed: [],
    tests: [{ name: "notes-present", passed: true, exit_code: 0 }],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
  };

  for (const key of ["transcript", "messages", "rawOutput", "stdout", "conversation"]) {
    const leaky = { ...capsule, [key]: "user: hi\nassistant: hello" };
    const result = validateResultCapsule(leaky);
    assert.equal(result.ok, false, `${key} must be refused`);
    assert.ok(result.errors.some((error) => error.includes("raw process output")));
  }

  const nested = {
    ...capsule,
    tests: [{ name: "notes-present", passed: true, exit_code: 0, transcript: "...." }],
  };
  const nestedResult = validateResultCapsule(nested);
  assert.equal(nestedResult.ok, false);
  assert.ok(nestedResult.errors.some((error) => error.includes("tests[0].transcript")));
});

// --- Phase B, case 1: legal task succeeds ---------------------------------

test("a legal task produces an accepted capsule and touches only allowed paths", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "docs/notes.md", content: "baseline\nappended by the sub-agent\n" }],
      summary: "appended one line to docs/notes.md",
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: passingTestRunner });

    assert.equal(capsule.status, "completed");
    assert.equal(capsule.recommended_action, "accept");
    assert.deepEqual(capsule.files_changed, ["docs/notes.md"]);
    assert.equal(capsule.tests.length, 1);
    assert.equal(capsule.tests[0].passed, true);

    // The capsule carries conclusions only -- no extra keys can ride along.
    assert.deepEqual(Object.keys(capsule).sort(), [...CAPSULE_FIELDS].sort());

    const verdict = verifyCapsule({
      spec,
      capsule,
      observedChangedPaths: changedPaths({ workspace: dir, baseSha }),
    });
    assert.equal(verdict.decision, "accept");
    assert.deepEqual(verdict.reasons, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- Phase B, case 2: out-of-bounds write is rejected ---------------------

test("writing outside allowed_paths is rejected and acceptance tests never run", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    let testsRun = 0;
    const countingRunner = (args) => {
      testsRun += 1;
      return passingTestRunner(args);
    };

    const runtime = createFakeCodexRuntime({
      writes: [
        { path: "docs/notes.md", content: "baseline\nlegit\n" },
        { path: "src/core/app.js", content: "// tampered\n" },
      ],
      summary: "did more than it was asked to",
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: countingRunner });

    assert.equal(capsule.status, "rejected");
    assert.equal(capsule.recommended_action, "stop");
    assert.equal(testsRun, 0, "tests must not run once the boundary is broken");
    assert.ok(capsule.risks.some((risk) => risk.includes("src/core/app.js")));

    const verdict = verifyCapsule({
      spec,
      capsule,
      observedChangedPaths: changedPaths({ workspace: dir, baseSha }),
    });
    assert.equal(verdict.decision, "stop");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a brand new untracked file outside the allowlist is still caught", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "src/core/sneaky-new-file.js", content: "// never committed\n" }],
      summary: "created a new file",
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: passingTestRunner });

    assert.equal(capsule.status, "rejected");
    assert.ok(capsule.files_changed.includes("src/core/sneaky-new-file.js"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- Phase B, case 3: failing acceptance test -> rework -------------------

test("a failing acceptance test yields rework, not accept", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "docs/notes.md", content: "baseline\nchanged\n" }],
      summary: "changed the note but broke the test",
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: failingTestRunner });

    assert.equal(capsule.status, "failed");
    assert.equal(capsule.recommended_action, "rework");
    assert.equal(capsule.commit_sha, null);

    const verdict = verifyCapsule({
      spec,
      capsule,
      observedChangedPaths: changedPaths({ workspace: dir, baseSha }),
    });
    assert.equal(verdict.decision, "rework");
    assert.ok(verdict.reasons.some((reason) => reason.includes("notes-present")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- Phase B, case 4: timeout / cancel -----------------------------------

test("a hanging run times out, is cancelled, and stops the loop", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha, { timeout_ms: 50 });
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "docs/notes.md", content: "baseline\npartial\n" }],
      hang: true,
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: passingTestRunner });

    assert.equal(capsule.status, "timed_out");
    assert.equal(capsule.recommended_action, "stop");
    assert.equal(runtime.calls.cancel, 1, "timeout must ask the runtime to cancel");
    assert.ok(capsule.risks.some((risk) => risk.includes("partial edits")));

    const verdict = verifyCapsule({
      spec,
      capsule,
      observedChangedPaths: changedPaths({ workspace: dir, baseSha }),
    });
    assert.equal(verdict.decision, "stop");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- Phase B, case 6 (runner side): oversized output cannot ride along ----

test("an oversized runtime summary is truncated instead of leaking into the capsule", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "docs/notes.md", content: "baseline\nok\n" }],
      summary: `BEGIN TRANSCRIPT ${"x".repeat(50000)} END TRANSCRIPT`,
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: passingTestRunner });

    assert.ok(capsule.summary.length <= MAX_SUMMARY_CHARS);
    assert.ok(capsule.summary.endsWith("[truncated]"));
    assert.ok(capsule.risks.some((risk) => risk.includes("truncated")));
    assert.equal(validateResultCapsule(capsule).ok, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- Verifier does not take the capsule's word ---------------------------

test("verifier stops a capsule whose file list disagrees with the observed diff", async () => {
  const base = tempRoot();
  try {
    const { dir, baseSha } = makeWorkspace(base);
    const spec = makeSpec(dir, baseSha);
    const runtime = createFakeCodexRuntime({
      writes: [{ path: "docs/notes.md", content: "baseline\nreal change\n" }],
      summary: "one file",
    });

    const capsule = await runDelegatedTask({ spec, runtime, git: realGit, testRunner: passingTestRunner });

    // The run was clean, but the orchestrator observes a diff the capsule did
    // not declare -- e.g. a concurrent write, or a dishonest report.
    const verdict = verifyCapsule({
      spec,
      capsule,
      observedChangedPaths: ["docs/notes.md", "src/core/app.js"],
    });
    assert.equal(verdict.decision, "stop");

    const mismatch = verifyCapsule({
      spec,
      capsule: { ...capsule, task_id: "some-other-task" },
      observedChangedPaths: ["docs/notes.md"],
    });
    assert.equal(mismatch.decision, "stop");

    const unverifiable = verifyCapsule({ spec, capsule, observedChangedPaths: undefined });
    assert.equal(unverifiable.decision, "stop");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
