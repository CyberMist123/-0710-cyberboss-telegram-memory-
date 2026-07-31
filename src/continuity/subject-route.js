"use strict";

const crypto = require("node:crypto");

const SUBJECT_ROUTE_VERSION = 1;

const ROUTE_EXACT = "EXACT";
const ROUTE_PARTIAL = "PARTIAL";
const ROUTE_INVALID = "INVALID";

const SUBJECT_ROUTE_MATCH_EXACT = "EXACT";
const SUBJECT_ROUTE_MATCH_OTHER = "OTHER";
const SUBJECT_ROUTE_MATCH_WINDOW_GONE = "WINDOW_GONE";

const RECORDED_EXACT = "RECORDED_EXACT";
const RECORDED_PARTIAL = "RECORDED_PARTIAL";
const MATERIAL_ROUTE_EXACT = "MATERIAL_ROUTE_EXACT";
const MATERIAL_ROUTE_AMBIGUOUS = "MATERIAL_ROUTE_AMBIGUOUS";
const CANDIDATE_ROUTE_BOUND = "CANDIDATE_ROUTE_BOUND";
const NO_SUBJECT_CANDIDATE = "NO_SUBJECT_CANDIDATE";

const RECORDER_ROUTE_FIELDS = Object.freeze([
  "bindingKey",
  "laneKey",
  "sessionSlotKey",
  "messageThreadId",
  "profileId",
  "windowId",
]);

// This is the repository's only subject_route schema definition. Consumers
// import this object and the validators below instead of copying field lists.
const SUBJECT_ROUTE_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "provider",
    "continuity_binding",
    "route_lane",
    "session",
    "author_turn_id",
    "source_entry_ids",
    "route_fingerprint",
  ],
  properties: {
    version: { const: SUBJECT_ROUTE_VERSION },
    provider: { type: "string", minLength: 1 },
    continuity_binding: {
      type: "object",
      additionalProperties: false,
      required: ["workspace_id", "account_id", "sender_id", "binding_key"],
      properties: {
        workspace_id: { type: "string", minLength: 1 },
        account_id: { type: "string", minLength: 1 },
        sender_id: { type: "string", minLength: 1 },
        binding_key: { type: "string", minLength: 1 },
      },
    },
    route_lane: {
      type: "object",
      additionalProperties: false,
      required: ["lane_key", "chat_id", "message_thread_id"],
      properties: {
        lane_key: { type: "string", minLength: 1 },
        chat_id: { type: "string", minLength: 1 },
        message_thread_id: { type: ["string", "null"] },
      },
    },
    session: {
      type: "object",
      additionalProperties: false,
      required: [
        "runtime_id",
        "session_slot_key",
        "runtime_thread_id",
        "profile_id",
        "profile_fingerprint",
        "window_id",
      ],
      properties: {
        runtime_id: { enum: ["claudecode", "codex"] },
        session_slot_key: { type: "string", minLength: 1 },
        runtime_thread_id: { type: "string", minLength: 1 },
        profile_id: { type: "string", minLength: 1 },
        profile_fingerprint: { type: "string", minLength: 1 },
        window_id: { type: "string", minLength: 1 },
      },
    },
    author_turn_id: { type: "string", minLength: 1 },
    source_entry_ids: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
    route_fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
});

function windowIdFromNativeSessionId(nativeSessionId) {
  // D24: use the runtime's native session identity itself. Do not fall back to
  // a process id, timestamp, generated UUID or continuity-day epoch.
  return normalizeText(nativeSessionId);
}

function normalizeRecorderRouteSnapshot(route = {}) {
  const source = isPlainObject(route) ? route : {};
  const normalized = {};
  copyNonEmptyText(source, normalized, "bindingKey");
  copyNonEmptyText(source, normalized, "laneKey");
  copyNonEmptyText(source, normalized, "sessionSlotKey");
  if (Object.hasOwn(source, "messageThreadId")) {
    if (source.messageThreadId === null) {
      normalized.messageThreadId = null;
    } else {
      copyNonEmptyText(source, normalized, "messageThreadId");
    }
  }
  copyNonEmptyText(source, normalized, "profileId");
  copyNonEmptyText(source, normalized, "windowId");
  return deepFreeze(normalized);
}

