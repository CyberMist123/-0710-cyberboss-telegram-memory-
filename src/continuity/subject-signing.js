"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  appendJsonlUnique,
  loadJson,
  readJsonl,
  sha256,
} = require("./continuity-store");
const { assertExactSubjectRoute, canonicalSerialize } = require("./subject-route");

const SUBJECT_CANDIDATE_ORIGINS = Object.freeze([
  "live_subject",
  "closeout_materials_then_subject",
  "subject_rewrite",
]);
const SUBJECT_CANDIDATE_TYPES = Object.freeze([
  "episode",
  "self_note",
  "reentry_draft",
  "details",
  "timeline",
]);

class SubjectCapabilityRegistry {
  constructor({ enabled = false, now = () => new Date(), onDiagnostic = null } = {}) {
    this.enabled = enabled === true;
    this.now = now;
    this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
    this.active = new Map();
    this.diagnostics = [];
  }

  issue({ subjectTurnId, subjectRoute } = {}) {
    if (!this.enabled) return null;
    try {
      const route = assertExactSubjectRoute(subjectRoute);
      const turnId = requireText(subjectTurnId, "subject_turn_id");
      if (route.author_turn_id !== turnId) {
        throw signingFailure("subject_turn_mismatch", "subject route turn does not match capability turn");
      }
      const capabilityId = crypto.randomBytes(32).toString("base64url");
      const record = {
        capability_id: capabilityId,
        subject_turn_id: turnId,
        route_fingerprint: route.route_fingerprint,
        issued_at: normalizeTimestamp(this.now()),
        active: true,
        bound_body_sha256: "",
        bound_source_entry_ids_sha256: "",
      };
      this.active.set(capabilityId, record);
      return Object.freeze({
        capability_id: capabilityId,
        subject_turn_id: turnId,
        route_fingerprint: route.route_fingerprint,
        issued_at: record.issued_at,
      });
    } catch (error) {
      this.recordDiagnostic(error?.code || "capability_issue_failed");
      return null;
    }
  }

  verifyAndBind({ capabilityId, subjectTurnId, subjectRoute, bodySha256, sourceEntryIdsSha256 } = {}) {
    const id = requireText(capabilityId, "capability_id");
    const record = this.active.get(id);
    if (!record || record.active !== true) {
      throw this.failure("capability_expired", "capability is missing or expired");
    }
    const route = assertExactSubjectRoute(subjectRoute);
    const turnId = requireText(subjectTurnId, "subject_turn_id");
    const bodyHash = requireSha256(bodySha256, "body_sha256");
    const sourceHash = requireSha256(sourceEntryIdsSha256, "source_entry_ids_sha256");
    if (record.subject_turn_id !== turnId || route.author_turn_id !== turnId) {
      throw this.failure("subject_turn_mismatch", "capability turn does not match candidate turn");
    }
    if (record.route_fingerprint !== route.route_fingerprint) {
      throw this.failure("subject_route_mismatch", "capability route does not match candidate route");
    }
    if (record.bound_body_sha256 && record.bound_body_sha256 !== bodyHash) {
      throw this.failure("subject_body_hash_mismatch", "candidate body differs from the bound body");
    }
    if (record.bound_source_entry_ids_sha256
      && record.bound_source_entry_ids_sha256 !== sourceHash) {
      throw this.failure("subject_sources_hash_mismatch", "candidate sources differ from the bound sources");
    }
    record.bound_body_sha256 = bodyHash;
    record.bound_source_entry_ids_sha256 = sourceHash;
    return record;
  }

  consume(capabilityId) {
    const record = this.active.get(capabilityId);
    if (record) record.active = false;
  }

  expireTurn(subjectTurnId) {
    const turnId = normalizeText(subjectTurnId);
    for (const record of this.active.values()) {
      if (record.subject_turn_id === turnId) record.active = false;
    }
  }

  failure(code, message) {
    this.recordDiagnostic(code);
    return signingFailure(code, message);
  }

