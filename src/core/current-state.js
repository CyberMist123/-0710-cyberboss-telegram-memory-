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
  if (parts.length) return parts.join("；").trim();
  return summarizeDesireReportState(state);
}

// Claude 八维报告落盘的形状是 {most_want, drives:[{label,score,change}]}，
// 没有 intent 对象；压成一行短姿态，留在 100 字预算内。
function summarizeDesireReportState(state = {}) {
  const mostWant = truncateNonWhitespace(normalizeText(state?.most_want), 70);
  const drives = (Array.isArray(state?.drives) ? state.drives : [])
    .filter((row) => row && typeof row === "object" && normalizeText(row.label) && Number.isFinite(Number(row.score)))
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, 2)
    .map((row) => `${normalizeText(row.label)}${Number(row.score)}${changeArrow(row.change)}`);
  const parts = [];
  if (mostWant) parts.push(`此刻:${mostWant}`);
  if (drives.length) parts.push(drives.join(" "));
  return parts.join("；").trim();
}

function changeArrow(change) {
  const normalized = normalizeText(change);
  if (normalized === "up") return "↑";
  if (normalized === "down") return "↓";
  return "";
}

function truncateNonWhitespace(value, budget) {
  const text = String(value || "");
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) count += 1;
    if (count > budget) return `${text.slice(0, index)}…`;
  }
  return text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

module.exports = { CURRENT_STATE_CHAR_BUDGET, loadCurrentState, summarizeCurrentState };
