#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { readConfig } = require("../../src/core/config");
const { readJsonl } = require("../../src/continuity/continuity-store");
const { EXACTLY_RECOVERABLE, classifyLegacyCandidates } = require("../../src/continuity/legacy-candidate-classifier");

const COMPANION_BASENAME = "legacy-candidate-route-bindings.jsonl";

function main(argv = process.argv.slice(2)) {
  const result = runMigration(resolveCliOptions(argv, readConfig()));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function runMigration({ apply = false, candidatesFile, conversationDirs, targetFile, now = () => new Date(), appendLine = defaultAppendLine } = {}) {
  const candidates = readJsonl(requirePath(candidatesFile, "candidatesFile"));
  const allowedDirs = (Array.isArray(conversationDirs) ? conversationDirs : []).map((dir) => requirePath(dir, "conversationDir"));
  if (!allowedDirs.length) throw new Error("At least one conversation directory is required");
  const classifications = classifyLegacyCandidates({
    candidates,
    conversationEntries: readConversationEntries(allowedDirs),
    allowedConversationDirs: allowedDirs,
  });
  const recoverable = classifications.filter((row) => row.classification === EXACTLY_RECOVERABLE);
  const summary = {
    status: apply ? "applied" : "dry_run",
    apply,
    total: classifications.length,
    exactly_recoverable: recoverable.length,
    legacy_deferred: classifications.length - recoverable.length,
    added: 0,
    results: classifications,
  };
  if (!apply) return summary;

  const destination = requirePath(targetFile, "targetFile");
  const existingIds = new Set(readJsonl(destination).map((row) => normalizeText(row?.candidate_id)).filter(Boolean));
  for (const row of recoverable) {
    if (existingIds.has(row.candidate_id)) continue;
    appendLine(destination, `${JSON.stringify({
      candidate_id: row.candidate_id,
      classification: row.classification,
      subject_route: row.subject_route,
      evidence: row.evidence,
      legacy_background_proposal: true,
      bound_at: now().toISOString(),
      writer: "legacy-candidate-migration",
    })}\n`);
    existingIds.add(row.candidate_id);
    summary.added += 1;
  }
  return summary;
}

function resolveCliOptions(argv, config) {
  const parsed = parseArgs(argv);
  const continuityDir = path.resolve(parsed.continuityDir || requirePath(config.continuityDir, "CYBERBOSS_CONTINUITY_DIR"));
  const conversationDirs = parsed.conversationDirs.length
    ? parsed.conversationDirs
    : [requirePath(config.conversationDir, "CYBERBOSS_STATE_DIR/conversations")];
  return {
    apply: parsed.apply,
    candidatesFile: path.resolve(parsed.candidatesFile || path.join(continuityDir, "candidates", "episodes.candidates.jsonl")),
    conversationDirs: conversationDirs.map((dir) => path.resolve(dir)),
    targetFile: path.resolve(parsed.targetFile || path.join(continuityDir, "candidates", COMPANION_BASENAME)),
  };
}

function parseArgs(argv) {
  const output = { apply: false, conversationDirs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") { output.apply = true; continue; }
    const mapping = { "--continuity-dir": "continuityDir", "--candidate-file": "candidatesFile", "--target-file": "targetFile" };
    if (mapping[arg]) { output[mapping[arg]] = requireArgument(argv[++index], arg); continue; }
    if (arg === "--conversation-dir") { output.conversationDirs.push(requireArgument(argv[++index], arg)); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return output;
}

function readConversationEntries(dirs) {
  const rows = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      if (!fs.statSync(file).isFile()) continue;
      fs.readFileSync(file, "utf8").split(/\r?\n/u).forEach((rawLine, index) => {
        if (!rawLine) return;
        try { rows.push({ file, line: index + 1, rawLine, entry: JSON.parse(rawLine) }); } catch { /* not exact evidence */ }
      });
    }
  }
  return rows;
}

function defaultAppendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, "utf8");
}

function requireArgument(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requirePath(value, label) {
  const text = normalizeText(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", reason: error?.code || "migration_failed" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { COMPANION_BASENAME, main, parseArgs, readConversationEntries, resolveCliOptions, runMigration };
