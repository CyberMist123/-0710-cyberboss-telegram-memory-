const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");
const { DEFAULT_AUTOMATION_TIMEZONE, localDateKey, zonedParts } = require("../utils/business-day");

class DiaryService {
  constructor({ config }) {
    this.config = config;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "" } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const dateString = date || formatDate(now, this.config.automationTimezone);
    const timeString = time || formatTime(now, this.config.automationTimezone);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
      sourceLabel: this.config.sourceLabel,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
    };
  }
}

function buildDiaryEntry({ timeString, title, body, sourceLabel = "" }) {
  const normalizedSourceLabel = String(sourceLabel || "").trim();
  const sourceSuffix = normalizedSourceLabel ? ` [source: ${normalizedSourceLabel}]` : "";
  const heading = title
    ? `## ${timeString} ${String(title).trim()}${sourceSuffix}`
    : `## ${timeString}${sourceSuffix}`;
  return `${heading}\n\n${body}`;
}

function formatDate(date, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  return localDateKey(date, automationTimezone) || new Date(date).toISOString().slice(0, 10);
}

function formatTime(date, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  const parts = zonedParts(date, automationTimezone);
  if (!parts) return new Date(date).toISOString().slice(11, 16);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

module.exports = {
  DiaryService,
  buildDiaryEntry,
  formatDate,
  formatTime,
};
