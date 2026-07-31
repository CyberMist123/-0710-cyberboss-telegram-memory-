"use strict";

const path = require("node:path");
const { appendJsonlUnique, sha256 } = require("./continuity-store");
const { assertExactSubjectRoute, canonicalSerialize } = require("./subject-route");

function createCloseoutMaterialPack({ businessDate, materials, subjectRoute } = {}) {
  const route = assertExactSubjectRoute(subjectRoute);
  const facts = String(materials?.text || "");
  if (!facts) return null;
  const sourceEntryIds = Array.isArray(materials?.source_ref?.source_entry_ids)
    ? materials.source_ref.source_entry_ids.map((item) => String(item || "").trim())
    : [];
  if (canonicalSerialize(sourceEntryIds) !== canonicalSerialize(route.source_entry_ids)) {
    throw materialPackFailure("material_sources_mismatch", "material sources do not match subject route");
  }
  const sourceContentSha256 = sha256(facts);
  const materialPackId = `mat-${sha256(canonicalSerialize({
    business_date: businessDate,
    source_entry_ids: sourceEntryIds,
    source_content_sha256: sourceContentSha256,
    route_fingerprint: route.route_fingerprint,
  })).slice(0, 20)}`;
  return {
    material_pack_id: materialPackId,
    business_date: businessDate,
    source_entry_ids: sourceEntryIds,
    source_content_sha256: sourceContentSha256,
    subject_route: route,
    facts,
    created_by: "closeout-materializer",
  };
}

function persistCloseoutMaterialPack({ continuityDir, materialPack } = {}) {
  if (!materialPack) return [];
  const filePath = path.join(path.resolve(continuityDir), "materials", "closeout-material-packs.jsonl");
  return appendJsonlUnique(filePath, [materialPack], "material_pack_id");
}

function materialPackFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { createCloseoutMaterialPack, persistCloseoutMaterialPack };
