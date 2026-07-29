const DEFAULT_AUTOMATION_TIMEZONE = "Australia/Sydney";

function zonedParts(now, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: automationTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  } catch {
    return null;
  }
}

function localDateKey(now, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  const parts = zonedParts(now, automationTimezone);
  if (!parts || !Number.isInteger(parts.year)) return "";
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function shiftDateKey(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match || !Number.isInteger(days)) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function instantForLocalTime(dateKey, automationTimezone, hour = 0, minute = 0, second = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return NaN;
  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let guess = targetAsUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = zonedParts(guess, automationTimezone);
    if (!observed) return NaN;
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = targetAsUtc - observedAsUtc;
    guess += correction;
    if (correction === 0) break;
  }
  const verified = zonedParts(guess, automationTimezone);
  if (!verified || Object.keys(target).some((key) => verified[key] !== target[key])) return NaN;
  return guess;
}

function businessDayForDate(dateKey, automationTimezone = DEFAULT_AUTOMATION_TIMEZONE) {
  const nextDateKey = shiftDateKey(dateKey, 1);
  if (!nextDateKey) return null;
  const endExclusive = instantForLocalTime(nextDateKey, automationTimezone);
  if (!Number.isFinite(endExclusive)) return null;
  return {
    dateKey,
    automationTimezone,
    endExclusive,
    candidateTimestamp: new Date(endExclusive - 1000).toISOString(),
  };
}

function resolveBusinessDay(automationTimezone = DEFAULT_AUTOMATION_TIMEZONE, now = new Date()) {
  const currentDateKey = localDateKey(now, automationTimezone);
  const dateKey = shiftDateKey(currentDateKey, -1);
  const businessDay = businessDayForDate(dateKey, automationTimezone);
  return businessDay ? { ...businessDay, currentDateKey } : null;
}

function isBusinessDayWindowClosed(dateKey, currentBusinessDateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(currentBusinessDateKey || ""))
    && dateKey < currentBusinessDateKey;
}

module.exports = {
  DEFAULT_AUTOMATION_TIMEZONE,
  businessDayForDate,
  instantForLocalTime,
  isBusinessDayWindowClosed,
  localDateKey,
  resolveBusinessDay,
  shiftDateKey,
  zonedParts,
};
