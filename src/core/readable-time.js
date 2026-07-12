function formatReadableTime(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/u);
  if (!match) return text;
  return `${match[1]} ${match[2]}:${match[3]}`;
}

function formatReadableTimesInText(value) {
  const text = String(value || "");
  return text.replace(
    /(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/gu,
    "$1 $2:$3",
  );
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { formatReadableTime, formatReadableTimesInText };
