const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ContinuityPipeline,
} = require("../src/continuity/continuity-pipeline");
const {
  HANDOFF_DISPATCHER_WRITER,
  HANDOFF_ENVELOPE_SCHEMA_VERSION,
  LEGACY_HANDOFF_ENVELOPE_SCHEMA_VERSION,
  MACHINE_REASON_CODES,
  MAX_CANDIDATE_BODY_BYTES,
  MAX_REASON_CHECKS_BYTES,
  RECORD_DEFINITIONS,
  REVIEW_WRITER,
  REVIEW_WRITER_RECORDS,
  SUBJECT_CONTEXT_INJECTOR_WRITER,
  materializeReviewArtifacts,
  readHandoffEnvelopes,
  reviewArtifactPaths,
} = require("../src/continuity/review-artifacts");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { runReviewCheckpointed } = require("../src/continuity/review-checkpoint");
const { appendJsonlUnique, readJsonl } = require("../src/continuity/continuity-store");

const FIXED_REVIEW_TIME = "2026-07-31T01:02:03.000Z";

test("deferred Review synchronously materializes verbatim envelope and immutable on-demand case", () => {
  const fixture = createFixture();
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-verbatim",
    body: "  原文开头两个空格。\n第二行结尾也保留。  ",
    semantic_authority: "none",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");
  const leaseWriters = captureArtifactLeaseWriters(fixture);

  const review = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "defer" },
  });
  assert.equal(review.status, "success");
  assert.equal(review.decisions.length, 1);
  assert.equal(review.decisions[0].result, "deferred");
  assert.equal(review.artifact_complete, true);
  assert.deepEqual(review.artifact_errors, []);
  assert.deepEqual(leaseWriters, [REVIEW_WRITER]);

  const envelopes = readJsonl(fixture.pipeline.paths.handoffEnvelopes);
  const cases = readJsonl(fixture.pipeline.paths.rejectionCases);
  assert.equal(envelopes.length, 1);
  assert.equal(cases.length, 1);
  const envelope = envelopes[0];
  const rejectionCase = cases[0];

  assert.deepEqual(Object.keys(envelope), [
    "schema_version",
    "handoff_id",
    "candidate_id",
    "effective_decision_id",
    "candidate_type",
    "candidate_body",
    "reason",
    "subject_route",
    "created_at",
    "content_sha256",
  ]);
  assert.equal(envelope.schema_version, HANDOFF_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.subject_route.route_fingerprint, candidate.subject_route.route_fingerprint);
  assert.equal(envelope.candidate_body, candidate.body);
  assert.equal(envelope.reason.code, "semantic_authority_missing");
  assert.equal(envelope.reason.message, "候选缺少进入正史所需的语义写入权。");
  assert.deepEqual(envelope.reason.checks, review.decisions[0].checks);
  assert.equal(envelope.created_at, FIXED_REVIEW_TIME);
  assert.equal(envelope.content_sha256, sha256(candidate.body));
  assert.match(envelope.handoff_id, /^handoff-[0-9a-f]{20}$/u);

  assert.deepEqual(Object.keys(rejectionCase), [
    "case_id",
    "candidate_id",
    "effective_decision_id",
    "candidate_type",
    "candidate_body",
    "reason",
    "source_ref_digest",
    "created_at",
    "schema_version",
    "subject_route_fingerprint",
  ]);
  assert.equal(
    rejectionCase.subject_route_fingerprint,
    candidate.subject_route.route_fingerprint,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(rejectionCase, "rewrite_candidate_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rejectionCase, "improved"), false);
  assert.equal(rejectionCase.candidate_body, candidate.body);
  assert.deepEqual(rejectionCase.reason, envelope.reason);
  assert.equal(rejectionCase.source_ref_digest, sha256(JSON.stringify(candidate.source_ref)));
  assert.equal(rejectionCase.created_at, FIXED_REVIEW_TIME);
  assert.equal(rejectionCase.schema_version, 1);
  assert.match(rejectionCase.case_id, /^case-[0-9a-f]{20}$/u);
  assert.equal(RECORD_DEFINITIONS.rejection_case.context_tier, "on_demand");

  const beforeEnvelope = fs.readFileSync(fixture.pipeline.paths.handoffEnvelopes, "utf8");
  const beforeCase = fs.readFileSync(fixture.pipeline.paths.rejectionCases, "utf8");
  const rerun = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "defer" } });
  assert.equal(rerun.decisions.length, 0);
  assert.equal(rerun.artifact_complete, true);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.handoffEnvelopes, "utf8"), beforeEnvelope);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.rejectionCases, "utf8"), beforeCase);
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffDeliveryEvents), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffAckEvents), false);
});

