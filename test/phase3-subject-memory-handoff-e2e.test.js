"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { readConfig } = require("../src/core/config");
const { sanitizeTraceEntry } = require("../src/core/context-trace");
const { TurnGateStore } = require("../src/core/turn-gate-store");
const { ConversationRecorder } = require("../src/services/conversation-recorder");
const {
  ContinuityPipeline,
  createDecision,
} = require("../src/continuity/continuity-pipeline");
const { stripConversationArtifacts } = require("../src/continuity/conversation-purity");
const {
  selectEffectiveDecisionForCandidate,
} = require("../src/continuity/effective-decision");
const { HandoffAckLedger } = require("../src/continuity/handoff-ack");
const {
  createHandoffAckId,
  formatSubjectMemoryHandoff,
} = require("../src/continuity/handoff-context");
const { HandoffDispatcher } = require("../src/continuity/handoff-dispatcher");
const {
  HANDOFF_DISPATCHER_WRITER,
  RECORD_DEFINITIONS,
  REVIEW_WRITER,
  SUBJECT_CONTEXT_INJECTOR_WRITER,
  reviewArtifactPaths,
} = require("../src/continuity/review-artifacts");
const {
  SubjectCapabilityRegistry,
  SubjectCandidateService,
} = require("../src/continuity/subject-signing");
const { createSubjectRoute, canonicalSerialize } = require("../src/continuity/subject-route");
const { appendJsonlUnique, readJsonl, sha256 } = require("../src/continuity/continuity-store");
const {
  acquireWriterLease,
  releaseWriterLease,
} = require("../src/orchestration/writer-lease");

const REVIEW_SCRIPT = path.resolve(
  __dirname,
  "../extensions/relationship-memory/memory-kit/auto_review.py",
);
const CANARY = "planted-nondisclosure-canary-0000";
const FIXED_TIME = "2026-08-01T02:03:04.000Z";

