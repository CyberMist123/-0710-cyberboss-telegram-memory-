"use strict";

/**
 * D28 legacy background candidate lookup view.
 *
 * This module is deliberately read-only. It joins the sealed candidate body to
 * the G2-7 companion binding and exposes only rows bound to the current route.
 * Missing, malformed, deferred, or route-ambiguous data is invisible.
 */

const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./continuity-store");
const { EXACTLY_RECOVERABLE } = require("./legacy-candidate-classifier");
const { ROUTE_EXACT, validateSubjectRoute } = require("./subject-route");

const LEGACY_CANDIDATES_BASENAME = "episodes.candidates.jsonl";
const LEGACY_BINDINGS_BASENAME = "legacy-candidate-route-bindings.jsonl";
const LEGACY_ID_PREFIX = "legacy-background-";
const LEGACY_SOURCE = "legacy_background_extracted";
const LEGACY_SOURCE_NOTICE = "旧后台存量、非你的笔迹";

function legacyCandidateFilesFor(continuityDir) {
  const dir = normalizeText(continuityDir);
  if (!dir) return { candidatesFile: "", bindingsFile: "" };
  const candidatesDir = path.join(dir, "candidates");
  return {
    candidatesFile: path.join(candidatesDir, LEGACY_CANDIDATES_BASENAME),
    bindingsFile: path.join(candidatesDir, LEGACY_BINDINGS_BASENAME),
  };
}

function readLegacyCandidatesForLookup({ candidatesFile, bindingsFile, context } = {}) {
  const routeIdentity = normalizeCurrentRouteIdentity(context);
  if (!routeIdentity) return [];

  const candidates = new Map();
  for (const row of readJsonlFailOpen(candidatesFile)) {
    const candidateId = normalizeText(row?.candidate_id || row?.id);
    const body = typeof row?.body === "string" ? row.body.trim() : "";
    if (candidateId && body && !candidates.has(candidateId)) {
      candidates.set(candidateId, row);
    }
  }

  const hits = [];
  const seen = new Set();
  for (const binding of readJsonlFailOpen(bindingsFile)) {
    if (binding?.classification !== EXACTLY_RECOVERABLE) continue;
    const candidateId = normalizeText(binding.candidate_id);
    if (!candidateId || seen.has(candidateId)) continue;
    if (!matchesCurrentRoute(binding.subject_route, routeIdentity)) continue;
    const candidate = candidates.get(candidateId);
    if (!candidate) continue;
    seen.add(candidateId);
    hits.push({
      ep_id: `${LEGACY_ID_PREFIX}${candidateId}`,
      ts: normalizeText(candidate.ts),
      body: candidate.body.trim(),
      source: LEGACY_SOURCE,
      source_notice: LEGACY_SOURCE_NOTICE,
      candidate_id: candidateId,
    });
  }
  return hits;
}

function normalizeCurrentRouteIdentity(context = {}) {
  if (context?.ambiguousRoute === true) return null;
  const routeToken = normalizeText(context.routeToken);
  const laneKey = normalizeText(context.laneKey);
  if (!routeToken || !laneKey) return null;
  // G2-7's sanitizeRouteIdentity() uses these exact labels and sha256 form.
  return {
    sessionSlotKey: opaqueRouteValue("slot", routeToken),
    laneKey: opaqueRouteValue("lane", laneKey),
  };
}

function matchesCurrentRoute(subjectRoute, currentRoute) {
  if (!subjectRoute || validateSubjectRoute(subjectRoute).status !== ROUTE_EXACT) return false;
  return normalizeText(subjectRoute.session?.session_slot_key) === currentRoute.sessionSlotKey
    && normalizeText(subjectRoute.route_lane?.lane_key) === currentRoute.laneKey;
}

function opaqueRouteValue(label, value) {
  return `${label}-${sha256(normalizeText(value))}`;
}

function readJsonlFailOpen(filePath) {
  const file = normalizeText(filePath);
  if (!file) return [];
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      return row && typeof row === "object" && !Array.isArray(row) ? [row] : [];
    } catch {
      return [];
    }
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  LEGACY_BINDINGS_BASENAME,
  LEGACY_CANDIDATES_BASENAME,
  LEGACY_ID_PREFIX,
  LEGACY_SOURCE,
  LEGACY_SOURCE_NOTICE,
  legacyCandidateFilesFor,
  matchesCurrentRoute,
  normalizeCurrentRouteIdentity,
  readLegacyCandidatesForLookup,
};
