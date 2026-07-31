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
  let artifactComplete = true;
  const artifactErrors = [];
  let publicationIntentComplete = true;
  const publicationIntentErrors = [];
  const publicationIntentIds = [];

  if (typeof pipeline.repairReviewArtifacts === "function") {
    const repair = pipeline.repairReviewArtifacts();
    if (!repair || repair.status !== "success") {
      return {
        status: repair?.status || "deferred",
        reason: repair?.reason || "review_artifact_repair_failed",
        decisions,
        authority_deferred: authorityDeferred,
        model_eligible: modelEligible,
        artifact_complete: false,
        artifact_errors: repair?.artifact_errors || [],
        publication_intent_complete: false,
        publication_intent_errors: repair?.publication_intent_errors || [],
        publication_intent_ids: [],
      };
    }
    artifactComplete = repair.artifact_complete !== false;
    artifactErrors.push(...(repair.artifact_errors || []));
    publicationIntentComplete = repair.publication_intent_complete !== false;
    publicationIntentErrors.push(...(repair.publication_intent_errors || []));
    publicationIntentIds.push(...(repair.publication_intent_ids || []));
  }

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
        artifact_complete: false,
        artifact_errors: artifactErrors,
        publication_intent_complete: false,
        publication_intent_errors: publicationIntentErrors,
        publication_intent_ids: publicationIntentIds,
      };
    }

    const added = Array.isArray(result.decisions) ? result.decisions : [];
    decisions.push(...added);
    decided.add(candidateId);
    artifactComplete = artifactComplete && result.artifact_complete !== false;
    artifactErrors.push(...(result.artifact_errors || []));
    publicationIntentComplete = publicationIntentComplete
      && result.publication_intent_complete !== false;
    publicationIntentErrors.push(...(result.publication_intent_errors || []));
    publicationIntentIds.push(...(result.publication_intent_ids || []));
  }

  return {
    status: "success",
    decisions,
    authority_deferred: authorityDeferred,
    model_eligible: modelEligible,
    artifact_complete: artifactComplete,
    artifact_errors: artifactErrors,
    publication_intent_complete: publicationIntentComplete,
    publication_intent_errors: publicationIntentErrors,
    publication_intent_ids: [...new Set(publicationIntentIds)],
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
    const artifacts = typeof pipeline.materializeEffectiveReviewArtifacts === "function"
      ? pipeline.materializeEffectiveReviewArtifacts(
        readJsonl(pipeline.paths.candidates),
        [...existing, ...added],
      )
      : { artifact_complete: true, errors: [], handoff_ids: [], case_ids: [] };
    const intents = typeof pipeline.materializeEffectivePublicationIntents === "function"
      ? pipeline.materializeEffectivePublicationIntents(
        readJsonl(pipeline.paths.candidates),
        [...existing, ...added],
      )
      : { publication_intent_complete: true, errors: [], publication_intent_ids: [] };
    return {
      status: "success",
      decisions: added,
      artifact_complete: artifacts.artifact_complete,
      artifact_errors: artifacts.errors,
      handoff_ids: artifacts.handoff_ids,
      rejection_case_ids: artifacts.case_ids,
      publication_intent_complete: intents.publication_intent_complete,
      publication_intent_errors: intents.errors,
      publication_intent_ids: intents.publication_intent_ids,
    };
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { runReviewCheckpointed };
