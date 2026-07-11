const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ContinuityPipeline, createCandidate } = require("../src/continuity/continuity-pipeline");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

test("exceptional re-review targets one previously decided candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase4-review-"));
  const conversationDir = path.join(root, "conversations");
  const sourceFile = path.join(conversationDir, "2026-07-11.jsonl");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(sourceFile, '{"type":"user","text":"fixture"}\n', "utf8");
  const pipeline = new ContinuityPipeline({
    continuityDir: path.join(root, "continuity"),
    conversationDir,
    writerLeaseFile: path.join(root, "writer-lease.json"),
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    worktree: root,
    branch: "phase4-fixture",
    baseSha: "a".repeat(40),
  });
  const candidates = ["first", "second"].map((body) => createCandidate({
    date: "2026-07-11", type: "episode", author: "closeout", body,
    sourceRef: { file: sourceFile, window: "1-1" },
  }));
  appendJsonlUnique(pipeline.paths.candidates, candidates, "candidate_id");
  pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "defer" } });

  const result = pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
    retryCandidateId: candidates[0].candidate_id,
  });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].candidate_id, candidates[0].candidate_id);
  assert.equal(result.decisions[0].result, "accepted");
  const decisions = readJsonl(pipeline.paths.decisions);
  assert.equal(decisions.filter((row) => row.candidate_id === candidates[0].candidate_id).length, 2);
  assert.equal(decisions.filter((row) => row.candidate_id === candidates[1].candidate_id).length, 1);
});