function classifyRecorderRoute(route) {
  if (!isPlainObject(route)) {
    return RECORDED_PARTIAL;
  }
  const exact = RECORDER_ROUTE_FIELDS.every((field) => {
    if (!Object.hasOwn(route, field)) return false;
    if (field === "messageThreadId") {
      return route[field] === null || isNonEmptyText(route[field]);
    }
    return isNonEmptyText(route[field]);
  });
  return exact ? RECORDED_EXACT : RECORDED_PARTIAL;
}

function resolveMaterialRoute(entries = []) {
  const rows = Array.isArray(entries) ? entries : [];
  const reasons = [];
  const sourceEntryIds = [];
  const seenEntryIds = new Set();
  let exactRoute = null;
  let exactRouteCanonical = "";

  if (!rows.length) reasons.push("no_source_entries");

  for (const entry of rows) {
    const entryId = normalizeText(entry?.id);
    if (!entryId) {
      reasons.push("source_entry_id_missing");
    } else if (seenEntryIds.has(entryId)) {
      reasons.push("source_entry_id_duplicate");
    } else {
      seenEntryIds.add(entryId);
      sourceEntryIds.push(entryId);
    }

    const route = normalizeRecorderRouteSnapshot(entry?.route);
    if (classifyRecorderRoute(route) !== RECORDED_EXACT) {
      reasons.push("recorded_route_partial");
      continue;
    }
    const canonical = canonicalSerialize(route);
    if (exactRouteCanonical && canonical !== exactRouteCanonical) {
      reasons.push("source_entries_cross_route");
      continue;
    }
    if (!exactRouteCanonical) {
      exactRouteCanonical = canonical;
      exactRoute = route;
    }
  }

  if (!exactRoute || sourceEntryIds.length !== rows.length) {
    reasons.push("material_route_ambiguous");
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length) {
    return deepFreeze({
      status: MATERIAL_ROUTE_AMBIGUOUS,
      candidateState: NO_SUBJECT_CANDIDATE,
      canCreateSubjectCandidate: false,
      sourceEntryIds,
      reasons: uniqueReasons,
    });
  }

  return deepFreeze({
    status: MATERIAL_ROUTE_EXACT,
    candidateState: CANDIDATE_ROUTE_BOUND,
    canCreateSubjectCandidate: true,
    sourceEntryIds,
    route: cloneJson(exactRoute),
    reasons: [],
  });
}

function createSubjectRoute(input = {}) {
  const snapshot = cloneJson(input);
  delete snapshot.route_fingerprint;
  if (!Object.hasOwn(snapshot, "version")) snapshot.version = SUBJECT_ROUTE_VERSION;

  const withoutFingerprint = validateSubjectRoute(snapshot);
  const missingBeyondFingerprint = withoutFingerprint.missing.filter(
    (field) => field !== "route_fingerprint",
  );
  if (withoutFingerprint.status === ROUTE_INVALID || missingBeyondFingerprint.length) {
    throw subjectRouteFailure(
      withoutFingerprint.status === ROUTE_INVALID ? "subject_route_invalid" : "subject_route_partial",
      formatValidationFailure(withoutFingerprint),
    );
  }

  snapshot.route_fingerprint = computeRouteFingerprint(snapshot);
  return assertExactSubjectRoute(snapshot);
}

function computeRouteFingerprint(route) {
  if (!isPlainObject(route)) {
    throw subjectRouteFailure("subject_route_invalid", "subject_route must be an object");
  }
  const snapshot = cloneJson(route);
  delete snapshot.route_fingerprint;
  return crypto.createHash("sha256").update(canonicalSerialize(snapshot), "utf8").digest("hex");
}

