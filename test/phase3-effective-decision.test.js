const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ContinuityPipeline,
  createDecision,
} = require("../src/continuity/continuity-pipeline");
const {
  EFFECTIVE_DECISION_AMBIGUOUS,
  selectEffectiveDecisions,
} = require("../src/continuity/effective-decision");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

const REVIEW_SCRIPT = path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py");

const SUBJECT_AI = {
  type: "episode",
  author: "subject_ai",
  origin: "live_closeout",
  author_role: "subject_ai",
  author_model: "fixture-subject-ai",
  context_scope: "active_session",
  semantic_authority: "high",
  needs_subject_review: false,
};

test("Review retry appends a new revision that supersedes the effective head", () => {
  const fixture = createFixture("retry-chain");
  const first = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
  }).decisions[0];
  const second = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
    retryCandidateId: fixture.candidate.candidate_id,
  }).decisions[0];

  assert.equal(first.review_revision, 1);
  assert.equal(first.supersedes_decision_id, null);
  assert.equal(second.review_revision, 2);
  assert.equal(second.supersedes_decision_id, first.decision_id);
  assert.notEqual(second.decision_id, first.decision_id);
  assert.equal(readJsonl(fixture.pipeline.paths.decisions).length, 2);
});

test("accepted then rejected leaves the old accepted decision unpublished", () => {
  const fixture = createFixture("accept-reject");
  const accepted = decision(fixture.candidate, "accepted", "accepted-first", 1);
  const rejected = decision(fixture.candidate, "rejected", "rejected-latest", 2, accepted.decision_id);
  appendJsonlUnique(fixture.pipeline.paths.decisions, [accepted], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  appendJsonlUnique(fixture.pipeline.paths.decisions, [rejected], "decision_id");

  const result = fixture.pipeline.runHistoryWriter();
  assert.equal(result.written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
  assert.equal(selectEffectiveDecisions([accepted, rejected]).effectiveByCandidate.get(fixture.candidate.candidate_id).result, "rejected");
});

test("rejected then accepted publishes once, and a later same-result revision is not deduplicated", () => {
  const fixture = createFixture("reject-accept");
  const rejected = decision(fixture.candidate, "rejected", "safety_failed", 1);
  const accepted = decision(fixture.candidate, "accepted", "accepted-second", 2, rejected.decision_id);
  appendJsonlUnique(fixture.pipeline.paths.decisions, [rejected, accepted], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);

  assert.deepEqual(fixture.pipeline.runHistoryWriter().written, [accepted.decision_id]);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);

  const acceptedAgain = decision(fixture.candidate, "accepted", "accepted-after-recheck", 3, accepted.decision_id);
  appendJsonlUnique(fixture.pipeline.paths.decisions, [acceptedAgain], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  assert.notEqual(acceptedAgain.decision_id, accepted.decision_id);
  const replay = fixture.pipeline.runHistoryWriter();
  assert.equal(replay.written.length, 0);
  assert.deepEqual(replay.skipped, [{
    decision_id: acceptedAgain.decision_id,
    reason: "candidate_already_published",
  }]);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);

  const state = JSON.parse(fs.readFileSync(fixture.pipeline.paths.writerState, "utf8"));
  assert.deepEqual(state.published_candidate_ids, [fixture.candidate.candidate_id]);
  assert.deepEqual(state.applied_decision_ids, [accepted.decision_id, acceptedAgain.decision_id]);
});

test("legacy decisions are revision 1, while forks and cycles have no effective decision", () => {
  const legacy = { decision_id: "legacy", candidate_id: "cand-legacy", result: "accepted" };
  const forkRoot = { decision_id: "fork-root", candidate_id: "cand-fork", result: "rejected" };
  const forkA = { decision_id: "fork-a", candidate_id: "cand-fork", review_revision: 2, supersedes_decision_id: "fork-root", result: "accepted" };
  const forkB = { decision_id: "fork-b", candidate_id: "cand-fork", review_revision: 3, supersedes_decision_id: "fork-root", result: "accepted" };
  const cycleA = { decision_id: "cycle-a", candidate_id: "cand-cycle", review_revision: 1, supersedes_decision_id: "cycle-b", result: "accepted" };
  const cycleB = { decision_id: "cycle-b", candidate_id: "cand-cycle", review_revision: 2, supersedes_decision_id: "cycle-a", result: "accepted" };

  const selected = selectEffectiveDecisions([legacy, forkRoot, forkA, forkB, cycleA, cycleB]);
  assert.equal(selected.effectiveByCandidate.get("cand-legacy").review_revision, 1);
  assert.equal(selected.effectiveByCandidate.get("cand-legacy").supersedes_decision_id, null);
  assert.equal(selected.effectiveByCandidate.has("cand-fork"), false);
  assert.equal(selected.effectiveByCandidate.has("cand-cycle"), false);
  assert.match(selected.ambiguous.find((item) => item.candidate_id === "cand-fork").reasons.join(" "), /decision_fork|head_not_unique/);
  assert.match(selected.ambiguous.find((item) => item.candidate_id === "cand-cycle").reasons.join(" "), /decision_cycle/);
});

test("missing, cross-candidate, and non-increasing predecessors fail closed", () => {
  const rows = [
    { decision_id: "a-root", candidate_id: "cand-a", result: "rejected" },
    { decision_id: "b-cross", candidate_id: "cand-b", review_revision: 2, supersedes_decision_id: "a-root", result: "accepted" },
    { decision_id: "c-missing", candidate_id: "cand-c", review_revision: 2, supersedes_decision_id: "missing", result: "accepted" },
    { decision_id: "d-root", candidate_id: "cand-d", review_revision: 3, supersedes_decision_id: null, result: "rejected" },
    { decision_id: "d-back", candidate_id: "cand-d", review_revision: 2, supersedes_decision_id: "d-root", result: "accepted" },
    { decision_id: "e-root", candidate_id: "cand-e", review_revision: 2, supersedes_decision_id: null, result: "accepted" },
  ];
  const selected = selectEffectiveDecisions(rows);

  assert.equal(selected.effectiveByCandidate.get("cand-a").decision_id, "a-root");
  assert.match(eventFor(selected, "cand-b").reasons.join(" "), /predecessor_cross_candidate/);
  assert.match(eventFor(selected, "cand-c").reasons.join(" "), /predecessor_missing/);
  assert.match(eventFor(selected, "cand-d").reasons.join(" "), /review_revision_not_increasing/);
  assert.match(eventFor(selected, "cand-e").reasons.join(" "), /root_revision_not_one/);
});

test("History persists one stable ambiguity event and publishes neither fork nor cycle", () => {
  const fixture = createFixture("ambiguous-events", ["cand-fork", "cand-cycle"]);
  const rows = [
    { decision_id: "fork-root", candidate_id: "cand-fork", result: "rejected" },
    { decision_id: "fork-a", candidate_id: "cand-fork", review_revision: 2, supersedes_decision_id: "fork-root", result: "accepted" },
    { decision_id: "fork-b", candidate_id: "cand-fork", review_revision: 3, supersedes_decision_id: "fork-root", result: "accepted" },
    { decision_id: "cycle-a", candidate_id: "cand-cycle", review_revision: 1, supersedes_decision_id: "cycle-b", result: "accepted" },
    { decision_id: "cycle-b", candidate_id: "cand-cycle", review_revision: 2, supersedes_decision_id: "cycle-a", result: "accepted" },
  ];
  appendJsonlUnique(fixture.pipeline.paths.decisions, rows, "decision_id");

  const first = fixture.pipeline.runHistoryWriter();
  assert.equal(first.written.length, 0);
  assert.equal(first.diagnostics.length, 2);
  assert.ok(first.diagnostics.every((item) => item.event === EFFECTIVE_DECISION_AMBIGUOUS));
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
  const before = fs.readFileSync(fixture.pipeline.paths.writerState, "utf8");
  const state = JSON.parse(before);
  assert.equal(state.diagnostic_events.length, 2);

  const second = fixture.pipeline.runHistoryWriter();
  assert.equal(second.written.length, 0);
  assert.equal(second.diagnostics.length, 2);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.writerState, "utf8"), before);
});

