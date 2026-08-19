#!/usr/bin/env node
// Reconcile .jobs/history-writer-state.json against canon.
//
// The 2026-08-11 reset wiped canon writes but left the history writer's state
// claiming those candidates were published. That ghost state is a HARD gate:
// candidate_already_published blocks both History (continuity-pipeline.js:628)
// and subject_rewrite submission (subject-signing.js loadPublishedCandidateIds),
// so a candidate the ghost list names can neither be published nor rewritten.
// Diagnosis: workdesk 20260816-episodes-pipeline-diagnosis-v2.md §3-4.
//
// Canon is the only truth. A state entry survives only when the candidate it
// concerns is really published: present in episodes.jsonl / details.jsonl, or
// referenced by a <!-- decision:… --> marker in ai_self_notes.md (the same
// sources loadPublishedCandidateIds unions). diagnostic_events are incident
// history and are never touched. The state file is backed up before writing.
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../../src/index");
const { readConfig } = require("../../src/core/config");
const { loadJson, readJsonl, writeJsonAtomic } = require("../../src/continuity/continuity-store");

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonPublishedCandidateIds(continuityDir, decisionsById) {
  const published = new Set();
  for (const fileName of ["episodes.jsonl", "details.jsonl"]) {
    for (const row of readJsonl(path.join(continuityDir, fileName))) {
      const candidateId = normalize(row?.candidate_id);
      if (candidateId) published.add(candidateId);
    }
  }
  let selfNotes = "";
  try {
    selfNotes = fs.readFileSync(path.join(continuityDir, "ai_self_notes.md"), "utf8");
  } catch {}
  for (const match of selfNotes.matchAll(/<!-- decision:([^\s>]+) -->/gu)) {
    const candidateId = normalize(decisionsById.get(match[1])?.candidate_id);
    if (candidateId) published.add(candidateId);
  }
  return published;
}

function lineageRootOf(candidateId, candidatesById) {
  let cursor = candidatesById.get(candidateId);
  const visited = new Set();
  while (cursor) {
    const id = normalize(cursor.candidate_id);
    if (visited.has(id)) return id; // cycle: stop rather than loop
    visited.add(id);
    const predecessorId = normalize(cursor.supersedes_candidate_id);
    if (!predecessorId || !candidatesById.has(predecessorId)) return id;
    cursor = candidatesById.get(predecessorId);
  }
  return candidateId;
}

function main() {
  loadEnv();
  const config = readConfig();
  const continuityDir = normalize(config.continuityDir);
  if (!continuityDir) throw new Error("CYBERBOSS_CONTINUITY_DIR is required");
  const statePath = path.join(continuityDir, ".jobs", "history-writer-state.json");
  const dryRun = process.argv.includes("--dry-run");

  const decisionsById = new Map(
    readJsonl(path.join(continuityDir, "decisions", "decisions.jsonl"))
      .map((decision) => [normalize(decision?.decision_id), decision]),
  );
  const intents = readJsonl(path.join(continuityDir, "decisions", "publication-intents.jsonl"));
  const candidatesById = new Map(
    readJsonl(path.join(continuityDir, "candidates", "episodes.candidates.jsonl"))
      .map((candidate) => [normalize(candidate?.candidate_id), candidate]),
  );
  const canon = canonPublishedCandidateIds(continuityDir, decisionsById);
  const canonRoots = new Set(
    [...canon].map((candidateId) => lineageRootOf(candidateId, candidatesById)),
  );
  const keysForCanon = new Set(
    intents
      .filter((intent) => canon.has(normalize(intent?.candidate_id)))
      .map((intent) => normalize(intent?.publication_key))
      .filter(Boolean),
  );

  const state = loadJson(statePath, null);
  if (!state) throw new Error(`state file missing or unreadable: ${statePath}`);

  const next = {
    ...state,
    published_candidate_ids: (state.published_candidate_ids || [])
      .filter((candidateId) => canon.has(normalize(candidateId))),
    applied_decision_ids: (state.applied_decision_ids || [])
      .filter((decisionId) => canon.has(normalize(decisionsById.get(normalize(decisionId))?.candidate_id))),
    applied_publication_keys: (state.applied_publication_keys || [])
      .filter((key) => keysForCanon.has(normalize(key))),
    published_candidate_lineage_roots: (state.published_candidate_lineage_roots || [])
      .filter((root) => canonRoots.has(normalize(root))),
    intent_consumptions: (state.intent_consumptions || [])
      .filter((entry) => canon.has(normalize(entry?.candidate_id))),
  };

  const report = {
    status: dryRun ? "dry_run" : "reconciled",
    canon_published: [...canon].sort(),
    removed: {
      published_candidate_ids: (state.published_candidate_ids || [])
        .filter((id) => !canon.has(normalize(id))),
      applied_decision_ids: (state.applied_decision_ids || [])
        .filter((id) => !canon.has(normalize(decisionsById.get(normalize(id))?.candidate_id))),
      applied_publication_keys: (state.applied_publication_keys || [])
        .filter((key) => !keysForCanon.has(normalize(key))),
      published_candidate_lineage_roots: (state.published_candidate_lineage_roots || [])
        .filter((root) => !canonRoots.has(normalize(root))),
      intent_consumptions: (state.intent_consumptions || [])
        .filter((entry) => !canon.has(normalize(entry?.candidate_id)))
        .map((entry) => normalize(entry?.candidate_id)),
    },
    diagnostic_events_kept: Array.isArray(state.diagnostic_events) ? state.diagnostic_events.length : 0,
  };

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(statePath, `${statePath}.bak-${stamp}`);
    writeJsonAtomic(statePath, next);
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
