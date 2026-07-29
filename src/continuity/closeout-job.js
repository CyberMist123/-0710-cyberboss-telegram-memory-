const path = require("path");
const { authorCloseout } = require("./background-author");
const { ContinuityPipeline } = require("./continuity-pipeline");

function createContinuityPipeline(config) {
  const continuityDir = requireConfig(config?.continuityDir, "CYBERBOSS_CONTINUITY_DIR");
  const conversationDir = requireConfig(
    config?.conversationDir || (config?.stateDir ? path.join(config.stateDir, "conversations") : ""),
    "CYBERBOSS_STATE_DIR/conversations",
  );
  const writerLeaseFile = requireConfig(
    config?.writerLeaseFile || path.join(continuityDir, ".jobs", "MEMORY_WRITER_LEASE.json"),
    "CYBERBOSS_WRITER_LEASE_FILE",
  );
  return new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile,
    reviewScript: path.resolve(__dirname, "..", "..", "extensions", "relationship-memory", "memory-kit", "auto_review.py"),
    janitorScript: path.resolve(__dirname, "..", "..", "extensions", "relationship-memory", "memory-kit", "janitor.py"),
    transcriptDir: config.claudeTranscriptDir,
    python: process.env.PYTHON || "python",
    model: config.runtime === "claudecode" ? config.claudeModel || "configured-claude" : config.codexModel || "configured-codex",
    branch: config.continuityBranch || "runtime",
    worktree: config.continuityWorktree || config.workspaceRoot || continuityDir,
    baseSha: config.continuityBaseSha || "0".repeat(40),
    automationTimezone: config.automationTimezone,
  });
}

async function runAuthoritativeCloseout({ config, runtimeAdapter, date, businessDay, windowClosed = false, pipeline } = {}) {
  if (!runtimeAdapter || typeof runtimeAdapter.runBackgroundTurn !== "function") {
    throw new Error("authoritative closeout requires the configured runtime adapter");
  }
  const activePipeline = pipeline || createContinuityPipeline(config);
  return activePipeline.runCloseoutAsync({
    date: businessDay?.dateKey || date,
    windowClosed,
    author: ({ materials }) => authorCloseout({ runtimeAdapter, config, materials }),
  });
}

function requireConfig(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required for authoritative closeout`);
  return normalized;
}

module.exports = { createContinuityPipeline, runAuthoritativeCloseout };
