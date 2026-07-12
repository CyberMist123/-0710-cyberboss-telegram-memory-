const crypto = require("crypto");
const fs = require("fs");

const REENTRY_CHAR_BUDGET = 300;

function loadReentry({ filePath, budget = REENTRY_CHAR_BUDGET } = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return { skipped: "missing" };
  try {
    const stat = fs.statSync(normalizedPath);
    const bytes = fs.readFileSync(normalizedPath);
    const text = bytes.toString("utf8");
    if (!text.trim()) return { skipped: "missing" };
    const chars = countNonWhitespace(text);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (chars > budget) {
      console.warn(`[continuity] reentry skipped reason=over_budget chars=${chars} budget=${budget}`);
      return { skipped: "over_budget", chars, hash, src_mtime: stat.mtime.toISOString() };
    }
    return { text, chars, hash, src_mtime: stat.mtime.toISOString() };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[continuity] reentry read failed: ${error.message || String(error)}`);
    }
    return { skipped: "missing" };
  }
}

function countNonWhitespace(value) {
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { REENTRY_CHAR_BUDGET, countNonWhitespace, loadReentry };
