"use strict";

const {
  appendJsonlUnique,
  readJsonl,
  sha256,
} = require("./continuity-store");
const { selectEffectiveDecisions } = require("./effective-decision");
const { REVIEW_WRITER } = require("./review-artifacts");

const PUBLICATION_INTENT_SCHEMA_VERSION = 1;
const PUBLICATION_INTENT_RESULT = "publish";
const STALE_INTENT_EVENT = "stale_intent";
const INVALID_INTENT_EVENT = "publication_intent_invalid";
const LINEAGE_AMBIGUOUS_EVENT = "candidate_lineage_ambiguous";

function materializePublicationIntents({
  writer,
  paths,
  candidates,
  decisions,
  publishedCandidateIds = [],
  enabled,
  createdAt = new Date().toISOString(),
}) {
  if (writer !== REVIEW_WRITER) {
    throw new Error(`publication intents require writer=${REVIEW_WRITER}`);
  }

  const candidateRows = Array.isArray(candidates) ? candidates : [];
  const decisionRows = Array.isArray(decisions) ? decisions : [];
  const byCandidate = new Map(candidateRows.map((item) => [normalizeText(item?.candidate_id), item]));
  const selected = selectEffectiveDecisions(decisionRows);
  const lineages = analyzeCandidateLineages(candidateRows, { publishedCandidateIds });
  const result = {
    publication_intent_complete: true,
    publication_intent_ids: [],
    errors: [],
  };

  for (const decision of selected.effectiveByCandidate.values()) {
    if (decision.result !== "accepted") continue;
    const candidate = byCandidate.get(decision.candidate_id);
    if (!candidate) {
      result.errors.push(intentError(candidate, decision, "candidate_missing", "effective decision candidate is missing"));
      continue;
    }
    if (enabled !== true) {
      result.errors.push(intentError(
        candidate,
        decision,
        "publication_intents_disabled",
        "publication intent materialization is disabled",
      ));
      continue;
    }

    const lineage = lineages.byCandidate.get(candidate.candidate_id);
    if (!lineage || lineage.status !== "valid") {
      result.errors.push(intentError(
        candidate,
        decision,
        lineage?.code || LINEAGE_AMBIGUOUS_EVENT,
        lineage?.message || "candidate lineage cannot be resolved uniquely",
      ));
      continue;
    }
    // An accepted decision on an older draft never makes that draft publishable
    // again. Only the unique effective leaf may cross the Review→History outbox.
    if (lineage.is_leaf !== true) continue;

    const missingArtifacts = findMissingRequiredArtifacts({
      paths,
      candidate,
      effectiveDecision: decision,
      decisions: decisionRows,
    });
    if (missingArtifacts.length) {
      result.errors.push(...missingArtifacts.map((artifact) => intentError(
        candidate,
        decision,
        "required_review_artifact_missing",
        `required ${artifact} is missing`,
        { required_artifact: artifact },
      )));
      continue;
    }

    try {
      const intent = createPublicationIntent({
        candidate,
        effectiveDecision: decision,
        candidateLineageRootId: lineage.root_id,
        createdAt,
      });
      appendAndVerifyIntent(paths.publicationIntents, intent);
      result.publication_intent_ids.push(intent.publication_intent_id);
    } catch (error) {
      result.errors.push(intentError(
        candidate,
        decision,
        typeof error.code === "string" && error.code.startsWith("publication_intent_")
          ? error.code
          : "publication_intent_write_failed",
        error.message || String(error),
      ));
    }
  }

  result.publication_intent_complete = result.errors.length === 0;
  return result;
}

