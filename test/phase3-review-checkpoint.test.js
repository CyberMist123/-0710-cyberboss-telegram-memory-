const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runReviewCheckpointed } = require("../src/continuity/review-checkpoint");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

test("checkpoint preserves completed decisions when a later candidate is interrupted", () => {
  const fixture = createFixture(["cand-1", "cand-2"]);
  const calls = [];
  const pipeline = {
    paths: fixture.paths,
    runReview({ retryCandidateId }) {
      calls.push(retryCandidateId);
      if (retryCandidateId === "cand-2") throw new Error("fixture interruption");
      const decision = createDecision(retryCandidateId);
      const added = appendJsonlUnique(fixture.paths.decisions, [decision], "decision_id");
      return { status: "success", decisions: added };
    },
  };

  assert.throws(() => runReviewCheckpointed(pipeline), /fixture interruption/);
  assert.deepEqual(calls, ["cand-1", "cand-2"]);
  assert.deepEqual(readJsonl(fixture.paths.decisions), [createDecision("cand-1")]);
});

test("rerun skips completed candidates and remains idempotent", () => {
  const fixture = createFixture(["cand-1", "cand-2", "cand-3"]);
  appendJsonlUnique(fixture.paths.decisions, [createDecision("cand-1")], "decision_id");
  const calls = [];
  const pipeline = {
    paths: fixture.paths,
    runReview({ retryCandidateId }) {
      calls.push(retryCandidateId);
      const decision = createDecision(retryCandidateId);
      const added = appendJsonlUnique(fixture.paths.decisions, [decision], "decision_id");
      return { status: "success", decisions: added };
    },
  };

  const first = runReviewCheckpointed(pipeline);
  assert.equal(first.status, "success");
  assert.deepEqual(calls, ["cand-2", "cand-3"]);
  assert.equal(first.decisions.length, 2);
  assert.equal(readJsonl(fixture.paths.decisions).length, 3);

  const second = runReviewCheckpointed(pipeline);
  assert.equal(second.status, "success");
  assert.equal(second.decisions.length, 0);
  assert.deepEqual(calls, ["cand-2", "cand-3"]);
  assert.equal(readJsonl(fixture.paths.decisions).length, 3);
});

test("explicit candidate retry delegates exactly one candidate", () => {
  let received = null;
  const expected = { status: "success", decisions: [createDecision("cand-2")] };
  const pipeline = {
    paths: { candidates: "unused", decisions: "unused" },
    runReview(options) {
      received = options;
      return expected;
    },
  };

  const result = runReviewCheckpointed(pipeline, { retryCandidateId: " cand-2 " });
  assert.equal(result, expected);
  assert.deepEqual(received, { retryCandidateId: "cand-2" });
});

function createFixture(candidateIds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-checkpoint-"));
  const paths = {
    candidates: path.join(root, "candidates", "episodes.candidates.jsonl"),
    decisions: path.join(root, "decisions", "decisions.jsonl"),
  };
  appendJsonlUnique(paths.candidates, candidateIds.map((candidateId) => ({
    candidate_id: candidateId,
    type: "episode",
    body: `fixture ${candidateId}`,
  })), "candidate_id");
  return { root, paths };
}

function createDecision(candidateId) {
  return {
    decision_id: `decision-${candidateId}`,
    candidate_id: candidateId,
    result: "accepted",
    reason: "fixture",
    checks: {},
  };
}
