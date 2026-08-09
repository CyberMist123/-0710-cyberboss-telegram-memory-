const VALID_ORIGINS = new Set([
  "live_subject",
  "closeout_materials_then_subject",
  "subject_rewrite",
  "live_closeout",
  "nightly_closeout",
  "manual",
  "janitor_legacy",
]);
const VALID_AUTHOR_ROLES = new Set(["subject_ai", "background_proxy", "extractor"]);
const VALID_CONTEXT_SCOPES = new Set(["active_session", "daily_materials", "isolated_chunk"]);
const VALID_AUTHORITIES = new Set(["high", "medium", "none"]);

/**
 * 只有主体 AI 能发布的类型。
 *
 * `details`（账本，issue #76 目标 1）与 `self_note` / `reentry_draft` 同一条门槛：
 * 账本内容虽然是客观细节，但「哪条细节值得记」仍是语义判断，按 D16「后台不产出记忆
 * 内容、写入权归当前窗口 AI」，后台代理与提取器只能提候选、必须过主体复核。
 * 门槛没有放宽，只是把一个原先无处可落的类型接进同一套闸门。
 */
const SUBJECT_AUTHORED_TYPES = Object.freeze(["self_note", "reentry_draft", "details", "timeline"]);

function normalizeCandidateMetadata(candidate = {}) {
  const type = normalizeText(candidate.type);
  const author = normalizeText(candidate.author);
  const defaults = legacyDefaults({ type, author });

  const origin = choose(candidate.origin, VALID_ORIGINS, defaults.origin);
  const authorRole = choose(candidate.author_role, VALID_AUTHOR_ROLES, defaults.author_role);
  const contextScope = choose(candidate.context_scope, VALID_CONTEXT_SCOPES, defaults.context_scope);
  const semanticAuthority = choose(
    candidate.semantic_authority,
    VALID_AUTHORITIES,
    defaults.semantic_authority,
  );
  const needsSubjectReview = typeof candidate.needs_subject_review === "boolean"
    ? candidate.needs_subject_review
    : inferNeedsSubjectReview({ type, authorRole, semanticAuthority });

  return {
    ...candidate,
    origin,
    author_role: authorRole,
    author_model: normalizeText(candidate.author_model) || defaults.author_model,
    context_scope: contextScope,
    semantic_authority: semanticAuthority,
    needs_subject_review: needsSubjectReview,
  };
}

function canPublishCandidate(candidate = {}) {
  const normalized = normalizeCandidateMetadata(candidate);
  if (normalized.author_role === "extractor" || normalized.semantic_authority === "none") return false;
  if (normalized.needs_subject_review) return false;

  if (normalized.type === "episode") {
    return normalized.author_role === "subject_ai" && normalized.semantic_authority === "high";
  }

  if (SUBJECT_AUTHORED_TYPES.includes(normalized.type)) {
    return normalized.author_role === "subject_ai" && normalized.semantic_authority === "high";
  }

  return false;
}

function authorityFailureReason(candidate = {}) {
  const normalized = normalizeCandidateMetadata(candidate);
  if (normalized.author_role === "extractor" || normalized.semantic_authority === "none") {
    return "semantic_authority_missing";
  }
  if (normalized.needs_subject_review) return "subject_review_required";
  return canPublishCandidate(normalized) ? "" : "publication_not_allowed";
}

function legacyDefaults({ type, author }) {
  if (author === "janitor") {
    return {
      origin: "janitor_legacy",
      author_role: "extractor",
      author_model: "legacy-extractor",
      context_scope: "isolated_chunk",
      semantic_authority: "none",
    };
  }

  if (author === "subject_ai") {
    return {
      origin: "live_closeout",
      author_role: "subject_ai",
      author_model: "legacy-subject-ai",
      context_scope: "active_session",
      semantic_authority: "high",
    };
  }

  if (author === "closeout") {
    return {
      origin: "nightly_closeout",
      author_role: "background_proxy",
      author_model: "legacy-background-proxy",
      context_scope: "daily_materials",
      semantic_authority: "medium",
    };
  }

  return {
    origin: "manual",
    author_role: "background_proxy",
    author_model: "legacy-unknown",
    context_scope: "isolated_chunk",
    semantic_authority: "none",
  };
}

function inferNeedsSubjectReview({ type, authorRole, semanticAuthority }) {
  if (authorRole === "extractor" || semanticAuthority === "none") return true;
  if (SUBJECT_AUTHORED_TYPES.includes(type) && authorRole !== "subject_ai") return true;
  return false;
}

function choose(value, allowed, fallback) {
  const text = normalizeText(value);
  return allowed.has(text) ? text : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  SUBJECT_AUTHORED_TYPES,
  authorityFailureReason,
  canPublishCandidate,
  normalizeCandidateMetadata,
};
