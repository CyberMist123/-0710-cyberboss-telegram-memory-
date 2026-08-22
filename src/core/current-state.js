const crypto = require("crypto");
const fs = require("fs");
const { countNonWhitespace } = require("./reentry-loader");
const { readDesireRuntimeState } = require("../services/desire-service");

const CURRENT_STATE_CHAR_BUDGET = 100;
// 姿态是上一次心跳/八维报告落盘的瞬时状态，不是"现在"。开窗时它可能已经是几小时
// 甚至一天前的东西；原样注入会让刚醒的窗口把旧姿态当当下认领（2026-08-22 真机：
// 开机读到"她刚睡下，我不打扰"，张口就是"你不睡？"，实际是晚上八点）。
// 超过 STALE_AFTER 只标注"这是 N 小时前的"，不丢——Owner 2026-08-22 裁定：标注就够，
// 再旧也让她自己判断，不替她决定什么不该看。
const CURRENT_STATE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

function loadCurrentState({ filePath, overrideFilePath = "", now = () => Date.now() } = {}) {
  try {
    const overrideText = readOverrideText(overrideFilePath);
    if (overrideText) return buildCurrentStatePayload(overrideText, "manual_override");
    const parsed = readDesireRuntimeState(filePath);
    if (!parsed) return { skipped: "missing" };
    const summary = summarizeCurrentState(parsed);
    if (!summary) return { skipped: "missing" };
    const ageMs = resolveStateAgeMs(parsed, now);
    const text = ageMs !== null && ageMs > CURRENT_STATE_STALE_AFTER_MS
      ? `（${formatAge(ageMs)}前的姿态，不是现在）${summary}`
      : summary;
    const payload = buildCurrentStatePayload(text, "desire_runtime");
    if (ageMs !== null && !payload.skipped) payload.age_hours = Math.floor(ageMs / 3600000);
    return payload;
  } catch (error) {
    console.warn(`[continuity] current state read failed: ${error.message || String(error)}`);
    return { skipped: "missing" };
  }
}

// 顶层 updatedAt 是 DesireService 每次落盘写的；缺失或不可解析时按"未知"处理，
// 不标注也不丢（fail-open，与 loader 其余分支一致）。
function resolveStateAgeMs(state = {}, now) {
  const raw = normalizeText(state?.updatedAt || state?.updated_at);
  if (!raw) return null;
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return null;
  const nowMs = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - stamp);
}

function formatAge(ageMs) {
  const hours = Math.floor(ageMs / 3600000);
  return hours >= 1 ? `${hours} 小时` : `${Math.max(1, Math.floor(ageMs / 60000))} 分钟`;
}

function readOverrideText(filePath = "") {
  const normalized = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalized) return "";
  try {
    return fs.readFileSync(normalized, "utf8").trim();
  } catch {
    return "";
  }
}

function buildCurrentStatePayload(text, source) {
  const chars = countNonWhitespace(text);
  if (chars > CURRENT_STATE_CHAR_BUDGET) return { skipped: "over_budget", chars, source };
  return {
    text,
    chars,
    source,
    hash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
  };
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
// 没有 intent 对象；只取 most_want 压成一行。驱力分数行（"依恋0.9↑ 沉思0.6↑"）
// 不再注入：那是报账语言，persona 信里明令停用，塞在开机第一屏只会把窗口拉回账本腔。
function summarizeDesireReportState(state = {}) {
  const mostWant = truncateNonWhitespace(normalizeText(state?.most_want), 70);
  return mostWant ? `此刻:${mostWant}` : "";
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

module.exports = {
  CURRENT_STATE_CHAR_BUDGET,
  CURRENT_STATE_STALE_AFTER_MS,
  loadCurrentState,
  summarizeCurrentState,
};