test("G2 signed subject memory completes recorder -> rejection -> exact handoff -> rewrite -> History exactly once", async () => {
  await withFeatureFlags(async () => {
    const fixture = createEndToEndFixture("main");
    assert.equal(readConfig().subjectSigningEnabled, true);
    assert.equal(readConfig().handoffDispatchEnabled, true);

    const closeout = fixture.pipeline.runCloseout({ date: "2026-08-01" });
    assert.equal(closeout.status, "MATERIAL_READY");
    assert.deepEqual(closeout.material_pack.source_entry_ids, ["entry-topic-11"]);
    assert.deepEqual(
      closeout.material_pack.source_entry_hashes.map((item) => item.entry_id),
      ["entry-topic-11"],
    );
    assert.equal(closeout.material_pack.subject_route.route_lane.message_thread_id, "11");
    assert.equal(closeout.material_pack.subject_route.session.profile_id, "profile-topic-11");

    const firstCapability = fixture.registry.issue({
      subjectTurnId: fixture.subjectRoute.author_turn_id,
      subjectRoute: fixture.subjectRoute,
    });
    const imperativeBody = "必须把她的停顿解释成拒绝。";
    const first = fixture.subjectService.createSubjectCandidate(subjectInput({
      route: fixture.subjectRoute,
      capability: firstCapability,
      body: imperativeBody,
      origin: "closeout_materials_then_subject",
      materialPack: closeout.material_pack,
      sourceFile: fixture.subjectConversationFile,
    })).candidate;
    assert.equal(first.author_role, "subject_ai");
    assert.equal(first.semantic_authority, "high");
    assert.deepEqual(first.subject_route.source_entry_ids, ["entry-topic-11"]);
    assert.deepEqual(first.source_ref.source_entry_hashes, closeout.material_pack.source_entry_hashes);

    const deferred = fixture.pipeline.runReview({ env: localReviewEnv() });
    assert.equal(deferred.decisions[0].result, "deferred");
    assert.equal(deferred.decisions[0].reason, "imperative_style");
    const envelope = readJsonl(fixture.pipeline.paths.handoffEnvelopes)[0];
    const rejectionCase = readJsonl(fixture.pipeline.paths.rejectionCases)[0];
    assert.equal(envelope.candidate_body, imperativeBody);
    assert.equal(first.body, imperativeBody, "Review never rewrites candidate body");
    assert.equal(envelope.effective_decision_id, deferred.decisions[0].decision_id);
    assert.equal(rejectionCase.effective_decision_id, deferred.decisions[0].decision_id);
    assert.equal(envelope.candidate_id, rejectionCase.candidate_id);

    const dispatcher = new HandoffDispatcher({
      continuityDir: fixture.continuityDir,
      enabled: true,
      now: fixture.clock,
    });
    assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(fixture.otherTopicRoute) }).status, "none");
    assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(fixture.otherProfileRoute) }).status, "none");
    assert.equal(fs.existsSync(fixture.pipeline.paths.handoffDeliveryEvents), false);
    const begun = dispatcher.beginSubjectTurn({ currentRoute: identity(fixture.subjectRoute) });
    assert.equal(begun.status, "ready");
    assert.equal(begun.token.route_match, "EXACT");
    const block = formatSubjectMemoryHandoff({ envelope: begun.envelope, deliveryId: begun.token.delivery_id });
    const trace = sanitizeTraceEntry({
      threadId: fixture.subjectRoute.session.runtime_thread_id,
      turnId: "turn-handoff",
      blocks: [{
        type: "subject_memory_handoff",
        loaded: true,
        reason: "exact_route",
        handoff_id: begun.token.handoff_id,
        route_match: begun.token.route_match,
        chars: block.length,
        result: "injected",
        candidate_body: imperativeBody,
      }],
    });
    assert.equal(JSON.stringify(trace).includes(imperativeBody), false);
    assert.equal(trace.blocks[0].handoff_id, envelope.handoff_id);
    const delivered = dispatcher.markDelivered(begun.token);
    assert.equal(delivered.result, "delivered");
    assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(fixture.subjectRoute) }).status, "none");

    const ackLedger = new HandoffAckLedger({
      continuityDir: fixture.continuityDir,
      enabled: true,
      now: fixture.clock,
    });
    const ack = {
      ack_id: createHandoffAckId(delivered.delivery_id),
      delivery_id: delivered.delivery_id,
      handoff_id: delivered.handoff_id,
      disposition: "rewrite_submitted",
    };
    assert.equal(ackLedger.record({ ack, expectedDelivery: delivered, subjectTurnId: "turn-rewrite" }).status, "acknowledged");
    assert.equal(ackLedger.record({ ack, expectedDelivery: delivered, subjectTurnId: "turn-replay" }).status, "replayed");
    assert.equal(readJsonl(fixture.pipeline.paths.handoffAckEvents).length, 1);

    const rewriteRoute = routeFor({
      topic: "11",
      profile: "profile-topic-11",
      slot: "slot-topic-11",
      thread: "native-topic-11",
      turn: "turn-rewrite",
      sourceIds: ["entry-topic-11"],
    });
    const rewriteCapability = fixture.registry.issue({
      subjectTurnId: rewriteRoute.author_turn_id,
      subjectRoute: rewriteRoute,
    });
    const rewriteBody = "她停了一下；我先不替她定义这是什么意思。";
    const rewrite = fixture.subjectService.createSubjectCandidate(subjectInput({
      route: rewriteRoute,
      capability: rewriteCapability,
      body: rewriteBody,
      origin: "subject_rewrite",
      materialPack: closeout.material_pack,
      sourceFile: fixture.subjectConversationFile,
      supersedes_candidate_id: first.candidate_id,
      rewrite_handoff_id: envelope.handoff_id,
      rewrite_of_decision_id: deferred.decisions[0].decision_id,
    })).candidate;
    assert.notEqual(rewrite.candidate_id, first.candidate_id);
    assert.equal(rewrite.supersedes_candidate_id, first.candidate_id);
    assert.equal(readJsonl(fixture.pipeline.paths.candidates)[0].body, imperativeBody);

    const acceptedFirst = fixture.pipeline.runReview({ env: localReviewEnv() }).decisions[0];
    assert.equal(acceptedFirst.candidate_id, rewrite.candidate_id);
    assert.equal(acceptedFirst.result, "accepted");
    const acceptedRevision = fixture.pipeline.runReview({
      env: localReviewEnv(),
      retryCandidateId: rewrite.candidate_id,
    }).decisions[0];
    assert.equal(acceptedRevision.result, "accepted");
    assert.equal(acceptedRevision.review_revision, 2);
    assert.equal(acceptedRevision.supersedes_decision_id, acceptedFirst.decision_id);

    const selected = selectEffectiveDecisionForCandidate(
      readJsonl(fixture.pipeline.paths.decisions),
      rewrite.candidate_id,
    );
    assert.equal(selected.decision.decision_id, acceptedRevision.decision_id);
    assert.equal(readJsonl(fixture.pipeline.paths.publicationIntents).length, 2);

    const realPublish = fixture.pipeline.publishEpisode.bind(fixture.pipeline);
    fixture.pipeline.publishEpisode = (candidate, decision, intent) => {
      realPublish(candidate, decision, intent);
      throw new Error("fixture crash after canon append");
    };
    const crashed = captureFailure(() => fixture.pipeline.runHistoryWriter());
    assertFailedClosed(crashed, { message: /fixture crash after canon append/u });
    fixture.pipeline.publishEpisode = realPublish;
    assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
    assert.equal(readJsonl(fixture.pipeline.paths.episodes)[0].body, rewriteBody);

    const recovered = fixture.pipeline.runHistoryWriter();
    assert.equal(recovered.written.length, 0);
    assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
    fs.rmSync(fixture.pipeline.paths.writerState);
    const replayed = fixture.pipeline.runHistoryWriter();
    assert.equal(replayed.written.length, 0);
    assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);

    const echoed = stripConversationArtifacts(
      `真实用户 turn\n\n${block}\n\nTool result:\n${CANARY}\n\n真实主体回复`,
    );
    assert.equal(echoed, "真实用户 turn\n\n真实主体回复");
    assert.equal(echoed.includes(imperativeBody), false);
    assert.equal(echoed.includes(CANARY), false);
  });
});