test("subject_route is required, exact, and validated by the authoritative schema", () => {
  const fixture = createFixture();
  const subjectRoute = exactSubjectRoute();
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-route",
    body: "候选正文逐字保留。",
    subject_route: subjectRoute,
    semantic_authority: "none",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");

  const review = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "defer" },
  });
  assert.equal(review.artifact_complete, true);
  const envelope = readJsonl(fixture.pipeline.paths.handoffEnvelopes)[0];
  const rejectionCase = readJsonl(fixture.pipeline.paths.rejectionCases)[0];
  assert.equal(JSON.stringify(envelope.subject_route), JSON.stringify(subjectRoute));
  assert.equal(
    rejectionCase.subject_route_fingerprint,
    subjectRoute.route_fingerprint,
  );
  assert.equal(
    RECORD_DEFINITIONS.handoff_envelope.schema.properties.subject_route,
    require("../src/continuity/subject-route").SUBJECT_ROUTE_SCHEMA,
  );

  const missingRoute = candidateRow(fixture, {
    candidate_id: "cand-route-missing",
    semantic_authority: "none",
  });
  delete missingRoute.subject_route;
  const missingOutcome = materializeReviewArtifacts({
    writer: REVIEW_WRITER,
    paths: reviewArtifactPaths(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-route-required-"))),
    candidate: missingRoute,
    effectiveDecision: {
      decision_id: "decision-route-missing",
      candidate_id: missingRoute.candidate_id,
      result: "deferred",
      reason: "publication_not_allowed",
      checks: {},
    },
    createdAt: FIXED_REVIEW_TIME,
  });
  assert.equal(missingOutcome.artifact_complete, false);
  assert.equal(
    missingOutcome.errors.some((item) => item.code === "subject_route_partial"),
    true,
  );
});

