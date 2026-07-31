const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ContinuityPipeline, createCandidate } = require("../src/continuity/continuity-pipeline");
const { runReviewCheckpointed } = require("../src/continuity/review-checkpoint");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

const SUBJECT_AI_METADATA = {
  origin: "live_closeout",
  authorRole: "subject_ai",
  authorModel: "fixture-subject-ai",
  contextScope: "active_session",
  semanticAuthority: "high",
  needsSubjectReview: false,
};

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

test("checkpoint authority gate defers extractors before review and reruns byte-identically", () => {
  const fixture = createFullLoopFixture();
  const { pipeline } = fixture;

  const reviewed = runReviewCheckpointed(pipeline);
  assert.equal(reviewed.status, "success");
  assert.equal(reviewed.authority_deferred, 1);
  assert.equal(reviewed.model_eligible, 2);

  const decisions = readJsonl(pipeline.paths.decisions);
  assert.deepEqual(
    decisions.map((item) => item.result),
    ["accepted", "deferred", "deferred"],
  );
  assert.equal(decisions[1].reason, "semantic_authority_missing");
  assert.equal(decisions[1].checks.publication_allowed, false);

  const firstWrite = pipeline.runHistoryWriter();
  assert.equal(firstWrite.status, "success");
  assert.equal(firstWrite.written.length, 1);

  const episodes = readJsonl(pipeline.paths.episodes);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].body, "accepted fixture memory");

  const writerState = JSON.parse(fs.readFileSync(pipeline.paths.writerState, "utf8"));
  assert.equal(writerState.applied_decision_ids.length, 1);

  const before = snapshotDirectory(fixture.continuityDir);

  const secondReview = runReviewCheckpointed(pipeline);
  const secondWrite = pipeline.runHistoryWriter();
  assert.equal(secondReview.status, "success");
  assert.equal(secondReview.decisions.length, 0);
  assert.equal(secondWrite.status, "success");
  assert.equal(secondWrite.written.length, 0);
  assert.deepEqual(snapshotDirectory(fixture.continuityDir), before);
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

  writeReviewFixture(reviewScript, false);

  const pipeline = createPipeline({ root, continuityDir, conversationDir, reviewScript });
  const candidates = [
    createCandidate({
      date: "2026-07-11",
      type: "episode",
      author: "closeout",
      ...SUBJECT_AI_METADATA,
      body: "first fixture candidate",
      sourceRef: { file: conversationFile, window: "1-2" },
    }),
    createCandidate({
      date: "2026-07-11",
      type: "episode",
      author: "closeout",
      ...SUBJECT_AI_METADATA,
      body: "second fixture candidate",
      sourceRef: { file: conversationFile, window: "1-2" },
    }),
  ];

  appendJsonlUnique(pipeline.paths.candidates, candidates, "candidate_id");
  return { root, continuityDir, pipeline, candidates };
}

function createFullLoopFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-full-memory-loop-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-12.jsonl");
  const reviewScript = path.join(root, "review_fixture.py");

  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(
    conversationFile,
    [
      JSON.stringify({ type: "user", text: "first source line" }),
      JSON.stringify({ type: "assistant", text: "second source line" }),
      JSON.stringify({ type: "user", text: "third source line" }),
    ].join("\n") + "\n",
    "utf8",
  );

  writeReviewFixture(reviewScript, true);
  const pipeline = createPipeline({ root, continuityDir, conversationDir, reviewScript });
  const candidates = [
    createCandidate({
      date: "2026-07-12",
      type: "episode",
      author: "closeout",
      ...SUBJECT_AI_METADATA,
      body: "accepted fixture memory",
      sourceRef: { file: conversationFile, window: "1-1" },
    }),
    createCandidate({
      date: "2026-07-12",
      type: "episode",
      author: "janitor",
      body: "accepted fixture memory",
      sourceRef: { file: conversationFile, window: "2-2" },
    }),
    createCandidate({
      date: "2026-07-12",
      type: "episode",
      author: "closeout",
      ...SUBJECT_AI_METADATA,
      body: "defer fixture memory",
      sourceRef: { file: conversationFile, window: "3-3" },
    }),
  ];

  appendJsonlUnique(pipeline.paths.candidates, candidates, "candidate_id");
  return { root, continuityDir, pipeline, candidates };
}

function createPipeline({ root, continuityDir, conversationDir, reviewScript }) {
  return new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "writer-lease.json"),
    reviewScript,
    python: process.env.PYTHON || "python",
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
    reviewArtifactsEnabled: true,
  });
}

function writeReviewFixture(reviewScript, deferByBody) {
  const bodyDecision = deferByBody
    ? [
      "body = str(candidate.get('body') or '')",
      "deferred = 'defer fixture' in body",
      "result = 'deferred' if deferred else 'accepted'",
      "reason = 'fixture_defer' if deferred else 'fixture_accept'",
    ]
    : [
      "result = 'accepted'",
      "reason = 'fixture_accept'",
    ];

  fs.writeFileSync(
    reviewScript,
    [
      "import json",
      "import sys",
      "payload = json.load(sys.stdin)",
      "candidate = payload.get('candidate') or {}",
      ...bodyDecision,
      "print(json.dumps({",
      "    'result': result,",
      "    'reason': reason,",
      "    'checks': {'safety_ok': True},",
      "}))",
    ].join("\n") + "\n",
    "utf8",
  );
}

function snapshotDirectory(root) {
  if (!fs.existsSync(root)) return {};
  const snapshot = {};
  walk(root, root, snapshot);
  return snapshot;
}

function walk(root, current, snapshot) {
  for (const name of fs.readdirSync(current).sort()) {
    const fullPath = path.join(current, name);
    const relative = path.relative(root, fullPath).replaceAll("\\", "/");
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walk(root, fullPath, snapshot);
    } else {
      snapshot[relative] = fs.readFileSync(fullPath).toString("base64");
    }
  }
}
