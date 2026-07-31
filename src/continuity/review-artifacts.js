const path = require("path");

const { appendJsonlUnique, readJsonl, sha256 } = require("./continuity-store");
const {
  ROUTE_EXACT,
  SUBJECT_ROUTE_SCHEMA,
  assertExactSubjectRoute,
  validateSubjectRoute,
} = require("./subject-route");

const REVIEW_WRITER = "review-writer";
const HANDOFF_DISPATCHER_WRITER = "handoff-dispatcher";
const SUBJECT_CONTEXT_INJECTOR_WRITER = "subject-context-injector";
const HANDOFF_ENVELOPE_SCHEMA_VERSION = 2;
const LEGACY_HANDOFF_ENVELOPE_SCHEMA_VERSION = 1;

const MAX_CANDIDATE_BODY_BYTES = 64 * 1024;
const MAX_REASON_CODE_BYTES = 128;
const MAX_REASON_MESSAGE_BYTES = 512;
const MAX_REASON_CHECKS_BYTES = 32 * 1024;

const MACHINE_REASON_CODES = new Set([
  "imperative_style",
  "invalid_input",
  "over_budget",
  "publication_not_allowed",
  "review_invalid_output",
  "review_model_failed",
  "review_model_unavailable",
  "review_unavailable",
  "safety_failed",
  "semantic_authority_missing",
  "semantic_question",
  "source_ref_missing",
  "subject_review_required",
]);

const RECORD_DEFINITIONS = deepFreeze({
  handoff_envelope: {
    relative_path: "handoffs/envelopes.jsonl",
    writer: REVIEW_WRITER,
    context_tier: "on_demand",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
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
      ],
      properties: {
        schema_version: { const: HANDOFF_ENVELOPE_SCHEMA_VERSION },
        handoff_id: { type: "string", pattern: "^handoff-[0-9a-f]{20}$" },
        candidate_id: { type: "string", minLength: 1 },
        effective_decision_id: { type: "string", minLength: 1 },
        candidate_type: { type: "string", minLength: 1 },
        candidate_body: { type: "string", maxUtf8Bytes: MAX_CANDIDATE_BODY_BYTES },
        reason: {
          type: "object",
          required: ["code", "message", "checks"],
          additionalProperties: false,
        },
        subject_route: SUBJECT_ROUTE_SCHEMA,
        created_at: { type: "string", format: "date-time" },
        content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
  },
  rejection_case: {
    relative_path: "review/rejection-cases.jsonl",
    writer: REVIEW_WRITER,
    context_tier: "on_demand",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "case_id",
        "candidate_id",
        "effective_decision_id",
        "candidate_type",
        "candidate_body",
        "reason",
        "source_ref_digest",
        "created_at",
        "schema_version",
      ],
      optional: ["subject_route_fingerprint"],
      forbidden: ["rewrite_candidate_id", "improved"],
      properties: {
        case_id: { type: "string", pattern: "^case-[0-9a-f]{20}$" },
        candidate_id: { type: "string", minLength: 1 },
        effective_decision_id: { type: "string", minLength: 1 },
        candidate_type: { type: "string", minLength: 1 },
        candidate_body: { type: "string", maxUtf8Bytes: MAX_CANDIDATE_BODY_BYTES },
        reason: {
          type: "object",
          required: ["code", "message", "checks"],
          additionalProperties: false,
        },
        source_ref_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
        subject_route_fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
        created_at: { type: "string", format: "date-time" },
        schema_version: { const: 1 },
      },
    },
  },
  publication_intent: {
    relative_path: "decisions/publication-intents.jsonl",
    writer: REVIEW_WRITER,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "publication_intent_id",
        "publication_key",
        "candidate_id",
        "candidate_lineage_root_id",
        "effective_decision_id",
        "result",
        "review_run_id",
        "created_at",
        "artifact_digest",
      ],
      properties: {
        schema_version: { const: 1 },
        publication_intent_id: { type: "string", pattern: "^intent-[0-9a-f]{20}$" },
        publication_key: { type: "string", pattern: "^publication-[0-9a-f]{20}$" },
        candidate_id: { type: "string", minLength: 1 },
        candidate_lineage_root_id: { type: "string", minLength: 1 },
        effective_decision_id: { type: "string", minLength: 1 },
        result: { const: "publish" },
        review_run_id: { type: "string", pattern: "^review-[0-9a-f]{20}$" },
        created_at: { type: "string", format: "date-time" },
        artifact_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
  },
  handoff_delivery_event: {
    relative_path: ".jobs/handoff-delivery-events.jsonl",
    writer: HANDOFF_DISPATCHER_WRITER,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "delivery_id",
        "handoff_id",
        "attempt",
        "trigger",
        "target_route_fingerprint",
        "started_at",
        "delivered_at",
        "result",
        "reason",
      ],
      properties: {
        delivery_id: { type: "string", minLength: 1 },
        handoff_id: { type: "string", minLength: 1 },
        attempt: { type: "integer", minimum: 1 },
        trigger: { enum: ["synchronous", "next_subject_turn"] },
        target_route_fingerprint: { type: "string", minLength: 1 },
        started_at: { type: "string", format: "date-time" },
        delivered_at: { type: ["string", "null"], format: "date-time" },
        result: { enum: ["delivered", "retryable_failed", "terminal_failed", "window_gone"] },
        reason: { type: "string" },
      },
    },
  },
  handoff_ack_event: {
    relative_path: ".jobs/handoff-ack-events.jsonl",
    writer: SUBJECT_CONTEXT_INJECTOR_WRITER,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "ack_id",
        "delivery_id",
        "handoff_id",
        "acknowledged_at",
        "subject_turn_id",
        "disposition",
      ],
      properties: {
        ack_id: { type: "string", minLength: 1 },
        delivery_id: { type: "string", minLength: 1 },
        handoff_id: { type: "string", minLength: 1 },
        acknowledged_at: { type: "string", format: "date-time" },
        subject_turn_id: { type: "string", minLength: 1 },
        disposition: { enum: ["rewrite_submitted", "abandoned", "read_only"] },
      },
    },
  },
});

