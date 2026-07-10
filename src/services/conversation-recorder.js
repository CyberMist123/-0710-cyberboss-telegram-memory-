const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class ConversationRecorder {
  constructor({ dirPath = "" } = {}) {
    this.dirPath = dirPath;
  }

  record(entry = {}) {
    if (!this.dirPath) return;
    const normalized = this.normalizeEntry(entry);
    if (!normalized) return;
    fs.mkdirSync(this.dirPath, { recursive: true });
    const day = formatDateKey(normalized.timestamp);
    const filePath = path.join(this.dirPath, `${day}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, "utf8");
  }

  normalizeEntry(entry = {}) {
    const type = String(entry.type || "").trim();
    if (!type) return null;
    const timestamp = normalizeTimestamp(entry.timestamp);
    const text = typeof entry.text === "string" ? entry.text : "";
    return {
      id: String(entry.id || buildId(type, timestamp)),
      type,
      timestamp,
      threadId: normalizeText(entry.threadId),
      turnId: normalizeText(entry.turnId),
      workspaceRoot: normalizeText(entry.workspaceRoot),
      text,
      meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
    };
  }
}

function normalizeTimestamp(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text) return text;
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildId(type, timestamp) {
  return `${type}:${timestamp}:${crypto.randomBytes(4).toString("hex")}`;
}

module.exports = { ConversationRecorder };

function formatDateKey(timestamp) {
  const parsed = Date.parse(String(timestamp || "").trim());
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString().slice(0, 10);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}
