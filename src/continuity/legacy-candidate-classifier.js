"use strict";

const path = require("node:path");

const { sha256 } = require("./continuity-store");
const {
  ROUTE_EXACT,
  canonicalSerialize,
  createSubjectRoute,
  validateSubjectRoute,
} = require("./subject-route");

const EXACTLY_RECOVERABLE = "EXACTLY_RECOVERABLE";
const LEGACY_DEFERRED = "LEGACY_DEFERRED";

const REASON = Object.freeze({
  EXACT_MATCH: "exact_match",
  SOURCE_NOT_ALLOWED: "source_not_allowed",
  SOURCE_EVIDENCE_MISSING: "source_evidence_missing",
  SOURCE_NOT_LOCATABLE: "source_not_locatable",
  ROUTE_AMBIGUOUS: "route_ambiguous",
  MIXED_TOPIC_OR_PROFILE: "mixed_topic_or_profile",
});

/** Pure classifier: the caller supplies rows; this module performs no IO/env reads. */
function classifyLegacyCandidates({ candidates = [], conversationEntries = [], allowedConversationDirs = [] } = {}) {
  const allowedDirs = allowedConversationDirs.map((dir) => path.resolve(String(dir)));
  const entriesByFile = indexConversationEntries(conversationEntries);
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => classifyOne({
    candidate,
    entriesByFile,
    allowedDirs,
  }));
}

function classifyOne({ candidate, entriesByFile, allowedDirs }) {
  const candidateId = normalizeText(candidate?.candidate_id || candidate?.id);
  const sourceRef = candidate?.source_ref && typeof candidate.source_ref === "object"
    ? candidate.source_ref
    : {};
  const sourceFile = normalizeText(sourceRef.file);
  if (!sourceFile || !isWithinAllowedDirectory(sourceFile, allowedDirs)) {
    return deferred(candidateId, REASON.SOURCE_NOT_ALLOWED);
  }

  const sourceEntryIds = normalizeUniqueStrings(sourceRef.source_entry_ids || sourceRef.entry_ids);
  const expectedHashes = normalizeEntryHashes(sourceRef.source_entry_hashes);
  const expectedContentHash = normalizeSha256(sourceRef.content_sha256);
  const window = parseWindow(sourceRef.window);
  if (!candidateId || !sourceEntryIds.length || !window || expectedHashes.size !== sourceEntryIds.length || !expectedContentHash) {
    return deferred(candidateId, REASON.SOURCE_EVIDENCE_MISSING);
  }

  const sourceRows = entriesByFile.get(path.resolve(sourceFile)) || [];
  const selected = [];
  for (const entryId of sourceEntryIds) {
    const matches = sourceRows.filter((row) => row.entryId === entryId);
    if (matches.length !== 1 || matches[0].line < window.start || matches[0].line > window.end) {
      return deferred(candidateId, REASON.SOURCE_NOT_LOCATABLE);
    }
    selected.push(matches[0]);
  }

  const hashesMatch = selected.every((row) => expectedHashes.get(row.entryId) === row.lineSha256);
  const computedContentHash = sha256(selected.map((row) => row.rawLine).join("\n"));
  if (!hashesMatch || computedContentHash !== expectedContentHash) {
    return deferred(candidateId, REASON.ROUTE_AMBIGUOUS);
  }

  const routeInputs = selected.map(extractSubjectRoute).filter(Boolean);
  if (routeInputs.length !== selected.length) {
    return deferred(candidateId, REASON.ROUTE_AMBIGUOUS);
  }
  if (hasMixedTopicOrProfile(routeInputs)) {
    return deferred(candidateId, REASON.MIXED_TOPIC_OR_PROFILE);
  }
  if (!hasOneExactRouteIdentity(routeInputs)) {
    return deferred(candidateId, REASON.ROUTE_AMBIGUOUS);
  }

  let subjectRoute;
  try {
    subjectRoute = createSubjectRoute({
      ...sanitizeRouteIdentity(routeInputs[0]),
      source_entry_ids: sourceEntryIds,
    });
  } catch {
    return deferred(candidateId, REASON.ROUTE_AMBIGUOUS);
  }

  return Object.freeze({
    candidate_id: candidateId,
    classification: EXACTLY_RECOVERABLE,
    reason_code: REASON.EXACT_MATCH,
    subject_route: subjectRoute,
    evidence: Object.freeze({
      source_entry_ids: Object.freeze([...sourceEntryIds]),
      content_sha256: computedContentHash,
      route_fingerprint: subjectRoute.route_fingerprint,
    }),
    legacy_background_proposal: true,
  });
}

