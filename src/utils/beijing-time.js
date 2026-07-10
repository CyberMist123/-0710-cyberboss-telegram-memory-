function pad(value) {
  return String(value).padStart(2, "0");
}

function resolveBeijingDate(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
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

function formatBeijingTime(input = new Date()) {
  const parts = resolveBeijingDate(input);
  if (!parts) {
    return "";
  }
  return `北京时间 ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function formatBeijingDateTime(input = new Date()) {
  const parts = resolveBeijingDate(input);
  if (!parts) {
    return "";
  }
  return `北京时间 ${parts.year}-${parts.month}-${parts.day} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

module.exports = {
  formatBeijingDateTime,
  formatBeijingTime,
};