function createPublicationIntent({
  candidate,
  effectiveDecision,
  candidateLineageRootId,
  createdAt,
}) {
  const candidateId = requireText(candidate?.candidate_id, "candidate_id");
  const decisionId = requireText(effectiveDecision?.decision_id, "effective_decision_id");
  const lineageRootId = requireText(candidateLineageRootId, "candidate_lineage_root_id");
  if (effectiveDecision?.candidate_id !== candidateId || effectiveDecision?.result !== "accepted") {
    throw intentFailure("effective_decision_invalid", "publication intent requires the candidate's accepted effective decision");
  }
  const timestamp = requireText(createdAt, "created_at");
  if (Number.isNaN(Date.parse(timestamp))) {
    throw intentFailure("created_at_invalid", "created_at must be ISO-8601");
  }
  return {
    schema_version: PUBLICATION_INTENT_SCHEMA_VERSION,
    publication_intent_id: publicationIntentId(candidateId, decisionId),
    publication_key: publicationKey(lineageRootId),
    candidate_id: candidateId,
    candidate_lineage_root_id: lineageRootId,
    effective_decision_id: decisionId,
    result: PUBLICATION_INTENT_RESULT,
    review_run_id: `review-${sha256(decisionId).slice(0, 20)}`,
    created_at: timestamp,
    artifact_digest: publicationArtifactDigest(candidate, effectiveDecision),
  };
}

function validatePublicationIntent({
  intent,
  candidate,
  decision,
  effectiveDecision,
  lineage,
}) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return invalid("intent_not_object", "publication intent must be an object");
  }
  if (intent.schema_version !== PUBLICATION_INTENT_SCHEMA_VERSION) {
    return invalid("schema_version_invalid", "publication intent schema_version is invalid");
  }
  if (intent.result !== PUBLICATION_INTENT_RESULT) {
    return invalid("result_invalid", "publication intent result must be publish");
  }
  if (
    !/^review-[0-9a-f]{20}$/u.test(normalizeText(intent.review_run_id))
    || Number.isNaN(Date.parse(intent.created_at))
  ) {
    return invalid("intent_metadata_invalid", "publication intent review_run_id or created_at is invalid");
  }
  if (!candidate || !decision) {
    return invalid("intent_reference_missing", "publication intent candidate or decision is missing");
  }
  if (intent.candidate_id !== candidate.candidate_id || intent.effective_decision_id !== decision.decision_id) {
    return invalid("intent_reference_mismatch", "publication intent references do not match persisted records");
  }
  if (decision.candidate_id !== candidate.candidate_id || decision.result !== "accepted") {
    return invalid("intent_decision_invalid", "publication intent decision is not accepted for its candidate");
  }
  if (intent.publication_intent_id !== publicationIntentId(candidate.candidate_id, decision.decision_id)) {
    return invalid("publication_intent_id_invalid", "publication_intent_id is not the stable candidate/decision ID");
  }
  if (!lineage || lineage.status !== "valid") {
    return {
      ok: false,
      event: LINEAGE_AMBIGUOUS_EVENT,
      code: lineage?.code || LINEAGE_AMBIGUOUS_EVENT,
      message: lineage?.message || "candidate lineage cannot be resolved uniquely",
    };
  }
  if (lineage.is_leaf !== true) {
    return {
      ok: false,
      event: LINEAGE_AMBIGUOUS_EVENT,
      code: "candidate_not_lineage_leaf",
      message: "publication intent candidate is not the effective lineage leaf",
    };
  }
  if (
    intent.candidate_lineage_root_id !== lineage.root_id
    || intent.publication_key !== publicationKey(lineage.root_id)
  ) {
    return invalid("publication_key_invalid", "publication intent lineage root or publication key is invalid");
  }
  if (intent.artifact_digest !== publicationArtifactDigest(candidate, decision)) {
    return invalid("artifact_digest_mismatch", "publication intent artifact digest does not match persisted inputs");
  }
  if (
    !effectiveDecision
    || effectiveDecision.decision_id !== decision.decision_id
    || effectiveDecision.result !== "accepted"
  ) {
    return {
      ok: false,
      event: STALE_INTENT_EVENT,
      code: STALE_INTENT_EVENT,
      message: "publication intent no longer points to the accepted effective decision",
    };
  }
  return { ok: true };
}

