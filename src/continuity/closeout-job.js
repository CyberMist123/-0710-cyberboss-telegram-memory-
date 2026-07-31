const path = require("path");
const { resolveMemoryWriterLeaseFile } = require("../orchestration/memory-writer-lease");
const { authorCloseout } = require("./background-author");
const { ContinuityPipeline } = require("./continuity-pipeline");

function createContinuityPipeline(config) {
  const continuityDir = requireConfig(config?.continuityDir, "CYBERBOSS_CONTINUITY_DIR");
  const conversationDir = requireConfig(
    config?.conversationDir || (config?.stateDir ? path.join(config.stateDir, "conversations") : ""),
    "CYBERBOSS_STATE_DIR/conversations",
  );
  // issue #74：lease 路径只从一处算（`memory-writer-lease.js`），
  // memory_note 工具走的是同一个解析函数 —— 两边不许各算各的。
  const writerLeaseFile = requireConfig(
    resolveMemoryWriterLeaseFile({ continuityDir, writerLeaseFile: config?.writerLeaseFile }),
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
    reviewArtifactsEnabled: config.reviewArtifactsEnabled,
    subjectSigningEnabled: config.subjectSigningEnabled,
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
    author: config.subjectSigningEnabled === true
      ? undefined
      : ({ materials }) => authorCloseout({ runtimeAdapter, config, materials }),
  });
}

function requireConfig(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required for authoritative closeout`);
  return normalized;
}

module.exports = { createContinuityPipeline, runAuthoritativeCloseout };