function validateSubjectRoute(value, { requireExact = false } = {}) {
  const missing = [];
  const errors = [];
  if (!isPlainObject(value)) {
    errors.push("subject_route must be an object");
    return validationResult({ missing, errors, requireExact });
  }

  validateAllowedKeys(value, SUBJECT_ROUTE_SCHEMA, "subject_route", errors);
  validateConst(value, "version", SUBJECT_ROUTE_VERSION, "version", missing, errors);
  validateText(value, "provider", "provider", missing, errors);
  validateObject(value, "continuity_binding", SUBJECT_ROUTE_SCHEMA.properties.continuity_binding, {
    missing,
    errors,
    validators: {
      workspace_id: validateText,
      account_id: validateText,
      sender_id: validateText,
      binding_key: validateText,
    },
  });
  validateObject(value, "route_lane", SUBJECT_ROUTE_SCHEMA.properties.route_lane, {
    missing,
    errors,
    validators: {
      lane_key: validateText,
      chat_id: validateText,
      message_thread_id: validateNullableText,
    },
  });
  validateObject(value, "session", SUBJECT_ROUTE_SCHEMA.properties.session, {
    missing,
    errors,
    validators: {
      runtime_id: validateRuntimeId,
      session_slot_key: validateText,
      runtime_thread_id: validateText,
      profile_id: validateText,
      profile_fingerprint: validateText,
      window_id: validateText,
    },
  });
  validateText(value, "author_turn_id", "author_turn_id", missing, errors);
  validateSourceEntryIds(value, missing, errors);
  validateFingerprint(value, missing, errors);

  return validationResult({ missing, errors, requireExact });
}

function evaluateSubjectRoute(value) {
  const validation = validateSubjectRoute(value);
  const exact = validation.status === ROUTE_EXACT;
  return deepFreeze({
    ...validation,
    recordedState: exact ? RECORDED_EXACT : RECORDED_PARTIAL,
    materialState: exact ? MATERIAL_ROUTE_EXACT : MATERIAL_ROUTE_AMBIGUOUS,
    candidateState: exact ? CANDIDATE_ROUTE_BOUND : NO_SUBJECT_CANDIDATE,
    canCreateSubjectCandidate: exact,
  });
}

function assertExactSubjectRoute(value) {
  const validation = validateSubjectRoute(value, { requireExact: true });
  if (!validation.accepted) {
    const code = validation.status === ROUTE_PARTIAL
      ? "subject_route_partial"
      : "subject_route_invalid";
    throw subjectRouteFailure(code, formatValidationFailure(validation));
  }
  return deepFreeze(cloneJson(value));
}

/**
 * Match a live subject window against an immutable subject_route without
 * inventing a second route schema. The projected route reuses the target's
 * author/source evidence and is fingerprinted by createSubjectRoute(); exact
 * delivery therefore succeeds only when the canonical fingerprint is equal.
 *
 * A matching stable slot with a missing or different native transcript is the
 * D26-1 terminal case: the original D24 window is gone. Any other route is
 * unrelated and must neither receive nor retire this envelope.
 */