function analyzeCandidateLineages(candidates = [], { publishedCandidateIds = [] } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const published = new Set(
    Array.from(publishedCandidateIds || []).map(normalizeText).filter(Boolean),
  );
  const byId = new Map();
  const duplicateIds = new Set();
  for (const candidate of rows) {
    const candidateId = normalizeText(candidate?.candidate_id);
    if (!candidateId) continue;
    if (byId.has(candidateId)) duplicateIds.add(candidateId);
    else byId.set(candidateId, candidate);
  }

  const children = new Map();
  for (const [candidateId, candidate] of byId) {
    const hasPredecessorField = Object.prototype.hasOwnProperty.call(
      candidate || {},
      "supersedes_candidate_id",
    );
    if (!hasPredecessorField || candidate.supersedes_candidate_id == null) continue;
    if (typeof candidate.supersedes_candidate_id !== "string") continue;
    const predecessorId = normalizeText(candidate.supersedes_candidate_id);
    if (!predecessorId) continue;
    if (!children.has(predecessorId)) children.set(predecessorId, []);
    children.get(predecessorId).push(candidateId);
  }

  const byCandidate = new Map();
  for (const [candidateId, candidate] of byId) {
    if (duplicateIds.has(candidateId)) {
      byCandidate.set(candidateId, lineageInvalid("candidate_id_duplicate", "candidate_id is duplicated"));
      continue;
    }
    const visited = new Set();
    let cursor = candidate;
    let failure = null;
    while (cursor) {
      const cursorId = normalizeText(cursor.candidate_id);
      if (visited.has(cursorId)) {
        failure = lineageInvalid("candidate_lineage_cycle", "candidate lineage contains a cycle");
        break;
      }
      visited.add(cursorId);
      const hasPredecessorField = Object.prototype.hasOwnProperty.call(
        cursor || {},
        "supersedes_candidate_id",
      );
      if (
        hasPredecessorField
        && cursor.supersedes_candidate_id != null
        && typeof cursor.supersedes_candidate_id !== "string"
      ) {
        failure = lineageInvalid(
          "supersedes_candidate_id_invalid",
          "supersedes_candidate_id must be a non-empty string when present",
        );
        break;
      }
      const predecessorId = normalizeText(cursor.supersedes_candidate_id);
      if (hasPredecessorField && cursor.supersedes_candidate_id != null && !predecessorId) {
        failure = lineageInvalid(
          "supersedes_candidate_id_invalid",
          "supersedes_candidate_id must be a non-empty string when present",
        );
        break;
      }
      if (!predecessorId) break;
      const predecessor = byId.get(predecessorId);
      if (!predecessor || duplicateIds.has(predecessorId)) {
        failure = lineageInvalid("candidate_predecessor_missing", "candidate lineage predecessor is missing or ambiguous");
        break;
      }
      if (normalizeText(predecessor.type) !== normalizeText(candidate.type)) {
        failure = lineageInvalid("candidate_lineage_type_mismatch", "candidate lineage crosses candidate types");
        break;
      }
      if (published.has(predecessorId)) {
        failure = lineageInvalid(
          "candidate_predecessor_already_published",
          "published candidates must be changed through canon correction semantics",
        );
        break;
      }
      cursor = predecessor;
    }
    if (failure) byCandidate.set(candidateId, failure);
    else byCandidate.set(candidateId, {
      status: "valid",
      root_id: normalizeText(cursor.candidate_id),
      is_leaf: (children.get(candidateId) || []).length === 0,
    });
  }

  const groups = new Map();
  for (const [candidateId, lineage] of byCandidate) {
    if (lineage.status !== "valid") continue;
    if (!groups.has(lineage.root_id)) groups.set(lineage.root_id, []);
    groups.get(lineage.root_id).push(candidateId);
  }
  for (const [rootId, candidateIds] of groups) {
    const leaves = candidateIds.filter(
      (candidateId) => (children.get(candidateId) || []).length === 0,
    );
    if (leaves.length === 1) continue;
    for (const candidateId of candidateIds) {
      byCandidate.set(candidateId, lineageInvalid(
        LINEAGE_AMBIGUOUS_EVENT,
        `candidate lineage ${rootId} has ${leaves.length} leaves`,
      ));
    }
  }
  return { byCandidate };
}

