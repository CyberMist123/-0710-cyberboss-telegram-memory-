const crypto = require("crypto");
const { countNonWhitespace } = require("./reentry-loader");
const { readDesireRuntimeState } = require("../services/desire-service");

const CURRENT_STATE_CHAR_BUDGET = 100;

function loadCurrentState({ filePath } = {}) {
  try {
    const parsed = readDesireRuntimeState(filePath);
    if (!parsed) return { skipped: "missing" };
    const text = summarizeCurrentState(parsed);
    if (!text) return { skipped: "missing" };
    const chars = countNonWhitespace(text);
    if (chars > CURRENT_STATE_CHAR_BUDGET) return { skipped: "over_budget", chars };
    return {
      text,
      chars,
      hash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    };
  } catch (error) {
    console.warn(`[continuity] current state read failed: ${error.message || String(error)}`);
    return { skipped: "missing" };
  }
}

function summarizeCurrentState(state = {}) {
  const intent = state?.intent && typeof state.intent === "object" ? state.intent : {};
  const action = normalizeText(intent.want_action || intent.action);
  const drive = normalizeText(intent.drive_key);
  const reason = normalizeText(intent.reason);
  const parts = [];
  if (drive) parts.push(`姿态:${drive}`);
  if (action && action !== "none") parts.push(`倾向:${action}`);
  if (reason) parts.push(`缘由:${reason}`);
  return parts.join("；").trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

module.exports = { CURRENT_STATE_CHAR_BUDGET, loadCurrentState, summarizeCurrentState };
