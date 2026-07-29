function normalizeTimezone(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveAppTimezone({
  env = process.env,
  localTimezone,
  dateTimeFormat = Intl.DateTimeFormat,
} = {}) {
  const configuredTimezone = normalizeTimezone(env?.CYBERBOSS_TIMEZONE);
  const hostTimezone = configuredTimezone
    ? ""
    : (localTimezone === undefined
      ? normalizeTimezone(new dateTimeFormat().resolvedOptions().timeZone)
      : normalizeTimezone(localTimezone));
  const timezone = configuredTimezone || hostTimezone;

  if (!timezone) {
    throw new Error("Cannot resolve the application timezone from CYBERBOSS_TIMEZONE or the host.");
  }

  try {
    new dateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch (cause) {
    const source = configuredTimezone ? "CYBERBOSS_TIMEZONE" : "host";
    throw new RangeError(`Invalid ${source} timezone: ${timezone}`, { cause });
  }

  return timezone;
}

module.exports = { resolveAppTimezone };