  recordDiagnostic(code) {
    const event = Object.freeze({
      type: "subject_signing_rejected",
      code: normalizeText(code) || "subject_signing_failed",
    });
    this.diagnostics.push(event);
    try { this.onDiagnostic?.(event); } catch {}
  }
}

class SubjectCandidateService {
  constructor({ continuityDir = "", registry, enabled = false } = {}) {
    this.enabled = enabled === true;
    this.registry = registry;
    this.continuityDir = continuityDir ? path.resolve(continuityDir) : "";
    this.candidatesPath = this.continuityDir
      ? path.join(this.continuityDir, "candidates", "episodes.candidates.jsonl")
      : "";
  }

  createSubjectCandidate(input = {}) {
    if (!this.enabled || !this.registry) {
      throw signingFailure("subject_signing_disabled", "subject signing is disabled");
    }
    if (looksLikeBackgroundCandidate(input)) {
      throw this.registry.failure(
        "background_candidate_forbidden",
        "background output must be a CloseoutMaterialPack, not candidate prose",
      );
    }
    const type = requireEnum(input.type, SUBJECT_CANDIDATE_TYPES, "type");
    const origin = requireEnum(input.origin, SUBJECT_CANDIDATE_ORIGINS, "origin");
    const body = requireText(input.body, "body");
    const subjectTurnId = requireText(input.subject_turn_id, "subject_turn_id");
    const subjectRoute = assertExactSubjectRoute(input.subject_route);
    const sourceEntryIds = normalizeSourceEntryIds(input.source_ref?.source_entry_ids);
    const sourceEntryHashes = normalizeSourceEntryHashes(
      input.source_ref?.source_entry_hashes,
      sourceEntryIds,
    );
    if (canonicalSerialize(sourceEntryIds) !== canonicalSerialize(subjectRoute.source_entry_ids)) {
      throw this.registry.failure("subject_sources_mismatch", "source_ref does not match subject_route sources");
    }
    const bodySha256 = sha256(body);
    const sourceEntryIdsSha256 = sha256(canonicalSerialize(sourceEntryIds));
    const capability = this.registry.verifyAndBind({
      capabilityId: input.capability_id,
      subjectTurnId,
      subjectRoute,
      bodySha256,
      sourceEntryIdsSha256,
    });
    validateOriginMaterialReference(input, origin, sourceEntryIds);
    const supersedeMetadata = validateSupersedeSemantics({
      input,
      origin,
      type,
      continuityDir: this.continuityDir,
      candidatesPath: this.candidatesPath,
    });
    const idempotencyKey = sha256(canonicalSerialize({
      route_fingerprint: subjectRoute.route_fingerprint,
      subject_turn_id: subjectTurnId,
      type,
      body,
      source_entry_ids: sourceEntryIds,
      ...supersedeMetadata,
    }));
    const candidate = {
      candidate_id: `cand-${idempotencyKey.slice(0, 20)}`,
      type,
      body,
      origin,
      author_role: "subject_ai",
      semantic_authority: "high",
      context_scope: "active_session",
      subject_route: subjectRoute,
      source_ref: {
        source_entry_ids: sourceEntryIds,
        ...(sourceEntryHashes.length ? { source_entry_hashes: sourceEntryHashes } : {}),
        content_sha256: requireSha256(input.source_ref?.content_sha256, "source_ref.content_sha256"),
        ...(normalizeText(input.source_ref?.file) ? { file: normalizeText(input.source_ref.file) } : {}),
        ...(normalizeText(input.source_ref?.window) ? { window: normalizeText(input.source_ref.window) } : {}),
      },
      author_attestation: {
        version: 2,
        subject_turn_id: subjectTurnId,
        route_fingerprint: subjectRoute.route_fingerprint,
        body_sha256: bodySha256,
        source_entry_ids_sha256: sourceEntryIdsSha256,
        issued_at: capability.issued_at,
      },
      idempotency_key: idempotencyKey,
      ...supersedeMetadata,
      ...(origin === "closeout_materials_then_subject"
        ? { material_pack_id: normalizeText(input.material_pack_id) }
        : {}),
    };
    const existing = readJsonl(this.candidatesPath)
      .find((row) => row?.idempotency_key === idempotencyKey);
    if (existing) {
      this.registry.consume(input.capability_id);
      return { status: "duplicate", candidate: existing };
    }
    const added = appendJsonlUnique(this.candidatesPath, [candidate], "idempotency_key");
    if (!added.length) {
      throw this.registry.failure("candidate_write_unverified", "candidate was not persisted");
    }
    this.registry.consume(input.capability_id);
    return { status: "created", candidate: added[0] };
  }
}

