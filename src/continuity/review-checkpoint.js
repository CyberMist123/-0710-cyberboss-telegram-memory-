const { readJsonl } = require("./continuity-store");

function runReviewCheckpointed(pipeline, { retryCandidateId = "" } = {}) {
  if (!pipeline || typeof pipeline.runReview !== "function" || !pipeline.paths) {
    throw new Error("pipeline with runReview() and paths is required");
  }

  const requested = normalizeText(retryCandidateId);
  if (requested) return pipeline.runReview({ retryCandidateId: requested });

  const candidates = readJsonl(pipeline.paths.candidates);
  const existing = readJsonl(pipeline.paths.decisions);
  const decided = new Set(existing.map((item) => normalizeText(item?.candidate_id)).filter(Boolean));
  const decisions = [];

  for (const candidate of candidates) {
    const candidateId = normalizeText(candidate?.candidate_id);
    if (!candidateId || decided.has(candidateId)) continue;

    // One pipeline call handles exactly one candidate and persists its decision
    // before this loop advances. An interruption can only lose the in-flight item.
    const result = pipeline.runReview({ retryCandidateId: candidateId });
    if (!result || result.status !== "success") {
      return {
        status: result?.status || "deferred",
        reason: result?.reason || "review_checkpoint_failed",
        decisions,
        stopped_at_candidate_id: candidateId,
      };
    }

    const added = Array.isArray(result.decisions) ? result.decisions : [];
    decisions.push(...added);
    decided.add(candidateId);
  }

  return { status: "success", decisions };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { runReviewCheckpointed };
