"use strict";

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
  analyzeCandidateLineages,
  STALE_INTENT_EVENT,
  publicationIntentId,
  publicationKey,
} = require("../src/continuity/publication-intent");
const {
  POST_PUBLISH_DECISION_CONFLICT,
} = require("../src/continuity/continuity-pipeline");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

const REVIEW_SCRIPT = path.resolve(
  __dirname,
  "../extensions/relationship-memory/memory-kit/auto_review.py",
);
const FIXED_TIME = "2026-07-31T05:06:07.000Z";

test("accepted Review revisions create stable intents and publish one canon row", () => {
  const fixture = createFixture("review-replay");
  const first = fixture.pipeline.runReview({ env: localReviewEnv() });
  const firstDecision = first.decisions[0];
  assert.equal(firstDecision.result, "accepted");
  assert.equal(first.publication_intent_complete, true);
  assert.equal(first.publication_intent_ids.length, 1);

  const second = fixture.pipeline.runReview({
    env: localReviewEnv(),
    retryCandidateId: fixture.candidate.candidate_id,
  });
  const secondDecision = second.decisions[0];
  const intentsBeforeHistory = readJsonl(fixture.pipeline.paths.publicationIntents);
  assert.equal(intentsBeforeHistory.length, 2);
  assert.equal(
    intentsBeforeHistory[0].publication_intent_id,
    publicationIntentId(fixture.candidate.candidate_id, firstDecision.decision_id),
  );
  assert.equal(intentsBeforeHistory[0].publication_key, publicationKey(fixture.candidate.candidate_id));
  assert.equal(intentsBeforeHistory[1].effective_decision_id, secondDecision.decision_id);
  const intentBytes = fs.readFileSync(fixture.pipeline.paths.publicationIntents, "utf8");

  const history = fixture.pipeline.runHistoryWriter();
  assert.deepEqual(history.written, [secondDecision.decision_id]);
  assert.equal(
    history.diagnostics.some((item) => item.event === STALE_INTENT_EVENT),
    true,
  );
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.publicationIntents, "utf8"), intentBytes);

  const replay = fixture.pipeline.runHistoryWriter();
  assert.equal(replay.written.length, 0);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
});

test("History crash after canon append recovers from canon without a duplicate", () => {
  const fixture = createFixture("history-crash");
  const decision = fixture.pipeline.runReview({ env: localReviewEnv() }).decisions[0];
  const realPublish = fixture.pipeline.publishEpisode.bind(fixture.pipeline);
  fixture.pipeline.publishEpisode = (candidate, effectiveDecision, intent) => {
    realPublish(candidate, effectiveDecision, intent);
    throw new Error("fixture crash after canon append");
  };

  assert.throws(() => fixture.pipeline.runHistoryWriter(), /fixture crash after canon append/u);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
  fixture.pipeline.publishEpisode = realPublish;

  const recovered = fixture.pipeline.runHistoryWriter();
  assert.equal(recovered.written.length, 0);
  assert.deepEqual(recovered.skipped, [{
    decision_id: decision.decision_id,
    reason: "candidate_already_published",
  }]);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
});

test("History writer-state replay reconstructs the publication key from canon", () => {
  const fixture = createFixture("state-replay");
  fixture.pipeline.runReview({ env: localReviewEnv() });
  fixture.pipeline.runHistoryWriter();
  const canonBefore = fs.readFileSync(fixture.pipeline.paths.episodes, "utf8");
  fs.unlinkSync(fixture.pipeline.paths.writerState);

  const replay = fixture.pipeline.runHistoryWriter();
  assert.equal(replay.written.length, 0);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.episodes, "utf8"), canonBefore);
  const state = JSON.parse(fs.readFileSync(fixture.pipeline.paths.writerState, "utf8"));
  assert.equal(state.applied_publication_keys.length, 1);
  assert.deepEqual(
    state.published_candidate_lineage_roots,
    [fixture.candidate.candidate_id],
  );
  assert.equal(state.intent_consumptions[0].status, "already_published");
});