const REVIEW_WRITER_RECORDS = Object.freeze([
  "handoff_envelope",
  "rejection_case",
  "publication_intent",
]);

function reviewArtifactPaths(continuityDir) {
  const root = path.resolve(continuityDir);
  return {
    handoffEnvelopes: path.join(root, ...RECORD_DEFINITIONS.handoff_envelope.relative_path.split("/")),
    rejectionCases: path.join(root, ...RECORD_DEFINITIONS.rejection_case.relative_path.split("/")),
    publicationIntents: path.join(root, ...RECORD_DEFINITIONS.publication_intent.relative_path.split("/")),
    handoffDeliveryEvents: path.join(root, ...RECORD_DEFINITIONS.handoff_delivery_event.relative_path.split("/")),
    handoffAckEvents: path.join(root, ...RECORD_DEFINITIONS.handoff_ack_event.relative_path.split("/")),
  };
}

function materializeReviewArtifacts({
  writer,
  paths,
  candidate,
  effectiveDecision,
  createdAt = new Date().toISOString(),
}) {
  if (writer !== REVIEW_WRITER) {
    throw new Error(`review artifacts require writer=${REVIEW_WRITER}`);
  }

  const envelopeId = stableArtifactId("handoff", candidate, effectiveDecision);
  const caseId = stableArtifactId("case", candidate, effectiveDecision);
  const result = {
    artifact_complete: true,
    handoff_ids: [],
    case_ids: [],
    errors: [],
  };

  // Case first, envelope second: an envelope is the future dispatcher's input.
  // It must never become visible while the required immutable case has a gap.
  try {
    const rejectionCase = createRejectionCase(candidate, effectiveDecision, createdAt);
    appendAndVerify(paths.rejectionCases, rejectionCase, "case_id");
    result.case_ids.push(caseId);
  } catch (error) {
    result.errors.push(artifactError("rejection_case", candidate, effectiveDecision, error));
  }

  if (!result.errors.length) {
    try {
      const envelope = createHandoffEnvelope(candidate, effectiveDecision, createdAt);
      appendAndVerify(paths.handoffEnvelopes, envelope, "handoff_id");
      result.handoff_ids.push(envelopeId);
    } catch (error) {
      result.errors.push(artifactError("handoff_envelope", candidate, effectiveDecision, error));
    }
  }

  result.artifact_complete = result.errors.length === 0;
  return result;
}

function createHandoffEnvelope(candidate = {}, effectiveDecision = {}, createdAt) {
  const common = artifactCommon(candidate, effectiveDecision, createdAt);
  const subjectRoute = requireSubjectRoute(candidate);
  const envelope = {
    schema_version: HANDOFF_ENVELOPE_SCHEMA_VERSION,
    handoff_id: stableArtifactId("handoff", candidate, effectiveDecision),
    candidate_id: common.candidate_id,
    effective_decision_id: common.effective_decision_id,
    candidate_type: common.candidate_type,
    candidate_body: common.candidate_body,
    reason: common.reason,
    subject_route: subjectRoute,
    created_at: common.created_at,
    content_sha256: sha256(common.candidate_body),
  };
  return envelope;
}

