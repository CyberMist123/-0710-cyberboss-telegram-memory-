const fs = require("fs");

const DEFAULT_SLEEP_WINDOW = Object.freeze({ start: "00:00", end: "06:00" });
const WALL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

class SleepWindowStore {
  constructor({ filePath } = {}) {
    this.filePath = typeof filePath === "string" ? filePath.trim() : "";
  }

  getWindow() {
    if (!this.filePath) {
      return { ...DEFAULT_SLEEP_WINDOW };
    }
    try {
      return normalizeSleepWindow(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      return { ...DEFAULT_SLEEP_WINDOW };
    }
  }
}

function normalizeSleepWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_SLEEP_WINDOW };
  }
  const start = typeof value.start === "string" ? value.start.trim() : "";
  const end = typeof value.end === "string" ? value.end.trim() : "";
  if (!WALL_TIME_PATTERN.test(start) || !WALL_TIME_PATTERN.test(end) || start === end) {
    return { ...DEFAULT_SLEEP_WINDOW };
  }
  return { start, end };
}

function wallTimeToMinutes(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!WALL_TIME_PATTERN.test(normalized)) {
    return NaN;
  }
  const [hour, minute] = normalized.split(":").map((part) => Number.parseInt(part, 10));
  return hour * 60 + minute;
}

module.exports = {
  DEFAULT_SLEEP_WINDOW,
  SleepWindowStore,
  normalizeSleepWindow,
  wallTimeToMinutes,
};
