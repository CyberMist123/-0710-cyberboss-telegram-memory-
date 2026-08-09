const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ContinuityPipeline,
  createCandidate,
} = require("../src/continuity/continuity-pipeline");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-timeline-publish-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "fixture.jsonl");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(conversationFile, `${JSON.stringify({
    id: "fixture-entry",
    type: "user",
    timestamp: "2026-08-09T12:00:00Z",
    route: {
      bindingKey: "fixture-binding",
      laneKey: "fixture-lane",
      sessionSlotKey: "fixture-slot",
      messageThreadId: "fixture-thread",
      profileId: "fixture-profile",
      windowId: "fixture-window",
    },
    routeStatus: "RECORDED_EXACT",
    text: "虚构的 timeline 测试材料。",
  })}\n`, "utf8");
  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "writer.lease"),
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    worktree: root,
    baseSha: "0".repeat(40),
    reviewArtifactsEnabled: true,
  });
  return { root, pipeline, conversationFile };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function candidate(pipeline, conversationFile, type = "timeline") {
  return createCandidate({
    date: "2026-08-09",
    candidateTimestamp: "2026-08-09T12:00:00Z",
    type,
    author: "subject_ai",
    body: type === "timeline" ? "在虚构的测试窗口里，她提到想保留这件小事。" : "普通 Episode 测试正文。",
    sourceRef: { file: conversationFile, window: "1-1" },
    origin: "live_closeout",
    authorRole: "subject_ai",
    authorModel: "fixture-subject-ai",
    contextScope: "active_session",
    semanticAuthority: "high",
    needsSubjectReview: false,
  });
}

test("timeline accepted candidate appends one line with two markers and rerun is idempotent", () => {
  const value = fixture();
  try {
    const timeline = candidate(value.pipeline, value.conversationFile);
    appendJsonlUnique(value.pipeline.paths.candidates, [timeline], "candidate_id");
    const review = value.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
    assert.equal(review.decisions[0].result, "accepted");
    assert.equal(value.pipeline.runHistoryWriter().written.length, 1);
    const first = fs.readFileSync(value.pipeline.paths.relationshipTimeline, "utf8");
    assert.match(first, /<!-- publication:/u);
    assert.match(first, /<!-- decision:/u);
    assert.match(first, /- 2026-08-09 · 在虚构的测试窗口里/u);
    assert.equal(readJsonl(value.pipeline.paths.episodes).length, 0);
    assert.equal(value.pipeline.runHistoryWriter().written.length, 0);
    assert.equal(fs.readFileSync(value.pipeline.paths.relationshipTimeline, "utf8"), first);
    assert.equal((first.match(/<!-- publication:/gu) || []).length, 1);
    assert.equal((first.match(/<!-- decision:/gu) || []).length, 1);
  } finally {
    cleanup(value.root);
  }
});

test("non-timeline candidate does not enter relationship_timeline.md", () => {
  const value = fixture();
  try {
    const episode = candidate(value.pipeline, value.conversationFile, "episode");
    appendJsonlUnique(value.pipeline.paths.candidates, [episode], "candidate_id");
    value.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
    value.pipeline.runHistoryWriter();
    assert.equal(fs.existsSync(value.pipeline.paths.relationshipTimeline), false);
    assert.equal(readJsonl(value.pipeline.paths.episodes).length, 1);
  } finally {
    cleanup(value.root);
  }
});