function deferred(candidateId, reasonCode) {
  return Object.freeze({
    candidate_id: candidateId,
    classification: LEGACY_DEFERRED,
    reason_code: reasonCode,
    evidence: Object.freeze({ source_entry_ids: Object.freeze([]) }),
  });
}

function indexConversationEntries(entries) {
  const byFile = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const file = normalizeText(row?.file);
    const entry = row?.entry && typeof row.entry === "object" ? row.entry : row;
    const entryId = normalizeText(entry?.id);
    const line = Number(row?.line);
    const rawLine = typeof row?.rawLine === "string" ? row.rawLine : "";
    const lineSha256 = normalizeSha256(row?.lineSha256) || sha256(rawLine);
    if (!file || !entryId || !Number.isInteger(line) || line < 1 || !rawLine) continue;
    const resolved = path.resolve(file);
    if (!byFile.has(resolved)) byFile.set(resolved, []);
    byFile.get(resolved).push({ entry, entryId, line, rawLine, lineSha256 });
  }
  return byFile;
}

function extractSubjectRoute(row) {
  const value = row?.entry?.meta?.subject_route || row?.entry?.subject_route;
  if (!value || typeof value !== "object") return null;
  const validation = validateSubjectRoute(value);
  if (validation.status !== ROUTE_EXACT) return null;
  const snapshot = JSON.parse(JSON.stringify(value));
  delete snapshot.route_fingerprint;
  delete snapshot.source_entry_ids;
  return snapshot;
}

function hasMixedTopicOrProfile(routes) {
  return unique(routes.map((route) => canonicalSerialize([
    route.route_lane?.message_thread_id,
    route.session?.profile_id,
    route.session?.profile_fingerprint,
  ]))).length > 1;
}

function hasOneExactRouteIdentity(routes) {
  const identities = routes.map((route) => ({
    version: route.version,
    provider: route.provider,
    continuity_binding: route.continuity_binding,
    route_lane: route.route_lane,
    session: route.session,
    author_turn_id: route.author_turn_id,
  }));
  return unique(identities.map(canonicalSerialize)).length === 1
    && routes.every((route) => normalizeText(route.session?.window_id));
}

function sanitizeRouteIdentity(route) {
  const opaque = (label, value) => `${label}-${sha256(normalizeText(value))}`;
  return {
    version: route.version,
    provider: route.provider,
    continuity_binding: {
      workspace_id: opaque("workspace", route.continuity_binding.workspace_id),
      account_id: opaque("account", route.continuity_binding.account_id),
      sender_id: opaque("sender", route.continuity_binding.sender_id),
      binding_key: opaque("binding", route.continuity_binding.binding_key),
    },
    route_lane: {
      lane_key: opaque("lane", route.route_lane.lane_key),
      chat_id: opaque("chat", route.route_lane.chat_id),
      message_thread_id: route.route_lane.message_thread_id === null
        ? null
        : opaque("topic", route.route_lane.message_thread_id),
    },
    session: {
      runtime_id: route.session.runtime_id,
      session_slot_key: opaque("slot", route.session.session_slot_key),
      runtime_thread_id: opaque("thread", route.session.runtime_thread_id),
      profile_id: opaque("profile", route.session.profile_id),
      profile_fingerprint: opaque("profile-fingerprint", route.session.profile_fingerprint),
      window_id: opaque("window", route.session.window_id),
    },
    author_turn_id: opaque("turn", route.author_turn_id),
  };
}

function isWithinAllowedDirectory(file, allowedDirs) {
  const resolved = path.resolve(file);
  return allowedDirs.some((dir) => {
    const relative = path.relative(dir, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function parseWindow(value) {
  const match = normalizeText(value).match(/^(\d+)-(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start > 0 && end >= start ? { start, end } : null;
}

function normalizeEntryHashes(value) {
  const output = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const entryId = normalizeText(item?.entry_id);
    const digest = normalizeSha256(item?.sha256);
    if (!entryId || !digest || output.has(entryId)) continue;
    output.set(entryId, digest);
  }
  return output;
}

function normalizeUniqueStrings(value) {
  const values = (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
  return values.length === new Set(values).size ? values : [];
}

function normalizeSha256(value) {
  const text = normalizeText(value);
  return /^[0-9a-f]{64}$/u.test(text) ? text : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values)];
}

module.exports = {
  EXACTLY_RECOVERABLE,
  LEGACY_DEFERRED,
  REASON,
  classifyLegacyCandidates,
};