function validateSupersedeSemantics({ input, origin, type, continuityDir, candidatesPath }) {
  const supersedesCandidateId = normalizeText(input.supersedes_candidate_id);
  const canonSupersedes = normalizeText(input.canon_supersedes);
  if (supersedesCandidateId && canonSupersedes) {
    throw signingFailure(
      "supersede_semantics_conflict",
      "candidate rewrite lineage and canon correction supersede cannot be combined",
    );
  }
  if (origin !== "subject_rewrite" && supersedesCandidateId) {
    throw signingFailure(
      "candidate_rewrite_origin_invalid",
      "supersedes_candidate_id requires subject_rewrite origin",
    );
  }
  if (origin === "subject_rewrite") {
    if (!supersedesCandidateId) {
      throw signingFailure("candidate_predecessor_missing", "subject rewrite predecessor is required");
    }
    const predecessors = readJsonl(candidatesPath).filter(
      (candidate) => normalizeText(candidate?.candidate_id) === supersedesCandidateId,
    );
    if (predecessors.length !== 1) {
      throw signingFailure(
        "candidate_predecessor_missing",
        "subject rewrite predecessor is missing or ambiguous",
      );
    }
    if (normalizeText(predecessors[0].type) !== type) {
      throw signingFailure(
        "candidate_lineage_type_mismatch",
        "subject rewrite must keep the predecessor memory type",
      );
    }
    if (loadPublishedCandidateIds(continuityDir).has(supersedesCandidateId)) {
      throw signingFailure(
        "candidate_predecessor_already_published",
        "published candidates must be changed through canon correction semantics",
      );
    }
    return {
      supersedes_candidate_id: supersedesCandidateId,
      rewrite_handoff_id: requireText(input.rewrite_handoff_id, "rewrite_handoff_id"),
      rewrite_of_decision_id: requireText(
        input.rewrite_of_decision_id,
        "rewrite_of_decision_id",
      ),
    };
  }
  return canonSupersedes ? { canon_supersedes: canonSupersedes } : {};
}

function loadPublishedCandidateIds(continuityDir) {
  const published = new Set();
  if (!continuityDir) return published;
  const state = loadJson(
    path.join(continuityDir, ".jobs", "history-writer-state.json"),
    {},
  );
  for (const candidateId of state.published_candidate_ids || []) {
    const normalized = normalizeText(candidateId);
    if (normalized) published.add(normalized);
  }
  for (const fileName of ["episodes.jsonl", "details.jsonl"]) {
    for (const row of readJsonl(path.join(continuityDir, fileName))) {
      const candidateId = normalizeText(row?.candidate_id);
      if (candidateId) published.add(candidateId);
    }
  }
  const decisions = new Map(
    readJsonl(path.join(continuityDir, "decisions", "decisions.jsonl"))
      .map((decision) => [normalizeText(decision?.decision_id), decision]),
  );
  let selfNotes = "";
  try {
    selfNotes = fs.readFileSync(
      path.join(continuityDir, "ai_self_notes.md"),
      "utf8",
    );
  } catch {}
  for (const match of selfNotes.matchAll(/<!-- decision:([^\s>]+) -->/gu)) {
    const candidateId = normalizeText(decisions.get(match[1])?.candidate_id);
    if (candidateId) published.add(candidateId);
  }
  return published;
}