function createRejectionCase(candidate = {}, effectiveDecision = {}, createdAt) {
  const common = artifactCommon(candidate, effectiveDecision, createdAt);
  const rejectionCase = {
    case_id: stableArtifactId("case", candidate, effectiveDecision),
    candidate_id: common.candidate_id,
    effective_decision_id: common.effective_decision_id,
    candidate_type: common.candidate_type,
    candidate_body: common.candidate_body,
    reason: common.reason,
    source_ref_digest: sha256(jsonSnapshot(candidate.source_ref || {}, "source_ref")),
    created_at: common.created_at,
    schema_version: 1,
  };
  const route = optionalJsonSnapshot(candidate, "subject_route");
  if (route.present) {
    rejectionCase.subject_route_fingerprint = assertExactSubjectRoute(route.value).route_fingerprint;
  }
  return rejectionCase;
}

function readHandoffEnvelopes(filePath) {
  return readJsonl(filePath).map((record) => classifyHandoffEnvelopeForRead(record));
}

function classifyHandoffEnvelopeForRead(record = {}) {
  const snapshot = JSON.parse(jsonSnapshot(record, "handoff_envelope"));
  const schemaVersion = Number.isInteger(snapshot.schema_version)
    ? snapshot.schema_version
    : LEGACY_HANDOFF_ENVELOPE_SCHEMA_VERSION;

  // G2-3 shipped while subject_route was optional and the feature flag was
  // default-off. Keep those rows visible for audit/repair, but never let a
  // future dispatcher treat them as routeable input.
  if (schemaVersion === LEGACY_HANDOFF_ENVELOPE_SCHEMA_VERSION) {
    return deepFreeze({
      record: snapshot,
      schema_version: schemaVersion,
      legacy: true,
      route_status: Object.hasOwn(snapshot, "subject_route")
        ? "LEGACY_SUBJECT_ROUTE_UNVALIDATED"
        : "LEGACY_SUBJECT_ROUTE_MISSING",
      dispatch_eligible: false,
    });
  }

  const validation = validateSubjectRoute(snapshot.subject_route);
  const exact = schemaVersion === HANDOFF_ENVELOPE_SCHEMA_VERSION
    && validation.status === ROUTE_EXACT;
  return deepFreeze({
    record: snapshot,
    schema_version: schemaVersion,
    legacy: false,
    route_status: exact ? "SUBJECT_ROUTE_EXACT" : "SUBJECT_ROUTE_INVALID",
    dispatch_eligible: exact,
    route_validation: validation,
  });
}

function artifactCommon(candidate, effectiveDecision, createdAt) {
  const candidateId = requireText(candidate?.candidate_id, "candidate_id");
  const decisionId = requireText(effectiveDecision?.decision_id, "effective_decision_id");
  const candidateType = requireCode(candidate?.type, "candidate_type");
  if (!["deferred", "rejected"].includes(effectiveDecision?.result)) {
    throw artifactFailure("decision_result_not_rejected", "effective decision must be deferred or rejected");
  }
  if (effectiveDecision.candidate_id !== candidateId) {
    throw artifactFailure("candidate_decision_mismatch", "effective decision does not belong to candidate");
  }
  if (typeof candidate.body !== "string") {
    throw artifactFailure("candidate_body_invalid", "candidate_body must be a string");
  }
  enforceUtf8Budget(candidate.body, MAX_CANDIDATE_BODY_BYTES, "candidate_body_over_budget");
  const timestamp = requireText(createdAt, "created_at");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw artifactFailure("created_at_invalid", "created_at must be ISO-8601");
  }
  return {
    candidate_id: candidateId,
    effective_decision_id: decisionId,
    candidate_type: candidateType,
    candidate_body: candidate.body,
    reason: createReason(effectiveDecision),
    created_at: timestamp,
  };
}

