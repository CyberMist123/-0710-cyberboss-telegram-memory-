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

  mergeRecallCalls({ threadId, turnId, recallCalls } = {}) {
    if (!this.filePath || !Array.isArray(recallCalls) || !recallCalls.length) return Promise.resolve(false);
    const thread = hashThreadId(threadId);
    const turn = normalizeText(turnId);
    const calls = recallCalls.map(sanitizeRecallCall);
    this.queue = this.queue
      .catch(() => false)
      .then(async () => {
        let temp = "";
        try {
          const raw = await fs.promises.readFile(this.filePath, "utf8");
          const lines = raw.split(/\r?\n/u);
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (!lines[index].trim()) continue;
            let row;
            try { row = JSON.parse(lines[index]); } catch { continue; }
            if (row.thread !== thread || normalizeText(row.turn) !== turn) continue;
            row.recall_calls = calls;
            lines[index] = JSON.stringify(row);
            const next = `${lines.filter((line, lineIndex) => line || lineIndex < lines.length - 1).join("\n")}\n`;
            temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            await fs.promises.writeFile(temp, next, { encoding: "utf8", mode: 0o600 });
            await fs.promises.rename(temp, this.filePath);
            temp = "";
            return true;
          }
          return false;
        } catch (error) {
          console.warn(`[continuity] context trace recall sync failed: ${error.message || String(error)}`);
          return false;
        } finally {
          if (temp) await fs.promises.unlink(temp).catch(() => {});
        }
      });
    return this.queue;
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
    ...sanitizeEffect(block),
  };
}

function sanitizeSkip(item = {}) {
  const type = normalizeText(item.type);
  if (!type) return null;
  return { type, reason: normalizeText(item.reason) || "unknown", ...sanitizeEffect(item) };
}

/**
 * 「配置成什么」与「实际生效成什么」的分离字段（issue #76 目标 4）。
 *
 * 只在写入方明确给出时出现：reentry 的 opening 行需要它来区分
 * `effective=current / fallback / none`，其余块（current_state / memory_context /
 * default_hidden）的行形状保持逐字节不变，既有 trace 消费方不受影响。
 */
function sanitizeEffect(item = {}) {
  const configured = normalizeText(item.configured);
  const effective = normalizeText(item.effective);
  const degradedReason = normalizeText(item.degraded_reason);
  return {
    ...(configured ? { configured } : {}),
    ...(effective ? { effective } : {}),
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  };
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