function matchSubjectRouteWindow(targetRoute, currentIdentity = {}) {
  const target = assertExactSubjectRoute(targetRoute);
  const projectedInput = {
    version: target.version,
    provider: currentIdentity.provider,
    continuity_binding: currentIdentity.continuity_binding,
    route_lane: currentIdentity.route_lane,
    session: currentIdentity.session,
    author_turn_id: target.author_turn_id,
    source_entry_ids: target.source_entry_ids,
  };
  try {
    const projected = createSubjectRoute(projectedInput);
    if (projected.route_fingerprint === target.route_fingerprint) {
      return deepFreeze({
        status: SUBJECT_ROUTE_MATCH_EXACT,
        route_match: true,
        target_route_fingerprint: target.route_fingerprint,
      });
    }
  } catch {
    // A partial current identity can still prove window_gone when its stable
    // slot identity is complete. It can never prove an exact route.
  }

  const targetSlot = stableWindowSlot(target);
  const currentSlot = stableWindowSlot(currentIdentity);
  if (targetSlot && currentSlot && canonicalSerialize(targetSlot) === canonicalSerialize(currentSlot)) {
    const currentThreadId = normalizeText(currentIdentity?.session?.runtime_thread_id);
    const currentWindowId = normalizeText(currentIdentity?.session?.window_id);
    const targetThreadId = normalizeText(target.session.runtime_thread_id);
    const targetWindowId = normalizeText(target.session.window_id);
    if (!currentThreadId || !currentWindowId
      || currentThreadId !== targetThreadId
      || currentWindowId !== targetWindowId) {
      return deepFreeze({
        status: SUBJECT_ROUTE_MATCH_WINDOW_GONE,
        route_match: false,
        target_route_fingerprint: target.route_fingerprint,
      });
    }
  }

  return deepFreeze({
    status: SUBJECT_ROUTE_MATCH_OTHER,
    route_match: false,
    target_route_fingerprint: target.route_fingerprint,
  });
}

function stableWindowSlot(route = {}) {
  const binding = route?.continuity_binding;
  const lane = route?.route_lane;
  const session = route?.session;
  if (!isPlainObject(binding) || !isPlainObject(lane) || !isPlainObject(session)) return null;
  const snapshot = {
    provider: route.provider,
    continuity_binding: {
      workspace_id: binding.workspace_id,
      account_id: binding.account_id,
      sender_id: binding.sender_id,
      binding_key: binding.binding_key,
    },
    route_lane: {
      lane_key: lane.lane_key,
      chat_id: lane.chat_id,
      message_thread_id: lane.message_thread_id,
    },
    session: {
      runtime_id: session.runtime_id,
      session_slot_key: session.session_slot_key,
      profile_id: session.profile_id,
      profile_fingerprint: session.profile_fingerprint,
    },
  };
  if (!isNonEmptyText(snapshot.provider)
    || !Object.values(snapshot.continuity_binding).every(isNonEmptyText)
    || !isNonEmptyText(snapshot.route_lane.lane_key)
    || !isNonEmptyText(snapshot.route_lane.chat_id)
    || (snapshot.route_lane.message_thread_id !== null
      && !isNonEmptyText(snapshot.route_lane.message_thread_id))
    || !Object.values(snapshot.session).every(isNonEmptyText)) {
    return null;
  }
  return snapshot;
}

function canonicalSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw subjectRouteFailure("subject_route_invalid", "canonical JSON does not allow non-finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isPlainObject(value)) {
    throw subjectRouteFailure("subject_route_invalid", "canonical JSON requires plain JSON values");
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      throw subjectRouteFailure("subject_route_invalid", `canonical JSON field ${key} is undefined`);
    }
    output[key] = canonicalize(value[key]);
  }
  return output;
}

function validateObject(parent, key, schema, { missing, errors, validators }) {
  const label = key;
  if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
    missing.push(label);
    return;
  }
  const value = parent[key];
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateAllowedKeys(value, schema, label, errors);
  for (const field of schema.required) {
    const validator = validators[field];
    validator(value, field, `${label}.${field}`, missing, errors);
  }
}

function validateAllowedKeys(value, schema, label, errors) {
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

function validateConst(parent, key, expected, label, missing, errors) {
  if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
    missing.push(label);
    return;
  }
  if (parent[key] !== expected) errors.push(`${label} must equal ${expected}`);
}

function validateText(parent, key, label, missing, errors) {
  if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
    missing.push(label);
    return;
  }
  if (!isNonEmptyText(parent[key])) errors.push(`${label} must be a non-empty string`);
}

function validateNullableText(parent, key, label, missing, errors) {
  if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
    missing.push(label);
    return;
  }
  if (parent[key] !== null && !isNonEmptyText(parent[key])) {
    errors.push(`${label} must be null or a non-empty string`);
  }
}

