const { resolveAppTimezone } = require("./app-timezone");

function pad(value) {
  return String(value).padStart(2, "0");
}

function resolveAppDate(input = new Date(), timezoneOptions) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveAppTimezone(timezoneOptions),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function formatAppTime(input = new Date(), timezoneOptions) {
  const parts = resolveAppDate(input, timezoneOptions);
  if (!parts) {
    return "";
  }
  return `本地时间 ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatAppDateTime(input = new Date(), timezoneOptions) {
  const parts = resolveAppDate(input, timezoneOptions);
  if (!parts) {
    return "";
  }
  return `本地时间 ${parts.year}-${parts.month}-${parts.day} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

const formatBeijingDateTime = formatAppDateTime;
const formatBeijingTime = formatAppTime;

module.exports = {
  formatAppDateTime,
  formatAppTime,
  formatBeijingDateTime,
  formatBeijingTime,
};
