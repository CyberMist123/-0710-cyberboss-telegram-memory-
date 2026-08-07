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

  // Reading her own diary back. `append` alone made the diary write-only from
  // her side: the directory sits under `runtime/`, outside the chat profile's
  // workspace, so the built-in Read tool cannot reach it either.
  async read({ date = "" } = {}) {
    const dateString = date || formatDate(new Date(), this.config.automationTimezone);
    assertDateKey(dateString);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    if (!fs.existsSync(filePath)) {
      return { filePath, date: dateString, exists: false, text: "" };
    }
    return {
      filePath,
      date: dateString,
      exists: true,
      text: fs.readFileSync(filePath, "utf8"),
    };
  }

  // Editing an entry she already wrote.
  //
  // Deliberately an exact-match replacement rather than a whole-file write: the
  // diary is hers, and a full rewrite makes it far too easy for one bad call to
  // erase a day. `find` must match exactly once, or nothing is written.
  async edit({ date = "", find = "", replace = "" } = {}) {
    const dateString = date || formatDate(new Date(), this.config.automationTimezone);
    assertDateKey(dateString);
    const needle = String(find || "");
    if (!needle.trim()) {
      throw new Error("Diary edit needs `find` text to locate the passage.");
    }
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No diary file for ${dateString}.`);
    }
    const original = fs.readFileSync(filePath, "utf8");
    const occurrences = original.split(needle).length - 1;
    if (occurrences === 0) {
      throw new Error(`That passage is not in the ${dateString} diary.`);
    }
    if (occurrences > 1) {
      throw new Error(`That passage appears ${occurrences} times in ${dateString}; include more context so it matches once.`);
    }
    const next = original.replace(needle, String(replace ?? ""));
    // Same-day backup before the first edit of the day, so a bad replacement is
    // recoverable without going to the whole-memory snapshot.
    const backupPath = `${filePath}.bak-${dateString}`;
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, original, "utf8");
    }
    fs.writeFileSync(filePath, next, "utf8");
    return {
      filePath,
      date: dateString,
      replaced: 1,
      removed: !String(replace ?? "").trim(),
      backupPath,
    };
  }
}

function assertDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) {
    throw new Error("Diary date must be YYYY-MM-DD.");
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
