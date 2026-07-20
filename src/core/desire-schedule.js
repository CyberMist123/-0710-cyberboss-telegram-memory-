const fs = require("fs");

const DEFAULT_DESIRE_SCHEDULE = Object.freeze({
  enabled: true,
  intervalMinutes: 55,
  nightSkipEnabled: true,
  nightStart: "22:00",
  nightEnd: "06:00",
  timezone: "Australia/Sydney",
});

function loadDesireSchedule(filePath = "") {
  let parsed = {};
  try { parsed = filePath ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {}; } catch { parsed = {}; }
  return normalizeDesireSchedule(parsed);
}

function normalizeDesireSchedule(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const timezone = isValidTimeZone(input.timezone) ? input.timezone : DEFAULT_DESIRE_SCHEDULE.timezone;
  const intervalMinutes = Number(input.intervalMinutes ?? input.desire_interval_minutes);
  return {
    enabled: input.enabled !== false,
    intervalMinutes: intervalMinutes === 55 ? 55 : DEFAULT_DESIRE_SCHEDULE.intervalMinutes,
    nightSkipEnabled: input.nightSkipEnabled ?? input.night_skip_enabled ?? DEFAULT_DESIRE_SCHEDULE.nightSkipEnabled,
    nightStart: validClock(input.nightStart ?? input.night_start) ? (input.nightStart ?? input.night_start) : DEFAULT_DESIRE_SCHEDULE.nightStart,
    nightEnd: validClock(input.nightEnd ?? input.night_end) ? (input.nightEnd ?? input.night_end) : DEFAULT_DESIRE_SCHEDULE.nightEnd,
    timezone,
  };
}

function isValidTimeZone(timezone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(timezone) }).format(); return Boolean(timezone); } catch { return false; }
}
function validClock(value) { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function clockMinutes(value) { const [h, m] = value.split(":").map(Number); return h * 60 + m; }

function isNightSkipAt(date, schedule) {
  const cfg = normalizeDesireSchedule(schedule);
  if (!cfg.nightSkipEnabled || cfg.nightStart === cfg.nightEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(date));
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const current = hh * 60 + mm;
  const start = clockMinutes(cfg.nightStart); const end = clockMinutes(cfg.nightEnd);
  return start > end ? current >= start || current < end : current >= start && current < end;
}

function nextPlannedAt(previousPlannedAt, intervalMinutes = 55, now = Date.now()) {
  const intervalMs = 55 * 60 * 1000;
  const previous = Number(previousPlannedAt);
  if (!Number.isFinite(previous)) return Number(now) + intervalMs;
  let next = previous + intervalMs;
  while (next <= Number(now)) next += intervalMs;
  return next;
}

function scheduleLocalTime(date, timezone) {
  const cfg = normalizeDesireSchedule({ timezone });
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "medium" });
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: cfg.timezone, timeZoneName: "longOffset", hour: "2-digit" }).formatToParts(new Date(date)).find((p) => p.type === "timeZoneName")?.value || "UTC";
  return { timezone: cfg.timezone, local: formatter.format(new Date(date)), offset };
}

module.exports = { DEFAULT_DESIRE_SCHEDULE, loadDesireSchedule, normalizeDesireSchedule, isNightSkipAt, nextPlannedAt, scheduleLocalTime, isValidTimeZone };