// The cold start this pipeline was never run through: canon that predates the
// outbox. Rows written by the older mechanism carry `candidate_id` and
// `decision_id` but no `publication_key`, so a guard keyed on the key alone
// cannot see them. 2026-08-07 production evidence: the first time
// `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED` was enabled, two July episodes and one
// self-note were published into her canon a second time.
test("canon written before the outbox existed is still recognised as published", () => {
  const fixture = createFixture("legacy-canon");
  const decision = fixture.pipeline.runReview({ env: localReviewEnv() }).decisions[0];
  assert.equal(decision.result, "accepted");
  fixture.pipeline.runHistoryWriter();
  const canonRows = readJsonl(fixture.pipeline.paths.episodes);
  assert.equal(canonRows.length, 1);

  // Rewind to the legacy shape: the row is in canon, but it carries no
  // publication key, and neither the writer state nor the intent ledger
  // remembers it -- exactly the production starting position.
  const legacyRow = { ...canonRows[0] };
  delete legacyRow.publication_key;
  assert.equal(legacyRow.candidate_id, fixture.candidate.candidate_id);
  fs.writeFileSync(fixture.pipeline.paths.episodes, `${JSON.stringify(legacyRow)}\n`, "utf8");
  fs.rmSync(fixture.pipeline.paths.writerState, { force: true });
  fs.rmSync(fixture.pipeline.paths.publicationIntents, { force: true });

  // Review still mints an intent -- that ledger is the audit trail of what
  // Review decided, and suppressing it would hide the decision rather than
  // record that History declined it.
  const rereview = fixture.pipeline.runReview({
    env: localReviewEnv(),
    retryCandidateId: fixture.candidate.candidate_id,
  });
  assert.equal(rereview.publication_intent_complete, true);
  assert.equal(rereview.publication_intent_ids.length, 1);

  // History is where exactly-once has to hold. The publication key is gone from
  // the legacy row, so only the candidate-id side of the guard can catch this.
  const history = fixture.pipeline.runHistoryWriter();
  assert.equal(history.written.length, 0);
  assert.deepEqual(
    history.skipped.map((item) => item.reason),
    ["candidate_already_published"],
  );
  assert.equal(
    readJsonl(fixture.pipeline.paths.episodes).length,
    1,
    "canon must still hold exactly one copy",
  );
});

test("an accepted intent becomes stale when a later rejected decision supersedes it", () => {
  const fixture = createFixture("stale-decision");
  const accepted = fixture.pipeline.runReview({ env: localReviewEnv() }).decisions[0];
  const rejected = createDecision(fixture.candidate, {
    result: "rejected",
    reason: "safety_failed",
    checks: { publication_allowed: true, safety_ok: false },
    review_revision: 2,
    supersedes_decision_id: accepted.decision_id,
  });
  appendJsonlUnique(fixture.pipeline.paths.decisions, [rejected], "decision_id");

  const history = fixture.pipeline.runHistoryWriter();
  assert.equal(history.written.length, 0);
  assert.equal(history.diagnostics[0].event, STALE_INTENT_EVENT);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
  const state = JSON.parse(fs.readFileSync(fixture.pipeline.paths.writerState, "utf8"));
  assert.equal(state.intent_consumptions[0].status, "stale_intent");
});

test("History refuses an intent whose artifact digest no longer matches", () => {
  const fixture = createFixture("digest-mismatch");
  fixture.pipeline.runReview({ env: localReviewEnv() });
  const [intent] = readJsonl(fixture.pipeline.paths.publicationIntents);
  fs.writeFileSync(
    fixture.pipeline.paths.publicationIntents,
    `${JSON.stringify({ ...intent, artifact_digest: "0".repeat(64) })}\n`,
    "utf8",
  );

  const history = fixture.pipeline.runHistoryWriter();
  assert.equal(history.written.length, 0);
  assert.equal(history.diagnostics[0].event, "publication_intent_invalid");
  assert.equal(history.diagnostics[0].code, "artifact_digest_mismatch");
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
});

test("a missing required rejection artifact prevents publication intent creation", () => {
  const fixture = createFixture("artifact-gap", { subjectRoute: exactSubjectRoute() });
  const deferred = createDecision(fixture.candidate, {
    result: "deferred",
    reason: "semantic_question",
    checks: { publication_allowed: true },
    review_revision: 1,
  });
  const accepted = createDecision(fixture.candidate, {
    result: "accepted",
    reason: "subject_rewrite_accepted",
    checks: { publication_allowed: true },
    review_revision: 2,
    supersedes_decision_id: deferred.decision_id,
  });
  appendJsonlUnique(fixture.pipeline.paths.decisions, [deferred, accepted], "decision_id");
  fs.mkdirSync(fixture.pipeline.paths.rejectionCases, { recursive: true });

  const repair = fixture.pipeline.repairReviewArtifacts();
  assert.equal(repair.status, "success");
  assert.equal(repair.artifact_complete, false);
  assert.equal(repair.publication_intent_complete, false);
  assert.equal(
    repair.publication_intent_errors.some(
      (item) => item.code === "required_review_artifact_missing",
    ),
    true,
  );
  assert.equal(fs.existsSync(fixture.pipeline.paths.publicationIntents), false);
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
});