test("schema v1 envelope without subject_route is readable only as non-routeable legacy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-envelope-legacy-"));
  const filePath = reviewArtifactPaths(root).handoffEnvelopes;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    schema_version: LEGACY_HANDOFF_ENVELOPE_SCHEMA_VERSION,
    handoff_id: "handoff-legacy",
    candidate_id: "cand-legacy",
  })}\n`, "utf8");

  const [legacy] = readHandoffEnvelopes(filePath);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.route_status, "LEGACY_SUBJECT_ROUTE_MISSING");
  assert.equal(legacy.dispatch_eligible, false);
  assert.equal(Object.hasOwn(legacy.record, "subject_route"), false);
});

test("handoff records declare separate writers and Review has no delivery or ack write surface", () => {
  assert.equal(RECORD_DEFINITIONS.handoff_envelope.writer, REVIEW_WRITER);
  assert.equal(RECORD_DEFINITIONS.handoff_delivery_event.writer, HANDOFF_DISPATCHER_WRITER);
  assert.equal(RECORD_DEFINITIONS.handoff_ack_event.writer, SUBJECT_CONTEXT_INJECTOR_WRITER);
  assert.equal(RECORD_DEFINITIONS.handoff_envelope.relative_path, "handoffs/envelopes.jsonl");
  assert.equal(
    RECORD_DEFINITIONS.handoff_delivery_event.relative_path,
    ".jobs/handoff-delivery-events.jsonl",
  );
  assert.equal(RECORD_DEFINITIONS.handoff_ack_event.relative_path, ".jobs/handoff-ack-events.jsonl");
  assert.equal(
    RECORD_DEFINITIONS.publication_intent.relative_path,
    "decisions/publication-intents.jsonl",
  );
  assert.equal(RECORD_DEFINITIONS.publication_intent.writer, REVIEW_WRITER);
  assert.deepEqual(
    REVIEW_WRITER_RECORDS,
    ["handoff_envelope", "rejection_case", "publication_intent"],
  );
  assert.equal(REVIEW_WRITER_RECORDS.includes("handoff_delivery_event"), false);
  assert.equal(REVIEW_WRITER_RECORDS.includes("handoff_ack_event"), false);
  assert.equal(MACHINE_REASON_CODES.has("over_budget"), true);
  assert.equal(MACHINE_REASON_CODES.has("reject_conflict"), false);
  assert.deepEqual(
    RECORD_DEFINITIONS.handoff_delivery_event.schema.properties.result.enum,
    ["delivered", "retryable_failed", "terminal_failed", "window_gone"],
  );
  assert.deepEqual(
    RECORD_DEFINITIONS.handoff_delivery_event.schema.properties.trigger.enum,
    ["synchronous", "next_subject_turn"],
  );
  assert.deepEqual(
    RECORD_DEFINITIONS.handoff_ack_event.schema.properties.disposition.enum,
    ["rewrite_submitted", "abandoned", "read_only"],
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-writer-guard-"));
  assert.throws(
    () => materializeReviewArtifacts({
      writer: HANDOFF_DISPATCHER_WRITER,
      paths: reviewArtifactPaths(root),
      candidate: { candidate_id: "cand-guard" },
      effectiveDecision: { decision_id: "decision-guard" },
    }),
    /require writer=review-writer/u,
  );
  const semanticVerdict = materializeReviewArtifacts({
    writer: REVIEW_WRITER,
    paths: reviewArtifactPaths(root),
    candidate: {
      candidate_id: "cand-semantic-verdict",
      type: "episode",
      body: "语义疑虑不能伪装成机器硬闸原因。",
      source_ref: {},
    },
    effectiveDecision: {
      decision_id: "decision-semantic-verdict",
      candidate_id: "cand-semantic-verdict",
      result: "rejected",
      reason: "reject_conflict",
      checks: {},
    },
    createdAt: FIXED_REVIEW_TIME,
  });
  assert.equal(semanticVerdict.artifact_complete, false);
  assert.equal(
    semanticVerdict.errors[0].code,
    "reason_code_not_machine_determinable",
  );
});

test("artifact write failure is fail-open, blocks artifact completion, and repairs idempotently", () => {
  const fixture = createFixture();
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-repair",
    body: "这条打回先模拟案例库写失败。",
    semantic_authority: "none",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");
  fs.mkdirSync(fixture.pipeline.paths.rejectionCases, { recursive: true });
  const leaseWriters = captureArtifactLeaseWriters(fixture);

  const first = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "defer" },
  });
  assert.equal(first.status, "success");
  assert.equal(first.decisions.length, 1);
  assert.equal(first.decisions[0].result, "deferred");
  assert.equal(Object.prototype.hasOwnProperty.call(first.decisions[0], "artifact_complete"), false);
  assert.equal(first.artifact_complete, false);
  assert.equal(first.artifact_errors.some((item) => item.artifact === "rejection_case"), true);
  assert.deepEqual(leaseWriters, [REVIEW_WRITER]);
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffEnvelopes), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffDeliveryEvents), false);
  assert.equal(
    fs.existsSync(path.join(fixture.continuityDir, "decisions", "publication-intents.jsonl")),
    false,
  );
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);

  fs.rmdirSync(fixture.pipeline.paths.rejectionCases);
  const repaired = fixture.pipeline.repairReviewArtifacts();
  assert.equal(repaired.status, "success");
  assert.equal(repaired.artifact_complete, true);
  assert.equal(readJsonl(fixture.pipeline.paths.handoffEnvelopes).length, 1);
  assert.equal(readJsonl(fixture.pipeline.paths.rejectionCases).length, 1);
  assert.deepEqual(leaseWriters, [REVIEW_WRITER, REVIEW_WRITER]);

  const before = fs.readFileSync(fixture.pipeline.paths.rejectionCases, "utf8");
  const secondRepair = fixture.pipeline.repairReviewArtifacts();
  assert.equal(secondRepair.artifact_complete, true);
  assert.equal(fs.readFileSync(fixture.pipeline.paths.rejectionCases, "utf8"), before);
});

test("oversized candidate bodies and reason checks are rejected without truncation", () => {
  const fixture = createFixture();
  const body = "她".repeat(MAX_CANDIDATE_BODY_BYTES);
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-too-large",
    body,
    author_role: "background_proxy",
    semantic_authority: "none",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");

  const review = fixture.pipeline.runReview({
    env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" },
  });
  assert.equal(review.status, "success");
  assert.equal(review.decisions[0].result, "deferred");
  assert.equal(review.artifact_complete, false);
  assert.equal(
    review.artifact_errors.every((item) => item.code === "candidate_body_over_budget"),
    true,
  );
  assert.equal(readJsonl(fixture.pipeline.paths.candidates)[0].body, body);
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffEnvelopes), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.rejectionCases), false);
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);

  const reasonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-reason-budget-"));
  const reasonOutcome = materializeReviewArtifacts({
    writer: REVIEW_WRITER,
    paths: reviewArtifactPaths(reasonRoot),
    candidate: {
      candidate_id: "cand-reason-large",
      type: "episode",
      body: "正文不大。",
      source_ref: {},
    },
    effectiveDecision: {
      decision_id: "decision-reason-large",
      candidate_id: "cand-reason-large",
      result: "deferred",
      reason: "over_budget",
      checks: { detail: "x".repeat(MAX_REASON_CHECKS_BYTES) },
    },
    createdAt: FIXED_REVIEW_TIME,
  });
  assert.equal(reasonOutcome.artifact_complete, false);
  assert.equal(
    reasonOutcome.errors.every((item) => item.code === "reason_checks_over_budget"),
    true,
  );
  assert.equal(fs.existsSync(reviewArtifactPaths(reasonRoot).handoffEnvelopes), false);
  assert.equal(fs.existsSync(reviewArtifactPaths(reasonRoot).rejectionCases), false);
});

test("checkpoint authority deferral materializes artifacts under the same Review lease", () => {
  const fixture = createFixture();
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-checkpoint-authority",
    body: "后台代理只能把这条候选同步打回主体。",
    author: "janitor",
    origin: "janitor_legacy",
    author_role: "extractor",
    author_model: "fixture-extractor",
    context_scope: "isolated_chunk",
    semantic_authority: "none",
    needs_subject_review: true,
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");
  const leaseWriters = captureArtifactLeaseWriters(fixture);

  const result = runReviewCheckpointed(fixture.pipeline);
  assert.equal(result.status, "success");
  assert.equal(result.authority_deferred, 1);
  assert.equal(result.artifact_complete, true);
  assert.equal(readJsonl(fixture.pipeline.paths.decisions)[0].result, "deferred");
  assert.equal(readJsonl(fixture.pipeline.paths.handoffEnvelopes).length, 1);
  assert.equal(readJsonl(fixture.pipeline.paths.rejectionCases).length, 1);
  assert.deepEqual(leaseWriters, [REVIEW_WRITER, REVIEW_WRITER]);
});

test("review artifact materialization defaults off and leaves existing Review fail-open", () => {
  const fixture = createFixture({ omitReviewArtifactsOption: true });
  assert.equal(fixture.pipeline.reviewArtifactsEnabled, false);
  const candidate = candidateRow(fixture, {
    candidate_id: "cand-default-off",
    body: "默认关闭时仍持久化 decision，但不写新 artifact。",
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");

  const review = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "defer" },
  });
  assert.equal(review.status, "success");
  assert.equal(review.decisions.length, 1);
  assert.equal(review.artifact_complete, false);
  assert.equal(review.artifact_errors[0].code, "review_artifacts_disabled");
  assert.equal(fs.existsSync(fixture.pipeline.paths.handoffEnvelopes), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.rejectionCases), false);
});

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-artifacts-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-31.jsonl");
  const writerLeaseFile = path.join(root, "MEMORY_WRITER_LEASE.json");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(
    conversationFile,
    [
      JSON.stringify({ type: "user", text: "来源第一行" }),
      JSON.stringify({ type: "assistant", text: "来源第二行" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const pipelineOptions = {
    continuityDir,
    conversationDir,
    writerLeaseFile,
    reviewScript: path.resolve(
      __dirname,
      "../extensions/relationship-memory/memory-kit/auto_review.py",
    ),
    python: process.env.PYTHON || "python",
    branch: "fixture",
    worktree: root,
    baseSha: "a".repeat(40),
    now: () => new Date(FIXED_REVIEW_TIME),
  };
  if (options.omitReviewArtifactsOption !== true) pipelineOptions.reviewArtifactsEnabled = true;
  const pipeline = new ContinuityPipeline(pipelineOptions);
  return {
    root,
    continuityDir,
    conversationDir,
    conversationFile,
    writerLeaseFile,
    pipeline,
  };
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
    source_ref: { file: fixture.conversationFile, window: "1-2" },
    subject_route: exactSubjectRoute(),
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
    source_entry_ids: ["entry-fixture-1", "entry-fixture-2"],
  });
}

function captureArtifactLeaseWriters(fixture) {
  const writers = [];
  const materialize = fixture.pipeline.materializeEffectiveReviewArtifacts.bind(fixture.pipeline);
  fixture.pipeline.materializeEffectiveReviewArtifacts = (...args) => {
    const lease = JSON.parse(fs.readFileSync(fixture.writerLeaseFile, "utf8"));
    writers.push(lease.writer);
    return materialize(...args);
  };
  return writers;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}
