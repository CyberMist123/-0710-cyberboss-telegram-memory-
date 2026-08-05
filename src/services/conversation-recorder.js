const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_AUTOMATION_TIMEZONE, localDateKey } = require("../utils/business-day");
const {
  classifyRecorderRoute,
  normalizeRecorderRouteSnapshot,
} = require("../continuity/subject-route");
const { sha256 } = require("../continuity/continuity-store");

class ConversationRecorder {
  constructor({ dirPath = "", automationTimezone = DEFAULT_AUTOMATION_TIMEZONE } = {}) {
    this.dirPath = dirPath;
    this.automationTimezone = automationTimezone;
  }

  record(entry = {}) {
    if (!this.dirPath) return null;
    const normalized = this.normalizeEntry(entry);
    if (!normalized) return null;
    fs.mkdirSync(this.dirPath, { recursive: true });
    const day = formatDateKey(normalized.timestamp, this.automationTimezone);
    const filePath = path.join(this.dirPath, `${day}.jsonl`);
    const sourceLine = JSON.stringify(normalized);
    fs.appendFileSync(filePath, `${sourceLine}\n`, "utf8");
    // Provenance evidence for the subject-signing path. This is the only place
    // that knows both the file chosen for this entry and the exact bytes
    // written, so the hash is computed here rather than re-derived by a reader
    // that would have to guess the day bucket and re-serialize the entry.
    // `readConversationRowsWithEvidence` hashes the raw file line, so
    // sha256(sourceLine) is the same digest it will recompute at Review time.
    // Non-enumerable: the recorded entry is serialized and deep-compared
    // elsewhere, and this is evidence about the row, not a field of it.
    Object.defineProperty(normalized, "sourceFile", { value: filePath });
    Object.defineProperty(normalized, "sourceLineSha256", { value: sha256(sourceLine) });
    return normalized;
  }

  normalizeEntry(entry = {}) {
    const type = String(entry.type || "").trim();
    if (!type) return null;
    const timestamp = normalizeTimestamp(entry.timestamp);
    const text = typeof entry.text === "string" ? entry.text : "";
    const route = normalizeRecorderRouteSnapshot(entry.route);
    return {
      id: String(entry.id || buildId(type, timestamp)),
      type,
      timestamp,
      threadId: normalizeText(entry.threadId),
      turnId: normalizeText(entry.turnId),
      workspaceRoot: normalizeText(entry.workspaceRoot),
      route,
      routeStatus: classifyRecorderRoute(route),
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

function formatDateKey(timestamp, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  const parsed = Date.parse(String(timestamp || "").trim());
  const instant = Number.isFinite(parsed) ? parsed : Date.now();
  return localDateKey(instant, automationTimezone) || new Date(instant).toISOString().slice(0, 10);
}