test("publication intent write failure is fail-open and same-writer repair completes it", () => {
  const fixture = createFixture("intent-repair");
  fs.mkdirSync(fixture.pipeline.paths.publicationIntents, { recursive: true });

  const review = fixture.pipeline.runReview({ env: localReviewEnv() });
  assert.equal(review.status, "success");
  assert.equal(review.decisions[0].result, "accepted");
  assert.equal(review.publication_intent_complete, false);
  assert.equal(
    review.publication_intent_errors[0].code,
    "publication_intent_write_failed",
  );
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);

  fs.rmdirSync(fixture.pipeline.paths.publicationIntents);
  const repaired = fixture.pipeline.repairReviewArtifacts();
  assert.equal(repaired.status, "success");
  assert.equal(repaired.publication_intent_complete, true);
  assert.equal(readJsonl(fixture.pipeline.paths.publicationIntents).length, 1);
  const intentBytes = fs.readFileSync(fixture.pipeline.paths.publicationIntents, "utf8");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.publicationIntents, "utf8"), intentBytes);
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 1);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
});

test("two competing candidate lineage leaves invalidate an existing intent", () => {
  const fixture = createFixture("lineage-branch", {
    candidateId: "cand-root",
    appendCandidate: false,
  });
  const root = candidateRow(fixture, { candidate_id: "cand-root" });
  const leafA = candidateRow(fixture, {
    candidate_id: "cand-leaf-a",
    supersedes_candidate_id: root.candidate_id,
    body: "leaf A",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [root, leafA], "candidate_id");
  const acceptedA = createDecision(leafA, {
    result: "accepted",
    reason: "subject_rewrite_accepted",
    checks: { publication_allowed: true },
  });
  appendJsonlUnique(fixture.pipeline.paths.decisions, [acceptedA], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  assert.equal(readJsonl(fixture.pipeline.paths.publicationIntents).length, 1);

  const leafB = candidateRow(fixture, {
    candidate_id: "cand-leaf-b",
    supersedes_candidate_id: root.candidate_id,
    body: "leaf B",
  });
  const acceptedB = createDecision(leafB, {
    result: "accepted",
    reason: "subject_rewrite_accepted",
    checks: { publication_allowed: true },
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [leafB], "candidate_id");
  appendJsonlUnique(fixture.pipeline.paths.decisions, [acceptedB], "decision_id");

  const history = fixture.pipeline.runHistoryWriter();
  assert.equal(history.written.length, 0);
  assert.equal(
    history.diagnostics.some((item) => item.event === "candidate_lineage_ambiguous"),
    true,
  );
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
});

test("candidate lineage rejects missing predecessors, type changes, cycles, and malformed links with stable codes", () => {
  const rows = [
    { candidate_id: "root", type: "episode" },
    { candidate_id: "missing", type: "episode", supersedes_candidate_id: "absent" },
    { candidate_id: "cross-type", type: "self_note", supersedes_candidate_id: "root" },
    { candidate_id: "cycle-a", type: "episode", supersedes_candidate_id: "cycle-b" },
    { candidate_id: "cycle-b", type: "episode", supersedes_candidate_id: "cycle-a" },
    { candidate_id: "malformed", type: "episode", supersedes_candidate_id: 42 },
  ];
  const analyzed = analyzeCandidateLineages(rows);
  assert.equal(analyzed.byCandidate.get("missing").code, "candidate_predecessor_missing");
  assert.equal(analyzed.byCandidate.get("cross-type").code, "candidate_lineage_type_mismatch");
  assert.equal(analyzed.byCandidate.get("cycle-a").code, "candidate_lineage_cycle");
  assert.equal(analyzed.byCandidate.get("cycle-b").code, "candidate_lineage_cycle");
  assert.equal(analyzed.byCandidate.get("malformed").code, "supersedes_candidate_id_invalid");
});

test("only the unique accepted lineage leaf receives an intent and an older accepted draft never revives", () => {
  const fixture = createFixture("effective-leaf", { appendCandidate: false });
  const root = candidateRow(fixture, { candidate_id: "cand-root", body: "old body" });
  const leaf = candidateRow(fixture, {
    candidate_id: "cand-leaf",
    body: "rewritten body",
    supersedes_candidate_id: root.candidate_id,
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [root, leaf], "candidate_id");
  const rootAccepted = createDecision(root, {
    result: "accepted", reason: "old accepted", checks: { publication_allowed: true },
  });
  const leafAccepted = createDecision(leaf, {
    result: "accepted", reason: "rewrite accepted", checks: { publication_allowed: true },
  });
  appendJsonlUnique(
    fixture.pipeline.paths.decisions,
    [rootAccepted, leafAccepted],
    "decision_id",
  );

  const repair = fixture.pipeline.repairReviewArtifacts();
  assert.equal(repair.publication_intent_complete, true);
  const intents = readJsonl(fixture.pipeline.paths.publicationIntents);
  assert.deepEqual(intents.map((intent) => intent.candidate_id), [leaf.candidate_id]);
  assert.deepEqual(fixture.pipeline.runHistoryWriter().written, [leafAccepted.decision_id]);
  assert.equal(readJsonl(fixture.pipeline.paths.episodes)[0].body, leaf.body);

  const rejectedFixture = createFixture("rejected-leaf", { appendCandidate: false });
  const rejectedRoot = candidateRow(rejectedFixture, { candidate_id: "rejected-root" });
  const rejectedLeaf = candidateRow(rejectedFixture, {
    candidate_id: "rejected-leaf",
    supersedes_candidate_id: rejectedRoot.candidate_id,
  });
  appendJsonlUnique(
    rejectedFixture.pipeline.paths.candidates,
    [rejectedRoot, rejectedLeaf],
    "candidate_id",
  );
  appendJsonlUnique(rejectedFixture.pipeline.paths.decisions, [
    createDecision(rejectedRoot, {
      result: "accepted", reason: "old accepted", checks: { publication_allowed: true },
    }),
    createDecision(rejectedLeaf, {
      result: "rejected", reason: "new rejected", checks: { publication_allowed: true },
    }),
  ], "decision_id");
  assert.equal(rejectedFixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  assert.equal(fs.existsSync(rejectedFixture.pipeline.paths.publicationIntents), false);
  assert.equal(rejectedFixture.pipeline.runHistoryWriter().written.length, 0);
});

test("a published predecessor blocks candidate rewrite and a later decision flip records a conflict without changing canon", () => {
  const fixture = createFixture("published-rewrite");
  const accepted = fixture.pipeline.runReview({ env: localReviewEnv() }).decisions[0];
  fixture.pipeline.runHistoryWriter();
  const canonBefore = fs.readFileSync(fixture.pipeline.paths.episodes, "utf8");

  const leaf = candidateRow(fixture, {
    candidate_id: "cand-after-publication",
    body: "must use correction instead",
    supersedes_candidate_id: fixture.candidate.candidate_id,
  });
  const leafAccepted = createDecision(leaf, {
    result: "accepted", reason: "invalid rewrite", checks: { publication_allowed: true },
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [leaf], "candidate_id");
  appendJsonlUnique(fixture.pipeline.paths.decisions, [leafAccepted], "decision_id");
  const repair = fixture.pipeline.repairReviewArtifacts();
  assert.equal(
    repair.publication_intent_errors.some(
      (error) => error.code === "candidate_predecessor_already_published",
    ),
    true,
  );

  const rejected = createDecision(fixture.candidate, {
    result: "rejected",
    reason: "post publish flip",
    checks: { publication_allowed: true },
    review_revision: 2,
    supersedes_decision_id: accepted.decision_id,
  });
  appendJsonlUnique(fixture.pipeline.paths.decisions, [rejected], "decision_id");
  const history = fixture.pipeline.runHistoryWriter();
  assert.equal(history.written.length, 0);
  assert.equal(
    history.diagnostics.some((event) => event.event === POST_PUBLISH_DECISION_CONFLICT),
    true,
  );
  assert.equal(fs.readFileSync(fixture.pipeline.paths.episodes, "utf8"), canonBefore);
});

test("candidate rewrite lineage never becomes canon correction while canon_supersedes preserves canon format", () => {
  const rewriteFixture = createFixture("field-split-rewrite", { appendCandidate: false });
  const root = candidateRow(rewriteFixture, { candidate_id: "split-root" });
  const leaf = candidateRow(rewriteFixture, {
    candidate_id: "split-leaf",
    supersedes_candidate_id: root.candidate_id,
  });
  appendJsonlUnique(rewriteFixture.pipeline.paths.candidates, [root, leaf], "candidate_id");
  appendJsonlUnique(rewriteFixture.pipeline.paths.decisions, [createDecision(leaf, {
    result: "accepted", reason: "rewrite", checks: { publication_allowed: true },
  })], "decision_id");
  rewriteFixture.pipeline.repairReviewArtifacts();
  rewriteFixture.pipeline.runHistoryWriter();
  const rewriteCanon = readJsonl(rewriteFixture.pipeline.paths.episodes)[0];
  assert.equal(rewriteCanon.type, "episode");
  assert.equal(rewriteCanon.supersedes, null);

  const correctionFixture = createFixture("field-split-correction", { appendCandidate: false });
  const correction = candidateRow(correctionFixture, {
    candidate_id: "canon-correction",
    canon_supersedes: "ep-old",
  });
  appendJsonlUnique(correctionFixture.pipeline.paths.candidates, [correction], "candidate_id");
  appendJsonlUnique(correctionFixture.pipeline.paths.decisions, [createDecision(correction, {
    result: "accepted", reason: "correction", checks: { publication_allowed: true },
  })], "decision_id");
  correctionFixture.pipeline.repairReviewArtifacts();
  correctionFixture.pipeline.runHistoryWriter();
  const correctionCanon = readJsonl(correctionFixture.pipeline.paths.episodes)[0];
  assert.equal(correctionCanon.type, "correction");
  assert.equal(correctionCanon.supersedes, "ep-old");
  assert.equal(Object.hasOwn(correctionCanon, "canon_supersedes"), false);
});

test("the shared Review handoff feature gate remains default-off", () => {
  const fixture = createFixture("default-off", { reviewArtifactsEnabled: false });
  const review = fixture.pipeline.runReview({ env: localReviewEnv() });
  assert.equal(review.status, "success");
  assert.equal(review.decisions[0].result, "accepted");
  assert.equal(review.publication_intent_complete, false);
  assert.equal(review.publication_intent_errors[0].code, "publication_intents_disabled");
  assert.equal(fs.existsSync(fixture.pipeline.paths.publicationIntents), false);
  assert.deepEqual(
    fixture.pipeline.runHistoryWriter(),
    { status: "skipped", reason: "review_artifacts_disabled" },
  );
});

function createFixture(label, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `g2-4-${label}-`));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-31.jsonl");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(conversationFile, '{"type":"user","text":"fixture source"}\n', "utf8");
  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "MEMORY_WRITER_LEASE.json"),
    reviewScript: REVIEW_SCRIPT,
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
    reviewArtifactsEnabled: options.reviewArtifactsEnabled !== false,
    now: () => new Date(FIXED_TIME),
  });
  const fixture = { root, continuityDir, conversationDir, conversationFile, pipeline };
  const candidate = candidateRow(fixture, {
    candidate_id: options.candidateId || `cand-${label}`,
    ...(options.subjectRoute ? { subject_route: options.subjectRoute } : {}),
  });
  fixture.candidate = candidate;
  if (options.appendCandidate !== false) {
    appendJsonlUnique(pipeline.paths.candidates, [candidate], "candidate_id");
  }
  return fixture;
}

function candidateRow(fixture, overrides = {}) {
  return {
    candidate_id: "cand-fixture",
    ts: "2026-07-31T00:00:00.000Z",
    type: "episode",
    author: "subject_ai",
    origin: "live_closeout",
    author_role: "subject_ai",
    author_model: "fixture-subject-ai",
    context_scope: "active_session",
    semantic_authority: "high",
    needs_subject_review: false,
    body: "fixture body",
    source_ref: { file: fixture.conversationFile, window: "1-1" },
    idempotency_key: "fixture-key",
    ...overrides,
  };
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

function localReviewEnv() {
  return { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" };
}