function createReason(decision = {}) {
  const code = requireCode(decision.reason, "reason.code");
  enforceUtf8Budget(code, MAX_REASON_CODE_BYTES, "reason_code_over_budget");
  if (!MACHINE_REASON_CODES.has(code)) {
    throw artifactFailure(
      "reason_code_not_machine_determinable",
      `reason.code is not an approved machine-determinable code: ${code}`,
    );
  }
  const message = reasonMessage(code);
  enforceUtf8Budget(message, MAX_REASON_MESSAGE_BYTES, "reason_message_over_budget");
  const checksJson = jsonSnapshot(decision.checks || {}, "reason.checks");
  enforceUtf8Budget(checksJson, MAX_REASON_CHECKS_BYTES, "reason_checks_over_budget");
  return {
    code,
    message,
    checks: JSON.parse(checksJson),
  };
}

function reasonMessage(code) {
  const messages = {
    boundary_touch: "语义边界需要由原主体决定改写、重交或放弃。",
    imperative_style: "候选以指令式措辞开头，请由原主体决定如何处理。",
    over_budget: "候选超过内容预算；原文未截断。",
    publication_not_allowed: "候选没有进入正史所需的发布权限。",
    reject_conflict: "候选触及已确认边界，请由原主体决定如何处理。",
    safety_failed: "候选触发了机器可判定的安全检查。",
    semantic_authority_missing: "候选缺少进入正史所需的语义写入权。",
    semantic_question: "候选存在语义疑问，请由原主体决定改写、重交或放弃。",
    source_ref_missing: "候选来源无法定位。",
    subject_review_required: "候选需要原主体复核。",
  };
  return messages[code] || `Review 打回原因码：${code}`;
}

function stableArtifactId(prefix, candidate = {}, decision = {}) {
  const candidateId = requireText(candidate.candidate_id, "candidate_id");
  const decisionId = requireText(decision.decision_id, "effective_decision_id");
  return `${prefix}-${sha256(`${candidateId}\n${decisionId}`).slice(0, 20)}`;
}

function appendAndVerify(filePath, record, key) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw artifactFailure("artifact_path_missing", `${key} path is required`);
  }
  appendJsonlUnique(filePath, [record], key);
  const persisted = readJsonl(filePath).find((item) => item?.[key] === record[key]);
  if (!persisted) {
    throw artifactFailure("artifact_write_unverified", `${key} was not persisted`);
  }
  const expectedImmutable = { ...record };
  const persistedImmutable = { ...persisted };
  delete expectedImmutable.created_at;
  delete persistedImmutable.created_at;
  if (JSON.stringify(persistedImmutable) !== JSON.stringify(expectedImmutable)) {
    throw artifactFailure("artifact_id_collision", `${key} exists with different immutable content`);
  }
}

function optionalJsonSnapshot(value, key) {
  if (!Object.prototype.hasOwnProperty.call(value || {}, key) || value[key] === undefined) {
    return { present: false };
  }
  return { present: true, value: JSON.parse(jsonSnapshot(value[key], key)) };
}

function requireSubjectRoute(candidate) {
  if (!Object.hasOwn(candidate || {}, "subject_route") || candidate.subject_route === undefined) {
    const error = artifactFailure("subject_route_partial", "subject_route is required");
    throw error;
  }
  return assertExactSubjectRoute(candidate.subject_route);
}

function jsonSnapshot(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw artifactFailure("artifact_schema_invalid", `${label} must be JSON-serializable`);
  }
  if (encoded === undefined) {
    throw artifactFailure("artifact_schema_invalid", `${label} must be JSON-serializable`);
  }
  return encoded;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.length) {
    throw artifactFailure("artifact_schema_invalid", `${label} is required`);
  }
  return value;
}

function requireCode(value, label) {
  const text = requireText(value, label);
  if (!/^[a-z][a-z0-9_]*$/u.test(text)) {
    throw artifactFailure("reason_code_invalid", `${label} must be a machine-readable code`);
  }
  return text;
}

function enforceUtf8Budget(value, budget, code) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > budget) throw artifactFailure(code, `${code}: ${bytes} > ${budget} UTF-8 bytes`);
}

function artifactFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function artifactError(artifact, candidate = {}, decision = {}, error = {}) {
  return {
    artifact,
    candidate_id: typeof candidate.candidate_id === "string" ? candidate.candidate_id : "",
    effective_decision_id: typeof decision.decision_id === "string" ? decision.decision_id : "",
    code: typeof error.code === "string" ? error.code : "artifact_write_failed",
    message: typeof error.message === "string" ? error.message : "artifact materialization failed",
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

module.exports = {
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
  createHandoffEnvelope,
  createRejectionCase,
  readHandoffEnvelopes,
  materializeReviewArtifacts,
  reviewArtifactPaths,
};
