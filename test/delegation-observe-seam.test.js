"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { observeRoute1ChangedPaths } = require("../src/adapters/runtime/claudecode/route1-runtime-seam");
const { verifyCapsule } = require("../src/orchestration/delegation/verifier");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-observe-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "item.js"), "module.exports = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "note.md"), "base\n", "utf8");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Observe Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha };
}

function spec(root, baseSha) {
  return {
    task_id: "observe-seam-fixture",
    objective: "Change only bounded source files.",
    allowed_paths: ["src"],
    forbidden_paths: [path.join(path.dirname(root), "live-memory")],
    workspace: root,
    base_sha: baseSha,
    acceptance_tests: [{ name: "source check", command: "node", args: ["--check", "src/item.js"] }],
    timeout_ms: 5_000,
    approval_policy: "never",
  };
}

function capsule(filesChanged) {
  return {
    task_id: "observe-seam-fixture",
    status: "completed",
    summary: "Fixture claim.",
    files_changed: filesChanged,
    tests: [{ name: "source check", passed: true, exit_code: 0 }],
    commit_sha: null,
    risks: [],
    recommended_action: "accept",
  };
}

test("T10-A A6 orchestrator observes git only after worker completion and distrusts capsule files", () => {
  const { root, baseSha } = fixture();
  try {
    const events = [];
    fs.writeFileSync(path.join(root, "src", "item.js"), "module.exports = 2;\n", "utf8");
    events.push("worker-finished");
    const observedChangedPaths = observeRoute1ChangedPaths({ spec: spec(root, baseSha) });
    events.push("orchestrator-observed");
    const verdict = verifyCapsule({
      spec: spec(root, baseSha),
      capsule: capsule([]),
      observedChangedPaths,
      allowAbsoluteForbiddenPaths: true,
    });
    events.push("verified");
    assert.deepEqual(events, ["worker-finished", "orchestrator-observed", "verified"]);
    assert.deepEqual(observedChangedPaths, ["src/item.js"]);
    assert.equal(verdict.decision, "stop");
    assert.match(verdict.reasons[0], /does not match the observed diff/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T10-A A6/A8 observed boundary stops before acceptance despite a passing self-report", () => {
  const { root, baseSha } = fixture();
  try {
    fs.writeFileSync(path.join(root, "docs", "note.md"), "outside allowlist\n", "utf8");
    const taskSpec = spec(root, baseSha);
    const observedChangedPaths = observeRoute1ChangedPaths({ spec: taskSpec });
    const verdict = verifyCapsule({
      spec: taskSpec,
      capsule: capsule(["docs/note.md"]),
      observedChangedPaths,
      allowAbsoluteForbiddenPaths: true,
    });
    assert.equal(verdict.decision, "stop");
    assert.match(verdict.reasons[0], /observed path boundary violation \(not_allowed\)/);
    assert.equal(verdict.reasons.some((reason) => /acceptance tests/.test(reason)), false,
      "boundary rejection precedes acceptance-test evaluation");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
