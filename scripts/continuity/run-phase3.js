#!/usr/bin/env node
const path = require("path");
const { loadEnv } = require("../../src/index");
const { readConfig } = require("../../src/core/config");
const { validateStartupPreflight } = require("../../src/core/startup-preflight");
const { createRuntimeAdapter } = require("../../src/core/app");
const { authorCloseout } = require("../../src/continuity/background-author");
const { ContinuityPipeline } = require("../../src/continuity/continuity-pipeline");

async function main() {
  loadEnv();
  const command = String(process.argv[2] || "").trim();
  const date = readFlag("--date") || shanghaiYesterday();
  const config = readConfig();
  validateStartupPreflight(config);
  const pipeline = createPipeline(config);
  const output = {};
  if (command === "closeout" || command === "all") {
    const runtimeAdapter = createRuntimeAdapter(config);
    try {
      output.closeout = await pipeline.runCloseoutAsync({
        date,
        author: ({ materials }) => authorCloseout({ runtimeAdapter, config, materials }),
      });
    } catch (error) {
      output.closeout = { status: "deferred", reason: error.message || String(error) };
    } finally {
      await runtimeAdapter.close().catch(() => {});
    }
  }
  if (command === "janitor" || command === "all") output.janitor = pipeline.runJanitor();
  if (command === "review" || command === "all") output.review = pipeline.runReview();
  if (command === "write" || command === "all") output.history = pipeline.runHistoryWriter();
  if (!Object.keys(output).length) throw new Error("Usage: run-phase3.js <closeout|janitor|review|write|all> [--date=YYYY-MM-DD]");
  console.log(JSON.stringify(output, null, 2));
}

function createPipeline(config) {
  return new ContinuityPipeline({
    continuityDir: requireConfig(config.continuityDir, "CYBERBOSS_CONTINUITY_DIR"),
    conversationDir: requireConfig(config.conversationDir, "CYBERBOSS_STATE_DIR/conversations"),
    writerLeaseFile: requireConfig(config.writerLeaseFile, "CYBERBOSS_WRITER_LEASE_FILE"),
    reviewScript: path.resolve(__dirname, "..", "..", "extensions", "relationship-memory", "memory-kit", "auto_review.py"),
    janitorScript: path.resolve(__dirname, "..", "..", "extensions", "relationship-memory", "memory-kit", "janitor.py"),
    transcriptDir: config.claudeTranscriptDir,
    python: process.env.PYTHON || "python",
    model: config.runtime === "claudecode" ? config.claudeModel || "configured-claude" : config.codexModel || "configured-codex",
    branch: requireConfig(config.continuityBranch, "CYBERBOSS_CONTINUITY_BRANCH"),
    worktree: requireConfig(config.continuityWorktree, "CYBERBOSS_CONTINUITY_WORKTREE"),
    baseSha: requireConfig(config.continuityBaseSha, "CYBERBOSS_CONTINUITY_BASE_SHA"),
  });
}

function readFlag(name) {
  const prefix = `${name}=`;
  const item = process.argv.slice(3).find((arg) => String(arg).startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function requireConfig(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function shanghaiYesterday() {
  const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

main().catch((error) => {
  console.error(`[phase3] ${error.message || String(error)}`);
  process.exitCode = 1;
});
