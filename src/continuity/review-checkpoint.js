const {
  authorityFailureReason,
  canPublishCandidate,
  normalizeCandidateMetadata,
} = require("./candidate-authority");
const {
  buildLocalChecks,
  createDecision,
  locateSourceRef,
} = require("./continuity-pipeline");
const { appendJsonlUnique, readJsonl } = require("./continuity-store");
const { selectEffectiveDecisionForCandidate } = require("./effective-decision");

function runReviewCheckpointed(pipeline, { retryCandidateId = "" } = {}) {
  if (!pipeline || typeof pipeline.runReview !== "function" || !pipeline.paths) {
    throw new Error("pipeline with runReview() and paths is required");
  }

  const requested = normalizeText(retryCandidateId);
  const candidates = readJsonl(pipeline.paths.candidates).map(normalizeCandidateMetadata);
  const existing = readJsonl(pipeline.paths.decisions);
  const decided = new Set(existing.map((item) => normalizeText(item?.candidate_id)).filter(Boolean));
  const decisions = [];
  let authorityDeferred = 0;
  let modelEligible = 0;

  for (const candidate of candidates) {
    const candidateId = normalizeText(candidate?.candidate_id);
    if (!candidateId) continue;
    if (requested && candidateId !== requested) continue;
    if (!requested && decided.has(candidateId)) continue;

    let result;
    if (!canPublishCandidate(candidate)) {
      result = persistAuthorityDeferred(pipeline, candidate, { allowRetry: Boolean(requested) });
      authorityDeferred += Array.isArray(result?.decisions) && result.decisions.length ? 1 : 0;
    } else {
      modelEligible += 1;
      // One pipeline call handles exactly one candidate and persists its decision
      // before this loop advances. An interruption can only lose the in-flight item.
      result = pipeline.runReview({ retryCandidateId: candidateId });
    }

    if (!result || result.status !== "success") {
      return {
        status: result?.status || "deferred",
        reason: result?.reason || "review_checkpoint_failed",
        decisions,
        stopped_at_candidate_id: candidateId,
        authority_deferred: authorityDeferred,
        model_eligible: modelEligible,
      };
    }

    const added = Array.isArray(result.decisions) ? result.decisions : [];
    decisions.push(...added);
    decided.add(candidateId);
  }

  return {
    status: "success",
    decisions,
    authority_deferred: authorityDeferred,
    model_eligible: modelEligible,
  };
}

function persistAuthorityDeferred(pipeline, candidate, { allowRetry = false } = {}) {
  if (typeof pipeline.withLease !== "function") {
    throw new Error("pipeline.withLease() is required for local authority decisions");
  }

  return pipeline.withLease("review-writer", () => {
    const existing = readJsonl(pipeline.paths.decisions);
    const existingForCandidate = existing.filter(
      (item) => normalizeText(item?.candidate_id) === candidate.candidate_id,
    );
    if (existingForCandidate.length && !allowRetry) {
      return { status: "success", decisions: [] };
    }
    const selected = selectEffectiveDecisionForCandidate(existing, candidate.candidate_id);
    if (existingForCandidate.length && !selected.decision) {
      return { status: "success", decisions: [], diagnostics: [selected.event] };
    }

    const sourceLocated = locateSourceRef(candidate.source_ref);
    const checks = buildLocalChecks(candidate, sourceLocated);
    const decision = createDecision(candidate, {
      result: "deferred",
      reason: authorityFailureReason(candidate),
      checks,
      review_revision: selected.decision ? selected.decision.review_revision + 1 : 1,
      supersedes_decision_id: selected.decision?.decision_id || null,
    });
    const added = appendJsonlUnique(pipeline.paths.decisions, [decision], "decision_id");
    return { status: "success", decisions: added };
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { runReviewCheckpointed };
