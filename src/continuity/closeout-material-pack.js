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
  const sourceEntryHashes = Array.isArray(materials?.source_ref?.source_entry_hashes)
    ? materials.source_ref.source_entry_hashes.map((item) => ({
        entry_id: String(item?.entry_id || "").trim(),
        sha256: String(item?.sha256 || "").trim(),
      }))
    : [];
  if (canonicalSerialize(sourceEntryIds) !== canonicalSerialize(route.source_entry_ids)) {
    throw materialPackFailure("material_sources_mismatch", "material sources do not match subject route");
  }
  if (sourceEntryHashes.length !== sourceEntryIds.length
    || canonicalSerialize(sourceEntryHashes.map((item) => item.entry_id)) !== canonicalSerialize(sourceEntryIds)
    || sourceEntryHashes.some((item) => !/^[0-9a-f]{64}$/u.test(item.sha256))) {
    throw materialPackFailure("material_source_hashes_invalid", "material source hashes do not match source entries");
  }
  const sourceContentSha256 = sha256(facts);
  const materialPackId = `mat-${sha256(canonicalSerialize({
    business_date: businessDate,
    source_entry_ids: sourceEntryIds,
    source_entry_hashes: sourceEntryHashes,
    source_content_sha256: sourceContentSha256,
    route_fingerprint: route.route_fingerprint,
  })).slice(0, 20)}`;
  return {
    material_pack_id: materialPackId,
    business_date: businessDate,
    source_entry_ids: sourceEntryIds,
    source_entry_hashes: sourceEntryHashes,
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