test("History crash after canon append retries without a duplicate publication", () => {
  const fixture = createFixture("history-crash");
  const accepted = decision(fixture.candidate, "accepted", "fixture", 1);
  appendJsonlUnique(fixture.pipeline.paths.decisions, [accepted], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  const realPublish = fixture.pipeline.publishEpisode.bind(fixture.pipeline);
  fixture.pipeline.publishEpisode = (candidate, reviewDecision, intent) => {
    realPublish(candidate, reviewDecision, intent);
    throw new Error("fixture crash after canon append");
  };

  assert.throws(() => fixture.pipeline.runHistoryWriter(), /fixture crash/);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
  fixture.pipeline.publishEpisode = realPublish;

  const replay = fixture.pipeline.runHistoryWriter();
  assert.equal(replay.written.length, 0);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
  const state = JSON.parse(fs.readFileSync(fixture.pipeline.paths.writerState, "utf8"));
  assert.deepEqual(state.published_candidate_ids, [fixture.candidate.candidate_id]);
});

function decision(candidate, result, reason, reviewRevision, supersedesDecisionId = null) {
  return createDecision(candidate, {
    result,
    reason,
    checks: { publication_allowed: true },
    review_revision: reviewRevision,
    supersedes_decision_id: supersedesDecisionId,
  });
}

function eventFor(selected, candidateId) {
  return selected.ambiguous.find((item) => item.candidate_id === candidateId);
}

function createFixture(label, candidateIds = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `issue73-${label}-`));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-30.jsonl");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(conversationFile, '{"type":"user","text":"fixture"}\n', "utf8");
  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "writer-lease.json"),
    reviewScript: REVIEW_SCRIPT,
    python: process.env.PYTHON || "python",
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
    reviewArtifactsEnabled: true,
  });
  const ids = candidateIds.length ? candidateIds : [`cand-${label}`];
  const candidates = ids.map((candidateId) => ({
    candidate_id: candidateId,
    ts: "2026-07-30T12:00:00+10:00",
    ...SUBJECT_AI,
    body: `fixture ${candidateId}`,
    source_ref: { file: conversationFile, window: "1-1" },
    subject_route: exactSubjectRoute(),
    idempotency_key: `key-${candidateId}`,
  }));
  appendJsonlUnique(pipeline.paths.candidates, candidates, "candidate_id");
  return { root, pipeline, candidate: candidates[0], candidates };
}

function exactSubjectRoute() {
  return createSubjectRoute({
    version: 1,
    provider: "telegram",
    continuity_binding: {
      workspace_id: "workspace-fixture",
      account_id: "telegram",
      sender_id: "42",
      binding_key: "workspace-fixture:telegram:42",
    },
    route_lane: {
      lane_key: "v2|tg|8:telegram|4:-100|1:7",
      chat_id: "-100",
      message_thread_id: "7",
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: "slot-fixture",
      runtime_thread_id: "native-session-fixture",
      profile_id: "profile-fixture",
      profile_fingerprint: "profile-fingerprint-fixture",
      window_id: "native-session-fixture",
    },
    author_turn_id: "turn-fixture",
    source_entry_ids: ["entry-fixture"],
  });
}