function validateOriginMaterialReference(input, origin, sourceEntryIds) {
  const materialPackId = normalizeText(input.material_pack_id);
  if (origin === "closeout_materials_then_subject" && !materialPackId) {
    throw signingFailure("material_pack_required", "material_pack_id is required for closeout material origin");
  }
  if (origin === "closeout_materials_then_subject") {
    const pack = input.material_pack;
    if (!pack || typeof pack !== "object" || Array.isArray(pack)
      || normalizeText(pack.material_pack_id) !== materialPackId
      || normalizeText(pack.created_by) !== "closeout-materializer"
      || canonicalSerialize(pack.source_entry_ids) !== canonicalSerialize(sourceEntryIds)
      || canonicalSerialize(pack.source_entry_hashes || [])
        !== canonicalSerialize(input.source_ref?.source_entry_hashes || [])
      || requireSha256(pack.source_content_sha256, "material_pack.source_content_sha256")
        !== requireSha256(input.source_ref?.content_sha256, "source_ref.content_sha256")
      || sha256(String(pack.facts || "")) !== pack.source_content_sha256
      || hasCandidateProseShape(pack)) {
      throw signingFailure("material_pack_invalid", "closeout material pack is invalid or contains candidate prose");
    }
  }
  if (origin === "live_subject" && materialPackId) {
    throw signingFailure("material_pack_forbidden", "live subject origin cannot cite a material pack");
  }
}

function normalizeSourceEntryHashes(value, sourceEntryIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length !== sourceEntryIds.length) {
    throw signingFailure(
      "source_entry_hashes_invalid",
      "source_entry_hashes must align one-to-one with source_entry_ids",
    );
  }
  const hashes = value.map((item) => ({
    entry_id: requireText(item?.entry_id, "source_entry_hash.entry_id"),
    sha256: requireSha256(item?.sha256, "source_entry_hash.sha256"),
  }));
  if (canonicalSerialize(hashes.map((item) => item.entry_id)) !== canonicalSerialize(sourceEntryIds)) {
    throw signingFailure(
      "source_entry_hashes_invalid",
      "source_entry_hashes must preserve source_entry_ids order",
    );
  }
  return hashes;
}

function looksLikeBackgroundCandidate(input) {
  return input?.background === true
    || input?.created_by === "closeout-materializer"
    || input?.author_role === "background_proxy"
    || input?.origin === "nightly_closeout"
    || hasCandidateProseShape(input);
}

function hasCandidateProseShape(input) {
  return Array.isArray(input?.episodes)
    || Object.hasOwn(input || {}, "self_note")
    || Object.hasOwn(input || {}, "reentry_draft")
    || Object.hasOwn(input || {}, "candidate_body");
}

function normalizeSourceEntryIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw signingFailure("source_entry_ids_invalid", "source_entry_ids must be a non-empty array");
  }
  const ids = value.map((item) => requireText(item, "source_entry_id"));
  if (new Set(ids).size !== ids.length) {
    throw signingFailure("source_entry_ids_invalid", "source_entry_ids must be unique");
  }
  return ids;
}

function requireEnum(value, allowed, label) {
  const text = requireText(value, label);
  if (!allowed.includes(text)) throw signingFailure(`${label}_invalid`, `unsupported ${label}: ${text}`);
  return text;
}

function requireSha256(value, label) {
  const text = requireText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw signingFailure(`${label}_invalid`, `${label} must be sha256`);
  return text;
}

function requireText(value, label) {
  const text = normalizeText(value);
  if (!text) throw signingFailure(`${label}_missing`, `${label} is required`);
  return text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw signingFailure("issued_at_invalid", "issued_at is invalid");
  return date.toISOString();
}

function signingFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  SUBJECT_CANDIDATE_ORIGINS,
  SUBJECT_CANDIDATE_TYPES,
  SubjectCapabilityRegistry,
  SubjectCandidateService,
  signingFailure,
};
