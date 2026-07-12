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

function runReviewAuthorityGated(pipeline, { retryCandidateId = "" } = {}) {
  if (!pipeline?.paths?.candidates || !pipeline?.paths?.decisions) {
    throw new Error("pipeline candidate and decision paths are required");
  }
  if (typeof pipeline.runReview !== "function") {
    throw new Error("pipeline.runReview is required");
  }

  const candidates = readJsonl(pipeline.paths.candidates).map(normalizeCandidateMetadata);
  const existing = readJsonl(pipeline.paths.decisions);
  const decided = new Set(existing.map((item) => item.candidate_id));
  const decisions = [];
  let modelEligible = 0;
  let authorityDeferred = 0;

  for (const candidate of candidates) {
    if (retryCandidateId && candidate.candidate_id !== retryCandidateId) continue;
    if (decided.has(candidate.candidate_id)) continue;

    if (!canPublishCandidate(candidate)) {
      const checks = buildLocalChecks(candidate, locateSourceRef(candidate.source_ref));
      const proposed = createDecision(candidate, {
        result: "deferred",
        reason: authorityFailureReason(candidate),
        checks,
      });
      const added = appendJsonlUnique(pipeline.paths.decisions, [proposed], "decision_id");
      if (added.length) {
        decisions.push(...added);
        decided.add(candidate.candidate_id);
        authorityDeferred += 1;
      }
      continue;
    }

    modelEligible += 1;
    const result = pipeline.runReview({ retryCandidateId: candidate.candidate_id });
    if (result?.status !== "success") {
      return {
        status: result?.status || "deferred",
        reason: result?.reason || "review_unavailable",
        decisions,
        authority_deferred: authorityDeferred,
        model_eligible: modelEligible,
      };
    }
    for (const decision of result.decisions || []) {
      decisions.push(decision);
      decided.add(decision.candidate_id);
    }
  }

  return {
    status: "success",
    decisions,
    authority_deferred: authorityDeferred,
    model_eligible: modelEligible,
  };
}

module.exports = { runReviewAuthorityGated };
