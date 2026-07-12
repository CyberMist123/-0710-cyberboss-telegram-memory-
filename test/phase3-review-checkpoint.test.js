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
  assert.equal(first.model_eligible, 2);
  assert.equal(first.authority_deferred, 0);
  assert.equal(readJsonl(fixture.paths.decisions).length, 3);

  const second = runReviewCheckpointed(pipeline);
  assert.equal(second.status, "success");
  assert.equal(second.decisions.length, 0);
  assert.deepEqual(calls, ["cand-2", "cand-3"]);
  assert.equal(readJsonl(fixture.paths.decisions).length, 3);
});

test("explicit candidate retry still passes through the checkpoint gate", () => {
  const fixture = createFixture(["cand-2"]);
  let received = null;
  const expectedDecision = createDecision("cand-2");
  const pipeline = {
    paths: fixture.paths,
    runReview(options) {
      received = options;
      const added = appendJsonlUnique(fixture.paths.decisions, [expectedDecision], "decision_id");
      return { status: "success", decisions: added };
    },
  };

  const result = runReviewCheckpointed(pipeline, { retryCandidateId: " cand-2 " });
  assert.equal(result.status, "success");
  assert.deepEqual(result.decisions, [expectedDecision]);
  assert.equal(result.model_eligible, 1);
  assert.equal(result.authority_deferred, 0);
  assert.deepEqual(received, { retryCandidateId: "cand-2" });
});

test("authority failures persist locally and never call semantic review", () => {
  const fixture = createFixtureFromRows([
    {
      candidate_id: "cand-legacy-janitor",
      type: "episode",
      author: "janitor",
      body: "旧 Janitor 提取器写出的解释。",
      source_ref: {},
    },
    {
      candidate_id: "cand-background-self-note",
      type: "self_note",
      author: "closeout",
      body: "后台代理不能替主体认领这段自述。",
      source_ref: {},
    },
  ]);
  let reviewCalls = 0;
  const pipeline = {
    paths: fixture.paths,
    withLease(_writer, fn) { return fn(); },
    runReview() {
      reviewCalls += 1;
      throw new Error("semantic review must not be called");
    },
  };

  const result = runReviewCheckpointed(pipeline);
  assert.equal(result.status, "success");
  assert.equal(result.model_eligible, 0);
  assert.equal(result.authority_deferred, 2);
  assert.equal(reviewCalls, 0);

  const decisions = readJsonl(fixture.paths.decisions);
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((item) => item.reason), [
    "semantic_authority_missing",
    "subject_review_required",
  ]);
  for (const decision of decisions) {
    assert.equal(decision.result, "deferred");
    assert.equal(decision.checks.publication_allowed, false);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, "body"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, "rewrite"), false);
  }

  const before = fs.readFileSync(fixture.paths.decisions, "utf8");
  const rerun = runReviewCheckpointed(pipeline);
  assert.equal(rerun.decisions.length, 0);
  assert.equal(fs.readFileSync(fixture.paths.decisions, "utf8"), before);
  assert.equal(reviewCalls, 0);
});

function createFixture(candidateIds) {
  return createFixtureFromRows(candidateIds.map((candidateId) => ({
    candidate_id: candidateId,
    type: "episode",
    body: `fixture ${candidateId}`,
  })));
}

function createFixtureFromRows(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-checkpoint-"));
  const paths = {
    candidates: path.join(root, "candidates", "episodes.candidates.jsonl"),
    decisions: path.join(root, "decisions", "decisions.jsonl"),
  };
  appendJsonlUnique(paths.candidates, rows, "candidate_id");
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
