const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_HIDDEN_TYPES = ["episodes", "timeline", "portrait", "self_note", "rereadings"];

class ContextTraceRecorder {
  constructor({ filePath } = {}) {
    this.filePath = normalizeText(filePath);
    this.queue = Promise.resolve();
  }

  record(entry = {}) {
    if (!this.filePath) return Promise.resolve(false);
    const payload = sanitizeTraceEntry(entry);
    this.queue = this.queue
      .catch(() => false)
      .then(async () => {
        try {
          await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
          await fs.promises.appendFile(this.filePath, `${JSON.stringify(payload)}\n`, "utf8");
          return true;
        } catch (error) {
          console.warn(`[continuity] context trace write failed: ${error.message || String(error)}`);
          return false;
        }
      });
    return this.queue;
  }

  flush() {
    return this.queue.catch(() => false);
  }
}

function sanitizeTraceEntry(entry = {}) {
  const skipped = Array.isArray(entry.skipped) ? entry.skipped.map(sanitizeSkip).filter(Boolean) : [];
  const seen = new Set(skipped.map((item) => item.type));
  for (const type of DEFAULT_HIDDEN_TYPES) {
    if (!seen.has(type)) skipped.push({ type, reason: "default_hidden" });
  }
  return {
    ts: normalizeText(entry.ts) || new Date().toISOString(),
    thread: hashThreadId(entry.threadId || entry.thread),
    turn: normalizeText(entry.turnId || entry.turn),
    opening: entry.opening === true,
    blocks: Array.isArray(entry.blocks) ? entry.blocks.map(sanitizeBlock).filter(Boolean) : [],
    skipped,
    fallback: entry.fallback === true || normalizeText(entry.fallback) || false,
    total_chars: Math.max(0, Number(entry.total_chars) || 0),
    recall_calls: Array.isArray(entry.recall_calls) ? entry.recall_calls.map(sanitizeRecallCall) : [],
  };
}

function sanitizeBlock(block = {}) {
  const type = normalizeText(block.type);
  if (!type) return null;
  return {
    type,
    loaded: block.loaded === true,
    reason: normalizeText(block.reason),
    chars: Math.max(0, Number(block.chars) || 0),
    hash: normalizeText(block.hash),
    src_mtime: normalizeText(block.src_mtime),
  };
}

function sanitizeSkip(item = {}) {
  const type = normalizeText(item.type);
  if (!type) return null;
  return { type, reason: normalizeText(item.reason) || "unknown" };
}

function sanitizeRecallCall(item = {}) {
  return {
    trigger: normalizeText(item.trigger),
    results_count: Math.max(0, Number(item.results_count) || 0),
  };
}

function hashThreadId(value) {
  const normalized = normalizeText(value);
  return normalized ? crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 8) : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ContextTraceRecorder, DEFAULT_HIDDEN_TYPES, hashThreadId, sanitizeTraceEntry };
