const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_AUTOMATION_TIMEZONE, localDateKey } = require("../utils/business-day");
const {
  classifyRecorderRoute,
  normalizeRecorderRouteSnapshot,
} = require("../continuity/subject-route");

class ConversationRecorder {
  constructor({ dirPath = "", automationTimezone = DEFAULT_AUTOMATION_TIMEZONE } = {}) {
    this.dirPath = dirPath;
    this.automationTimezone = automationTimezone;
  }

  record(entry = {}) {
    if (!this.dirPath) return;
    const normalized = this.normalizeEntry(entry);
    if (!normalized) return;
    fs.mkdirSync(this.dirPath, { recursive: true });
    const day = formatDateKey(normalized.timestamp, this.automationTimezone);
    const filePath = path.join(this.dirPath, `${day}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, "utf8");
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