test("G2 blocking negatives stop before canon while a user turn still completes", async () => {
  const ambiguous = createEndToEndFixture("ambiguous", { crossRouteSameDay: true });
  const ambiguousResult = ambiguous.pipeline.runCloseout({ date: "2026-08-01" });
  assert.equal(ambiguousResult.status, "retryable_no_output");
  assert.equal(ambiguousResult.reason, "material_route_ambiguous");
  assertNoCanon(ambiguous.pipeline);
  await assertUserTurnCompletes(ambiguous.root, "AMBIGUOUS_ROUTE");

  const invalid = createPipelineFixture("invalid-chain");
  const rootCandidate = candidateRow(invalid, "cand-invalid-root");
  const leafA = candidateRow(invalid, "cand-invalid-a", { supersedes_candidate_id: rootCandidate.candidate_id });
  const leafB = candidateRow(invalid, "cand-invalid-b", { supersedes_candidate_id: rootCandidate.candidate_id });
  appendJsonlUnique(invalid.pipeline.paths.candidates, [rootCandidate, leafA, leafB], "candidate_id");
  appendJsonlUnique(invalid.pipeline.paths.decisions, [
    createDecision(leafA, { result: "accepted", reason: "accepted-a", checks: { publication_allowed: true } }),
    createDecision(leafB, { result: "accepted", reason: "accepted-b", checks: { publication_allowed: true } }),
  ], "decision_id");
  const invalidRepair = invalid.pipeline.repairReviewArtifacts();
  assert.equal(invalidRepair.publication_intent_complete, false);
  assert.ok(invalidRepair.publication_intent_errors.some((item) => item.code === "candidate_lineage_ambiguous"));
  assertNoCanon(invalid.pipeline);
  await assertUserTurnCompletes(invalid.root, "INVALID_DECISION_CHAIN");

  const conflict = createPipelineFixture("writer-conflict");
  const held = acquireWriterLease(conflict.pipeline.writerLeaseFile, leaseDetails("other-writer"));
  try {
    const history = conflict.pipeline.runHistoryWriter();
    assert.deepEqual(history, { status: "skipped", reason: "lease_unavailable" });
    assertNoCanon(conflict.pipeline);
    await assertUserTurnCompletes(conflict.root, "WRITER_CONFLICT");
  } finally {
    releaseWriterLease(conflict.pipeline.writerLeaseFile, held.lease_id);
  }

  const stale = createPipelineFixture("stale-intent");
  const staleCandidate = candidateRow(stale, "cand-stale");
  appendJsonlUnique(stale.pipeline.paths.candidates, [staleCandidate], "candidate_id");
  const accepted = createDecision(staleCandidate, {
    result: "accepted", reason: "accepted", checks: { publication_allowed: true },
  });
  appendJsonlUnique(stale.pipeline.paths.decisions, [accepted], "decision_id");
  assert.equal(stale.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  const rejected = createDecision(staleCandidate, {
    result: "rejected",
    reason: "safety_failed",
    checks: { publication_allowed: true, safety_ok: false },
    review_revision: 2,
    supersedes_decision_id: accepted.decision_id,
  });
  appendJsonlUnique(stale.pipeline.paths.decisions, [rejected], "decision_id");
  const staleHistory = stale.pipeline.runHistoryWriter();
  assert.ok(staleHistory.diagnostics.some((item) => item.event === "stale_intent"));
  assertNoCanon(stale.pipeline);
  await assertUserTurnCompletes(stale.root, "STALE_INTENT");
});

test("G2 decision, legacy, sleep-crop, ack, and writer boundaries remain blocking", async () => {
  const flip = createPipelineFixture("decision-flips");
  const candidate = candidateRow(flip, "cand-flip");
  appendJsonlUnique(flip.pipeline.paths.candidates, [candidate], "candidate_id");
  const rejected = createDecision(candidate, {
    result: "rejected", reason: "safety_failed", checks: { publication_allowed: true },
  });
  const accepted = createDecision(candidate, {
    result: "accepted",
    reason: "subject accepted after revision",
    checks: { publication_allowed: true },
    review_revision: 2,
    supersedes_decision_id: rejected.decision_id,
  });
  const acceptedReasonRevision = createDecision(candidate, {
    result: "accepted",
    reason: "same result, different reason",
    checks: { publication_allowed: true },
    review_revision: 3,
    supersedes_decision_id: accepted.decision_id,
  });
  assert.notEqual(accepted.decision_id, acceptedReasonRevision.decision_id);
  appendJsonlUnique(flip.pipeline.paths.decisions, [rejected, accepted, acceptedReasonRevision], "decision_id");
  assert.equal(flip.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  assert.deepEqual(flip.pipeline.runHistoryWriter().written, [acceptedReasonRevision.decision_id]);
  assert.equal(readJsonl(flip.pipeline.paths.episodes).length, 1);
  assert.equal(flip.pipeline.runHistoryWriter().written.length, 0);

  const acceptedThenRejected = createPipelineFixture("accepted-rejected");
  const blockedCandidate = candidateRow(acceptedThenRejected, "cand-accepted-rejected");
  const firstAccepted = createDecision(blockedCandidate, {
    result: "accepted", reason: "old accepted", checks: { publication_allowed: true },
  });
  const effectiveRejected = createDecision(blockedCandidate, {
    result: "rejected",
    reason: "safety_failed",
    checks: { publication_allowed: true, safety_ok: false },
    review_revision: 2,
    supersedes_decision_id: firstAccepted.decision_id,
  });
  appendJsonlUnique(acceptedThenRejected.pipeline.paths.candidates, [blockedCandidate], "candidate_id");
  appendJsonlUnique(acceptedThenRejected.pipeline.paths.decisions, [firstAccepted, effectiveRejected], "decision_id");
  acceptedThenRejected.pipeline.repairReviewArtifacts();
  assertNoCanonAfterHistory(acceptedThenRejected.pipeline);

  const cycleDecisionA = { ...firstAccepted, decision_id: "decision-cycle-a", supersedes_decision_id: "decision-cycle-b" };
  const cycleDecisionB = { ...effectiveRejected, decision_id: "decision-cycle-b", supersedes_decision_id: "decision-cycle-a" };
  const cycle = selectEffectiveDecisionForCandidate([cycleDecisionA, cycleDecisionB], blockedCandidate.candidate_id);
  assert.equal(cycle.decision, null);
  assert.ok(cycle.event.reasons.includes("decision_cycle"));

  const legacy = createPipelineFixture("legacy-no-route");
  const legacyCandidate = {
    ...candidateRow(legacy, "cand-legacy-no-route"),
    author: "janitor",
    origin: "janitor_legacy",
    author_role: "extractor",
    semantic_authority: "none",
    needs_subject_review: true,
  };
  delete legacyCandidate.subject_route;
  appendJsonlUnique(legacy.pipeline.paths.candidates, [legacyCandidate], "candidate_id");
  const legacyReview = legacy.pipeline.runReview({ env: localReviewEnv() });
  assert.equal(legacyReview.decisions[0].result, "deferred");
  assert.equal(legacyReview.publication_intent_ids.length, 0);
  assert.equal(fs.existsSync(legacy.pipeline.paths.handoffEnvelopes), false);
  assertNoCanonAfterHistory(legacy.pipeline);

  const sleep = createPipelineFixture("sleep-crop");
  const paths = reviewArtifactPaths(sleep.continuityDir);
  const envelope = handoffEnvelope(candidateRow(sleep, "cand-sleep"));
  fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
  fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify(envelope)}\n`, "utf8");
  const dispatcher = new HandoffDispatcher({ continuityDir: sleep.continuityDir, enabled: true });
  const begun = dispatcher.beginSubjectTurn({ currentRoute: identity(envelope.subject_route) });
  dispatcher.markFailed(begun.token, { reason: "window_slept", retryable: false });
  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(envelope.subject_route) }).status, "none");
  assert.equal(readJsonl(paths.handoffDeliveryEvents).length, 1);
  assertNoCanon(sleep.pipeline);
  await assertUserTurnCompletes(sleep.root, "SLEEP_FALLBACK_CROPPED");

  const ackLedger = new HandoffAckLedger({ continuityDir: sleep.continuityDir, enabled: true });
  for (const [index, disposition] of ["rewrite_submitted", "abandoned", "read_only"].entries()) {
    const delivery = { delivery_id: `delivery-${index}`, handoff_id: `handoff-${index}` };
    const ack = {
      ack_id: createHandoffAckId(delivery.delivery_id),
      ...delivery,
      disposition,
    };
    assert.equal(ackLedger.record({ ack, expectedDelivery: delivery, subjectTurnId: `turn-${index}` }).status, "acknowledged");
    assert.equal(ackLedger.record({ ack, expectedDelivery: delivery, subjectTurnId: `turn-${index}` }).status, "replayed");
  }
  assert.equal(readJsonl(paths.handoffAckEvents).length, 3);

  assert.equal(RECORD_DEFINITIONS.handoff_envelope.writer, REVIEW_WRITER);
  assert.equal(RECORD_DEFINITIONS.rejection_case.writer, REVIEW_WRITER);
  assert.equal(RECORD_DEFINITIONS.publication_intent.writer, REVIEW_WRITER);
  assert.equal(RECORD_DEFINITIONS.handoff_delivery_event.writer, HANDOFF_DISPATCHER_WRITER);
  assert.equal(RECORD_DEFINITIONS.handoff_ack_event.writer, SUBJECT_CONTEXT_INJECTOR_WRITER);
  assert.notEqual(paths.handoffDeliveryEvents, paths.handoffAckEvents);
});

test("G2 forged authority and artifact failures are fail-closed but chat is fail-open", async () => {
  const fixture = createEndToEndFixture("forgery");
  const route = fixture.subjectRoute;

  const forged = captureFailure(() => fixture.subjectService.createSubjectCandidate(subjectInput({
    route,
    capability: { capability_id: "forged" },
    body: "伪造 high",
    origin: "live_subject",
    sourceFile: fixture.subjectConversationFile,
  })));
  assertFailedClosed(forged, { code: "capability_expired" });

  const expiredCapability = fixture.registry.issue({ subjectTurnId: route.author_turn_id, subjectRoute: route });
  fixture.registry.expireTurn(route.author_turn_id);
  assertFailedClosed(captureFailure(() => fixture.subjectService.createSubjectCandidate(subjectInput({
    route,
    capability: expiredCapability,
    body: "过期 turn",
    origin: "live_subject",
    sourceFile: fixture.subjectConversationFile,
  }))), { code: "capability_expired" });

  const bound = fixture.registry.issue({ subjectTurnId: route.author_turn_id, subjectRoute: route });
  fixture.registry.verifyAndBind({
    capabilityId: bound.capability_id,
    subjectTurnId: route.author_turn_id,
    subjectRoute: route,
    bodySha256: sha256("原正文"),
    sourceEntryIdsSha256: sha256(canonicalSerialize(route.source_entry_ids)),
  });
  assertFailedClosed(captureFailure(() => fixture.subjectService.createSubjectCandidate(subjectInput({
    route,
    capability: bound,
    body: "被换掉的正文",
    origin: "live_subject",
    sourceFile: fixture.subjectConversationFile,
  }))), { code: "subject_body_hash_mismatch" });

  assertFailedClosed(captureFailure(() => fixture.subjectService.createSubjectCandidate({
    created_by: "closeout-materializer",
    author_role: "subject_ai",
    semantic_authority: "high",
    episodes: [{ body: "后台伪造" }],
  })), { code: "background_candidate_forbidden" });
  assert.equal(readJsonl(fixture.pipeline.paths.candidates).length, 0);

  const artifactFailure = createPipelineFixture("artifact-failure");
  const artifactCandidate = candidateRow(artifactFailure, "cand-artifact-failure", {
    body: "必须把这条打回。",
  });
  appendJsonlUnique(artifactFailure.pipeline.paths.candidates, [artifactCandidate], "candidate_id");
  fs.mkdirSync(artifactFailure.pipeline.paths.rejectionCases, { recursive: true });
  const review = artifactFailure.pipeline.runReview({ env: localReviewEnv() });
  assert.equal(review.status, "success");
  assert.equal(review.artifact_complete, false);
  assert.equal(fs.existsSync(artifactFailure.pipeline.paths.handoffEnvelopes), false);
  assertNoCanonAfterHistory(artifactFailure.pipeline);
  await assertUserTurnCompletes(artifactFailure.root, "ARTIFACT_WRITE_FAILURE");
});

function createEndToEndFixture(label, { crossRouteSameDay = false } = {}) {
  const fixture = createPipelineFixture(label, { subjectSigningEnabled: true });
  const recorder = new ConversationRecorder({ dirPath: fixture.conversationDir });
  const subjectRoute = routeFor({
    topic: "11",
    profile: "profile-topic-11",
    slot: "slot-topic-11",
    thread: "native-topic-11",
    turn: "turn-subject-11",
    sourceIds: ["entry-topic-11"],
  });
  const otherTopicRoute = routeFor({
    topic: "22",
    profile: "profile-topic-22",
    slot: "slot-topic-22",
    thread: "native-topic-22",
    turn: "turn-subject-22",
    sourceIds: ["entry-topic-22"],
  });
  const otherProfileRoute = routeFor({
    topic: "11",
    profile: "profile-other",
    slot: "slot-profile-other",
    thread: "native-profile-other",
    turn: "turn-subject-other",
    sourceIds: ["entry-topic-11"],
  });
  recorder.record({
    id: "entry-topic-11",
    type: "user",
    timestamp: FIXED_TIME,
    turnId: subjectRoute.author_turn_id,
    route: recorderRoute(subjectRoute),
    text: "我停了一下，还没有给这件事下定义。",
    meta: { subject_route: subjectRoute },
  });
  recorder.record({
    id: "entry-topic-22",
    type: "user",
    timestamp: crossRouteSameDay ? "2026-08-01T03:03:04.000Z" : "2026-08-02T03:03:04.000Z",
    turnId: otherTopicRoute.author_turn_id,
    route: recorderRoute(otherTopicRoute),
    text: `另一个 topic/profile 的隔离内容 ${CANARY}`,
    meta: { subject_route: otherTopicRoute },
  });
  const registry = new SubjectCapabilityRegistry({ enabled: true, now: fixture.clock });
  return {
    ...fixture,
    recorder,
    registry,
    subjectService: new SubjectCandidateService({
      continuityDir: fixture.continuityDir,
      registry,
      enabled: true,
    }),
    subjectRoute,
    otherTopicRoute,
    otherProfileRoute,
    subjectConversationFile: path.join(fixture.conversationDir, "2026-08-01.jsonl"),
  };
}

function createPipelineFixture(label, { subjectSigningEnabled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `g2-9-${label}-`));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  fs.mkdirSync(conversationDir, { recursive: true });
  let tick = 0;
  const clock = () => new Date(Date.parse(FIXED_TIME) + tick++ * 1000);
  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(root, "MEMORY_WRITER_LEASE.json"),
    reviewScript: REVIEW_SCRIPT,
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
    reviewArtifactsEnabled: true,
    subjectSigningEnabled,
    now: clock,
  });
  return { root, continuityDir, conversationDir, pipeline, clock };
}

function subjectInput({
  route,
  capability,
  body,
  origin,
  materialPack = null,
  sourceFile,
  ...extra
}) {
  const sourceEntryHashes = materialPack?.source_entry_hashes || sourceHashes(sourceFile, route.source_entry_ids);
  const contentSha256 = materialPack?.source_content_sha256 || sha256("fixture source");
  return {
    type: "episode",
    body,
    origin,
    capability_id: capability.capability_id,
    subject_turn_id: route.author_turn_id,
    subject_route: route,
    source_ref: {
      file: sourceFile,
      window: "1-1",
      source_entry_ids: route.source_entry_ids,
      source_entry_hashes: sourceEntryHashes,
      content_sha256: contentSha256,
    },
    ...(materialPack ? {
      material_pack_id: materialPack.material_pack_id,
      material_pack: materialPack,
    } : {}),
    ...extra,
  };
}

function candidateRow(fixture, candidateId, overrides = {}) {
  const sourceFile = path.join(fixture.conversationDir, "source.jsonl");
  if (!fs.existsSync(sourceFile)) fs.writeFileSync(sourceFile, '{"id":"source","type":"user","text":"fixture source"}\n', "utf8");
  return {
    candidate_id: candidateId,
    ts: FIXED_TIME,
    type: "episode",
    author: "subject_ai",
    origin: "live_subject",
    author_role: "subject_ai",
    author_model: "fixture-subject-ai",
    context_scope: "active_session",
    semantic_authority: "high",
    needs_subject_review: false,
    body: "我保留这次停顿，但不替她定义。",
    source_ref: { file: sourceFile, window: "1-1" },
    subject_route: routeFor({
      topic: "31",
      profile: "profile-31",
      slot: "slot-31",
      thread: "native-31",
      turn: `turn-${candidateId}`,
      sourceIds: ["source"],
    }),
    idempotency_key: `key-${candidateId}`,
    ...overrides,
  };
}

function handoffEnvelope(candidate) {
  const { createHandoffEnvelope } = require("../src/continuity/review-artifacts");
  return createHandoffEnvelope(candidate, {
    decision_id: `decision-${candidate.candidate_id}`,
    candidate_id: candidate.candidate_id,
    result: "deferred",
    reason: "imperative_style",
    checks: { imperative_style: true },
  }, FIXED_TIME);
}

function routeFor({ topic, profile, slot, thread, turn, sourceIds }) {
  return createSubjectRoute({
    version: 1,
    provider: "telegram",
    continuity_binding: {
      workspace_id: "workspace-e2e",
      account_id: "telegram",
      sender_id: "500",
      binding_key: "workspace-e2e:telegram:500",
    },
    route_lane: {
      lane_key: `tg:telegram:500:topic:${topic}`,
      chat_id: "500",
      message_thread_id: topic,
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: slot,
      runtime_thread_id: thread,
      profile_id: profile,
      profile_fingerprint: `fingerprint-${profile}`,
      window_id: thread,
    },
    author_turn_id: turn,
    source_entry_ids: sourceIds,
  });
}

function recorderRoute(route) {
  return {
    bindingKey: route.continuity_binding.binding_key,
    laneKey: route.route_lane.lane_key,
    sessionSlotKey: route.session.session_slot_key,
    messageThreadId: route.route_lane.message_thread_id,
    profileId: route.session.profile_id,
    windowId: route.session.window_id,
  };
}

function identity(route) {
  return {
    provider: route.provider,
    continuity_binding: route.continuity_binding,
    route_lane: route.route_lane,
    session: route.session,
  };
}

function sourceHashes(filePath, sourceIds) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
  return sourceIds.map((entryId) => {
    const line = rows.find((item) => JSON.parse(item).id === entryId);
    return { entry_id: entryId, sha256: sha256(line) };
  });
}

function localReviewEnv() {
  return { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" };
}

async function withFeatureFlags(fn) {
  const names = ["CYBERBOSS_SUBJECT_SIGNING_ENABLED", "CYBERBOSS_HANDOFF_DISPATCH_ENABLED"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "1";
  try { return await fn(); } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function captureFailure(fn) {
  let executed = false;
  try {
    executed = true;
    fn();
    return { executed, error: null };
  } catch (error) {
    return { executed, error };
  }
}

function assertFailedClosed(result, { code = "", message = null } = {}) {
  assert.equal(result.executed, true, "target path never executed");
  assert.ok(result.error instanceof Error, "target path did not fail closed");
  if (code) assert.equal(result.error.code, code);
  if (message) assert.match(result.error.message, message);
}

function assertNoCanon(pipeline) {
  assert.equal(fs.existsSync(pipeline.paths.episodes), false, "NO_CANON_WRITE");
}

function assertNoCanonAfterHistory(pipeline) {
  assert.equal(pipeline.runHistoryWriter().written.length, 0);
  assertNoCanon(pipeline);
}

async function assertUserTurnCompletes(root, label) {
  const runtimeTexts = [];
  const lane = { kind: "tg", laneKey: `lane-${label}`, chatId: "500", messageThreadId: "77" };
  const app = {
    config: {},
    handoffDispatcher: null,
    handoffDeliveryByRunKey: new Map(),
    contextTraceRecorder: { record() {} },
    contextTraceRunState: new Map(),
    turnGateStore: new TurnGateStore(),
    channelAdapter: { async sendTyping() {}, async sendText() {} },
    streamDelivery: {
      setReplyTargetForThread() {}, bindReplyTargetForTurn() {}, queueReplyTargetForThread() {},
    },
    runtimeContextStore: { setActiveContext() {} },
    pendingOperationByRunKey: new Map(),
    runtimeAdapter: {
      describe: () => ({ id: "claudecode" }),
      getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({ model: "" }) }),
      async sendTurn(args) {
        runtimeTexts.push(args.text);
        return {
          threadId: `thread-${label}`,
          turnId: `turn-${label}`,
          sessionSlotKey: `slot-${label}`,
          laneKey: lane.laneKey,
          profileId: "profile-user-turn",
          continuity: { blocks: [], skipped: [], total_chars: 0 },
        };
      },
    },
    async buildRuntimeTurn() { return { text: `USER_TURN_COMPLETED:${label}:${path.basename(root)}`, attachments: [] }; },
    resolveLaunchProfileForLane: () => null,
    recordRoutingTelemetry() {},
    dispatchPreparedTurn: CyberbossApp.prototype.dispatchPreparedTurn,
    prepareHandoffForSubjectTurnFailOpen: CyberbossApp.prototype.prepareHandoffForSubjectTurnFailOpen,
    completeHandoffDeliveryFailOpen: CyberbossApp.prototype.completeHandoffDeliveryFailOpen,
    failHandoffDeliveryFailOpen: CyberbossApp.prototype.failHandoffDeliveryFailOpen,
    recordContextTrace: CyberbossApp.prototype.recordContextTrace,
    issueSubjectCapabilityForTurnFailOpen: () => null,
  };
  const completed = await app.dispatchPreparedTurn({
    bindingKey: "workspace-e2e:telegram:500",
    workspaceRoot: root,
    prepared: {
      provider: "telegram",
      workspaceId: "workspace-e2e",
      accountId: "telegram",
      senderId: "500",
      chatId: "500",
      messageThreadId: "77",
      messageId: `message-${label}`,
      originalText: label,
      text: label,
    },
    lane,
  });
  assert.equal(completed, true);
  assert.match(runtimeTexts[0], new RegExp(`USER_TURN_COMPLETED:${label}`, "u"));
}

function leaseDetails(writer) {
  return {
    writer,
    model: "test",
    phase: "g2-9",
    branch: "test",
    worktree: "test",
    base_sha: "0".repeat(40),
  };
}
