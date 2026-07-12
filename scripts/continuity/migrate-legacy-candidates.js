#!/usr/bin/env node
// One-off migration: the v1 janitor wrote rich-schema extractions to
// <continuity>/episodes.candidates.jsonl (root). The phase3 pipeline only
// reads <continuity>/candidates/episodes.candidates.jsonl in the frozen
// candidate schema, so those extractions could never reach Auto Review.
// This converts them without editing bodies beyond field composition;
// anchor quotes are carried verbatim. Original file is left untouched.
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../../src/index");
const { readConfig } = require("../../src/core/config");
const { appendJsonlUnique, readJsonl, sha256 } = require("../../src/continuity/continuity-store");

function main() {
  loadEnv();
  const config = readConfig();
  const continuityDir = required(config.continuityDir, "CYBERBOSS_CONTINUITY_DIR");
  const transcriptDir = normalize(config.claudeTranscriptDir);
  const legacyFile = path.join(continuityDir, "episodes.candidates.jsonl");
  const targetFile = path.join(continuityDir, "candidates", "episodes.candidates.jsonl");
  const episodesFile = path.join(continuityDir, "episodes.jsonl");
  const dryRun = process.argv.includes("--dry-run");

  const legacyRows = readJsonl(legacyFile);
  if (!legacyRows.length) {
    console.log(JSON.stringify({ status: "no_output", reason: "no_legacy_candidates", legacyFile }));
    return;
  }
  const promotedTitles = new Set(
    readJsonl(episodesFile).map((row) => normalize(row.title)).filter(Boolean),
  );

  const candidates = [];
  const skipped = [];
  let unlocatable = 0;
  for (const row of legacyRows) {
    if (!row || typeof row !== "object") continue;
    const title = normalize(row.title);
    if (title && promotedTitles.has(title)) {
      skipped.push({ id: normalize(row.id), reason: "already_promoted" });
      continue;
    }
    const body = composeBody(row);
    if (!body) {
      skipped.push({ id: normalize(row.id), reason: "empty_body" });
      continue;
    }
    const sourceRef = resolveSourceRef(row.source, transcriptDir);
    if (!sourceRef.file) unlocatable += 1;
    const ts = normalizeTs(row.time);
    candidates.push({
      candidate_id: normalize(row.id) || `cand-${sha256(body).slice(0, 20)}`,
      ts,
      type: "episode",
      author: "janitor",
      body,
      source_ref: sourceRef,
      idempotency_key: sha256(`${ts}\n${sourceRef.file}:${sourceRef.window}\n${body.replace(/\s+/g, " ")}`),
      legacy: {
        time: normalize(row.time),
        importance: Number.isFinite(Number(row.importance)) ? Number(row.importance) : null,
        source: normalize(row.source),
        extracted_by: normalize(row.extracted_by) || "janitor",
      },
    });
  }

  if (dryRun) {
    console.log(JSON.stringify({ status: "dry_run", would_add: candidates.length, skipped, unlocatable_source_refs: unlocatable }, null, 2));
    return;
  }
  const added = appendJsonlUnique(targetFile, candidates, "candidate_id");
  console.log(JSON.stringify({
    status: added.length ? "success" : "no_output",
    legacy_rows: legacyRows.length,
    added: added.length,
    skipped,
    unlocatable_source_refs: unlocatable,
    targetFile,
  }, null, 2));
}

function composeBody(row) {
  const parts = [];
  const title = normalize(row.title);
  const what = normalize(row.what_happened);
  const why = normalize(row.why_it_mattered);
  const shift = normalize(row.shift);
  const future = normalize(row.future_effect);
  const quotes = (Array.isArray(row.anchor_quotes) ? row.anchor_quotes : []).map(normalize).filter(Boolean);
  if (title) parts.push(title);
  if (what) parts.push(what);
  if (why) parts.push(why);
  if (shift) parts.push(`转变:${shift}`);
  if (quotes.length) parts.push(`原话:${quotes.map((quote) => `「${quote}」`).join(" ")}`);
  if (future) parts.push(`之后:${future}`);
  return parts.join(" ").trim();
}

function resolveSourceRef(source, transcriptDir) {
  const fileName = normalize(source);
  if (!fileName || !transcriptDir) return { file: "", window: "" };
  const filePath = path.join(transcriptDir, fileName);
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).length;
    // v1 提取没有记行号窗口；整档窗口是当下唯一诚实的可定位表达。
    return { file: filePath, window: `1-${lines}` };
  } catch {
    return { file: "", window: "" };
  }
}

function normalizeTs(value) {
  const text = normalize(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!match) return "";
  return `${match[1]}T${match[2] || "23:59"}:00+08:00`;
}

function required(value, label) {
  const text = normalize(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

main();