function validateRuntimeId(parent, key, label, missing, errors) {
  if (!Object.hasOwn(parent, key) || parent[key] === undefined) {
    missing.push(label);
    return;
  }
  if (!SUBJECT_ROUTE_SCHEMA.properties.session.properties.runtime_id.enum.includes(parent[key])) {
    errors.push(`${label} must be claudecode or codex`);
  }
}

function validateSourceEntryIds(value, missing, errors) {
  const key = "source_entry_ids";
  if (!Object.hasOwn(value, key) || value[key] === undefined) {
    missing.push(key);
    return;
  }
  if (!Array.isArray(value[key])) {
    errors.push(`${key} must be an array`);
    return;
  }
  if (!value[key].length) {
    missing.push(key);
    return;
  }
  const seen = new Set();
  for (const entryId of value[key]) {
    if (!isNonEmptyText(entryId)) {
      errors.push(`${key} must contain only non-empty strings`);
      continue;
    }
    if (seen.has(entryId)) errors.push(`${key} must not contain duplicates`);
    seen.add(entryId);
  }
}

function validateFingerprint(value, missing, errors) {
  const key = "route_fingerprint";
  if (!Object.hasOwn(value, key) || value[key] === undefined) {
    missing.push(key);
    return;
  }
  if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key])) {
    errors.push(`${key} must be a lowercase sha256`);
    return;
  }
  try {
    if (value[key] !== computeRouteFingerprint(value)) {
      errors.push(`${key} does not match the canonical route snapshot`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "route fingerprint could not be computed");
  }
}

function validationResult({ missing, errors, requireExact }) {
  const uniqueMissing = [...new Set(missing)];
  const uniqueErrors = [...new Set(errors)];
  const status = uniqueErrors.length
    ? ROUTE_INVALID
    : (uniqueMissing.length ? ROUTE_PARTIAL : ROUTE_EXACT);
  return deepFreeze({
    status,
    valid: uniqueErrors.length === 0,
    exact: status === ROUTE_EXACT,
    accepted: uniqueErrors.length === 0 && (!requireExact || status === ROUTE_EXACT),
    missing: uniqueMissing,
    errors: uniqueErrors,
  });
}

function formatValidationFailure(validation) {
  return [
    ...(validation.errors || []),
    ...(validation.missing || []).map((field) => `${field} is missing`),
  ].join("; ") || "subject_route is not exact";
}

function subjectRouteFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function copyNonEmptyText(source, target, key) {
  const value = normalizeText(source[key]);
  if (value) target[key] = value;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw subjectRouteFailure("subject_route_invalid", "subject_route must be JSON-serializable");
  }
  if (encoded === undefined) {
    throw subjectRouteFailure("subject_route_invalid", "subject_route must be JSON-serializable");
  }
  return JSON.parse(encoded);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

module.exports = {
  CANDIDATE_ROUTE_BOUND,
  MATERIAL_ROUTE_AMBIGUOUS,
  MATERIAL_ROUTE_EXACT,
  NO_SUBJECT_CANDIDATE,
  RECORDED_EXACT,
  RECORDED_PARTIAL,
  RECORDER_ROUTE_FIELDS,
  ROUTE_EXACT,
  ROUTE_INVALID,
  ROUTE_PARTIAL,
  SUBJECT_ROUTE_SCHEMA,
  SUBJECT_ROUTE_MATCH_EXACT,
  SUBJECT_ROUTE_MATCH_OTHER,
  SUBJECT_ROUTE_MATCH_WINDOW_GONE,
  SUBJECT_ROUTE_VERSION,
  assertExactSubjectRoute,
  canonicalSerialize,
  classifyRecorderRoute,
  computeRouteFingerprint,
  createSubjectRoute,
  evaluateSubjectRoute,
  matchSubjectRouteWindow,
  normalizeRecorderRouteSnapshot,
  resolveMaterialRoute,
  validateSubjectRoute,
  windowIdFromNativeSessionId,
};
