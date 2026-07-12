const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ContinuityPipeline, createCandidate } = require("../src/continuity/continuity-pipeline");
const { runReviewCheckpointed } = require("../src/continuity/review-checkpoint");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

test("real pipeline persists the first decision, resumes after interruption, and stays idempotent", () => {
  const fixture = createFixture();
  const { pipeline, candidates } = fixture;
  const realRunReview = pipeline.runReview.bind(pipeline);
  let interrupted = false;

  pipeline.runReview = (options = {}) => {
    if (!interrupted && options.retryCandidateId === candidates[1].candidate_id) {
      interrupted = true;
      throw new Error("fixture interruption after first persisted decision");
    }
    return realRunReview(options);
  };

  assert.throws(
    () => runReviewCheckpointed(pipeline),
    /fixture interruption after first persisted decision/,
  );

  const afterInterruption = readJsonl(pipeline.paths.decisions);
  assert.equal(afterInterruption.length, 1);
  assert.equal(afterInterruption[0].candidate_id, candidates[0].candidate_id);
  assert.equal(afterInterruption[0].result, "accepted");

  pipeline.runReview = realRunReview;
  const resumed = runReviewCheckpointed(pipeline);
  assert.equal(resumed.status, "success");
  assert.equal(resumed.decisions.length, 1);
  assert.equal(resumed.decisions[0].candidate_id, candidates[1].candidate_id);

  const completed = readJsonl(pipeline.paths.decisions);
  assert.equal(completed.length, 2);
  assert.deepEqual(
    completed.map((item) => item.candidate_id),
    candidates.map((item) => item.candidate_id),
  );

  const thirdRun = runReviewCheckpointed(pipeline);
  assert.equal(thirdRun.status, "success");
  assert.equal(thirdRun.decisions.length, 0);
  assert.equal(readJsonl(pipeline.paths.decisions).length, 2);
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-checkpoint-integration-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-11.jsonl");
  const reviewScript = path.join(root, "review_fixture.py");

  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(
    conversationFile,
    [
      JSON.stringify({ type: "user", text: "fixture user" }),
      JSON.stringify({ type: "assistant", text: "fixture assistant" }),
    ].join("\n") + "\n",
    "utf8",
  );

  fs.writeFileSync(
    reviewScript,
    [
      "import json",
      "import sys",
      "payload = json.load(sys.stdin)",
      "candidate = payload.get('candidate') or {}",
      "print(json.dumps({",
      "    'result': 'accepted',",
      "    'reason': 'fixture_accept',",
      "    'checks': {'safety_ok': True},",
      "}))",
    ].join("\n") + "\n",
    "utf8",
  );

  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "writer-lease.json"),
    reviewScript,
    python: process.env.PYTHON || "python",
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
  });

  const candidates = [
    createCandidate({
      date: "2026-07-11",
      type: "episode",
      author: "closeout",
      body: "first fixture candidate",
      sourceRef: { file: conversationFile, window: "1-2" },
    }),
    createCandidate({
      date: "2026-07-11",
      type: "episode",
      author: "closeout",
      body: "second fixture candidate",
      sourceRef: { file: conversationFile, window: "1-2" },
    }),
  ];

  appendJsonlUnique(pipeline.paths.candidates, candidates, "candidate_id");
  return { root, pipeline, candidates };
}
