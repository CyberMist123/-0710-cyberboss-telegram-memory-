const crypto = require("crypto");
const fs = require("fs");

const REENTRY_CHAR_BUDGET = 300;

function loadReentry({ filePath, episodesFile, budget = REENTRY_CHAR_BUDGET, now = new Date() } = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return { skipped: "missing" };
  try {
    const stat = fs.statSync(normalizedPath);
    const bytes = fs.readFileSync(normalizedPath);
    const originalText = bytes.toString("utf8");
    if (!originalText.trim()) return { skipped: "missing" };
    const text = filterExpiryHooks(originalText, now);
    if (!text.trim()) return { skipped: "expired" };
    const chars = countNonWhitespace(text);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (chars > budget) {
      console.warn(`[continuity] reentry skipped reason=over_budget chars=${chars} budget=${budget}`);
      return { skipped: "over_budget", chars, hash, src_mtime: stat.mtime.toISOString() };
    }
    const metadata = readEpisodeMetadata(episodesFile);
    return {
      text: metadata ? `${text.replace(/\s+$/u, "")}\n${metadata.line}` : text,
      chars,
      hash,
      src_mtime: stat.mtime.toISOString(),
      episode_count: metadata?.count,
      episode_earliest_month: metadata?.earliestMonth,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[continuity] reentry read failed: ${error.message || String(error)}`);
    }
    return { skipped: "missing" };
  }
}

function filterExpiryHooks(text, now) {
  const today = toLocalDate(now);
  return String(text || "").split(/\r?\n/u).filter((line) => {
    const matches = [...line.matchAll(/<!--\s*until:\s*(\d{4}-\d{2}-\d{2})\s*-->/giu)];
    return !matches.some((match) => isExpired(match[1], today));
  }).map((line) => line.replace(/<!--\s*until:\s*\d{4}-\d{2}-\d{2}\s*-->/giu, "")).join("\n");
}

function readEpisodeMetadata(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return null;
  try {
    const rows = fs.readFileSync(normalizedPath, "utf8").split(/\r?\n/u)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === "object" && !Array.isArray(row));
    const months = rows.flatMap((row) => Object.values(row)
      .filter((value) => typeof value === "string")
      .map((value) => /\b(\d{4}-\d{2})-\d{2}\b/u.exec(value)?.[1])
      .filter(Boolean));
    const earliestMonth = months.sort()[0] || "未知";
    return {
      count: rows.length,
      earliestMonth,
      line: `（episodes 共 ${rows.length} 条，最早至 ${earliestMonth}，细节你现在读不到）`,
    };
  } catch {
    return null;
  }
}

function isExpired(value, today) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : "";
  return Boolean(date && date < today);
}

function toLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function countNonWhitespace(value) {
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { REENTRY_CHAR_BUDGET, countNonWhitespace, filterExpiryHooks, loadReentry, readEpisodeMetadata };
