const EFFECTIVE_DECISION_AMBIGUOUS = "effective_decision_ambiguous";

function selectEffectiveDecisions(decisions = []) {
  const rows = Array.isArray(decisions) ? decisions : [];
  const globalById = new Map();
  const byCandidate = new Map();

  for (const raw of rows) {
    const decision = normalizeDecision(raw);
    if (!byCandidate.has(decision.candidate_id)) byCandidate.set(decision.candidate_id, []);
    byCandidate.get(decision.candidate_id).push(decision);
    if (!globalById.has(decision.decision_id)) globalById.set(decision.decision_id, []);
    globalById.get(decision.decision_id).push(decision);
  }

  const effectiveByCandidate = new Map();
  const ambiguous = [];
  for (const [candidateId, candidateDecisions] of byCandidate) {
    const selected = selectCandidateHead(candidateId, candidateDecisions, globalById);
    if (selected.decision) effectiveByCandidate.set(candidateId, selected.decision);
    else ambiguous.push(selected.event);
  }
  return { effectiveByCandidate, ambiguous };
}

function selectEffectiveDecisionForCandidate(decisions, candidateId) {
  const normalizedCandidateId = normalizeText(candidateId);
  const selected = selectEffectiveDecisions(decisions);
  const event = selected.ambiguous.find((item) => item.candidate_id === normalizedCandidateId) || null;
  return {
    decision: selected.effectiveByCandidate.get(normalizedCandidateId) || null,
    event,
  };
}

function selectCandidateHead(candidateId, decisions, globalById) {
  const reasons = new Set();
  const localById = new Map();

  if (!candidateId) reasons.add("candidate_id_missing");
  for (const decision of decisions) {
    if (!decision.decision_id) reasons.add("decision_id_missing");
    if (!Number.isInteger(decision.review_revision) || decision.review_revision < 1) {
      reasons.add("review_revision_invalid");
    }
    if (!localById.has(decision.decision_id)) localById.set(decision.decision_id, []);
    localById.get(decision.decision_id).push(decision);
    if ((globalById.get(decision.decision_id) || []).length > 1) reasons.add("decision_id_duplicate");
  }

  const unique = [...localById.values()].filter((items) => items.length === 1).map((items) => items[0]);
  const uniqueById = new Map(unique.map((item) => [item.decision_id, item]));
  const referenced = new Set();
  const children = new Map();

  for (const decision of unique) {
    if (decision.supersedes_invalid) {
      reasons.add("supersedes_decision_id_invalid");
      continue;
    }
    const predecessorId = decision.supersedes_decision_id;
    if (!predecessorId) {
      if (decision.review_revision !== 1) reasons.add("root_revision_not_one");
      continue;
    }
    const globalPredecessors = globalById.get(predecessorId) || [];
    if (!globalPredecessors.length) {
      reasons.add("predecessor_missing");
      continue;
    }
    if (globalPredecessors.length !== 1) {
      reasons.add("predecessor_ambiguous");
      continue;
    }
    const predecessor = globalPredecessors[0];
    if (predecessor.candidate_id !== candidateId) {
      reasons.add("predecessor_cross_candidate");
      continue;
    }
    referenced.add(predecessorId);
    if (!children.has(predecessorId)) children.set(predecessorId, []);
    children.get(predecessorId).push(decision.decision_id);
    if (decision.review_revision <= predecessor.review_revision) reasons.add("review_revision_not_increasing");
  }

  if ([...children.values()].some((items) => items.length > 1)) reasons.add("decision_fork");
  if (hasCycle(uniqueById)) reasons.add("decision_cycle");

  const heads = unique.filter((item) => !referenced.has(item.decision_id));
  if (heads.length !== 1) reasons.add("head_not_unique");

  if (heads.length === 1) {
    const visited = new Set();
    let cursor = heads[0];
    while (cursor && !visited.has(cursor.decision_id)) {
      visited.add(cursor.decision_id);
      cursor = cursor.supersedes_decision_id
        ? uniqueById.get(cursor.supersedes_decision_id)
        : null;
    }
    if (visited.size !== unique.length) reasons.add("chain_disconnected");
  }

  if (!reasons.size && heads.length === 1) return { decision: heads[0], event: null };
  return {
    decision: null,
    event: {
      event: EFFECTIVE_DECISION_AMBIGUOUS,
      candidate_id: candidateId,
      reasons: [...reasons].sort(),
      decision_ids: decisions.map((item) => item.decision_id).filter(Boolean).sort(),
    },
  };
}

function hasCycle(byId) {
  const completed = new Set();
  for (const start of byId.values()) {
    const active = new Set();
    let cursor = start;
    while (cursor && !completed.has(cursor.decision_id)) {
      if (active.has(cursor.decision_id)) return true;
      active.add(cursor.decision_id);
      cursor = cursor.supersedes_decision_id ? byId.get(cursor.supersedes_decision_id) : null;
    }
    for (const decisionId of active) completed.add(decisionId);
  }
  return false;
}

function normalizeDecision(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const hasRevision = Object.prototype.hasOwnProperty.call(value, "review_revision");
  const hasPredecessor = Object.prototype.hasOwnProperty.call(value, "supersedes_decision_id");
  const predecessor = hasPredecessor ? value.supersedes_decision_id : null;
  const supersedesInvalid = predecessor !== null
    && predecessor !== undefined
    && typeof predecessor !== "string";
  return {
    ...value,
    decision_id: normalizeText(value.decision_id),
    candidate_id: normalizeText(value.candidate_id),
    review_revision: hasRevision ? value.review_revision : 1,
    supersedes_decision_id: supersedesInvalid ? null : (normalizeText(predecessor) || null),
    supersedes_invalid: supersedesInvalid,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  EFFECTIVE_DECISION_AMBIGUOUS,
  selectEffectiveDecisionForCandidate,
  selectEffectiveDecisions,
};