function findMissingRequiredArtifacts({
  paths,
  candidate,
  effectiveDecision,
  decisions,
}) {
  const byDecision = new Map(
    decisions
      .filter((item) => item?.candidate_id === candidate.candidate_id)
      .map((item) => [normalizeText(item.decision_id), item]),
  );
  const required = [];
  const visited = new Set();
  let cursor = effectiveDecision;
  while (cursor && !visited.has(cursor.decision_id)) {
    visited.add(cursor.decision_id);
    if (["deferred", "rejected"].includes(cursor.result)) required.push(cursor);
    cursor = cursor.supersedes_decision_id
      ? byDecision.get(normalizeText(cursor.supersedes_decision_id))
      : null;
  }
  if (!required.length) return [];

  let cases;
  let envelopes;
  try {
    cases = new Set(readJsonl(paths.rejectionCases).map((item) => item?.case_id));
  } catch {
    return ["rejection_case_store_unreadable"];
  }
  try {
    envelopes = new Set(readJsonl(paths.handoffEnvelopes).map((item) => item?.handoff_id));
  } catch {
    return ["handoff_envelope_store_unreadable"];
  }
  const missing = [];
  for (const decision of required) {
    const suffix = sha256(`${candidate.candidate_id}\n${decision.decision_id}`).slice(0, 20);
    if (!cases.has(`case-${suffix}`)) missing.push(`rejection_case:${decision.decision_id}`);
    if (!envelopes.has(`handoff-${suffix}`)) missing.push(`handoff_envelope:${decision.decision_id}`);
  }
  return missing;
}

function publicationArtifactDigest(candidate, decision) {
  const decisionSnapshot = {
    ...decision,
    review_revision: Number.isInteger(decision?.review_revision) ? decision.review_revision : 1,
    supersedes_decision_id: normalizeText(decision?.supersedes_decision_id) || null,
  };
  delete decisionSnapshot.supersedes_invalid;
  return sha256(stableJson({
    candidate,
    effective_decision: decisionSnapshot,
    source_proof: candidate?.source_ref || null,
  }));
}

function publicationIntentId(candidateId, decisionId) {
  return `intent-${sha256(`${candidateId}\n${decisionId}`).slice(0, 20)}`;
}

function publicationKey(lineageRootId) {
  return `publication-${sha256(lineageRootId).slice(0, 20)}`;
}

function appendAndVerifyIntent(filePath, intent) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw intentFailure("publication_intent_path_missing", "publication intent path is required");
  }
  appendJsonlUnique(filePath, [intent], "publication_intent_id");
  const persisted = readJsonl(filePath).find(
    (item) => item?.publication_intent_id === intent.publication_intent_id,
  );
  if (!persisted) {
    throw intentFailure("publication_intent_write_unverified", "publication intent was not persisted");
  }
  const expected = { ...intent };
  const actual = { ...persisted };
  delete expected.created_at;
  delete actual.created_at;
  if (stableJson(actual) !== stableJson(expected)) {
    throw intentFailure(
      "publication_intent_id_collision",
      "publication_intent_id exists with different immutable content",
    );
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function invalid(code, message) {
  return { ok: false, event: INVALID_INTENT_EVENT, code, message };
}

function lineageInvalid(code, message) {
  return { status: "ambiguous", code, message };
}

function intentError(candidate, decision, code, message, extra = {}) {
  return {
    artifact: "publication_intent",
    candidate_id: normalizeText(candidate?.candidate_id),
    effective_decision_id: normalizeText(decision?.decision_id),
    code,
    message,
    ...extra,
  };
}

function intentFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, label) {
  const text = normalizeText(value);
  if (!text) throw intentFailure("publication_intent_schema_invalid", `${label} is required`);
  return text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  INVALID_INTENT_EVENT,
  LINEAGE_AMBIGUOUS_EVENT,
  PUBLICATION_INTENT_RESULT,
  PUBLICATION_INTENT_SCHEMA_VERSION,
  STALE_INTENT_EVENT,
  analyzeCandidateLineages,
  createPublicationIntent,
  materializePublicationIntents,
  publicationArtifactDigest,
  publicationIntentId,
  publicationKey,
  validatePublicationIntent,
};
