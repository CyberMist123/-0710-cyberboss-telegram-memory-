function buildRecentStateMemoryLines(events, { maxLines = 3 } = {}) {
  const normalizedLimit = Math.max(1, Number(maxLines) || 3);
  const normalizedEvents = Array.isArray(events) ? events : [];
  const lines = [];
  for (const event of normalizedEvents) {
    if (!event?.memoryEligible) {
      continue;
    }
    const line = formatEventLine(event);
    if (!line) {
      continue;
    }
    lines.push(line);
    if (lines.length >= normalizedLimit) {
      break;
    }
  }
  return lines;
}

function formatEventLine(event) {
  const timeLabel = formatShortTime(event?.occurredAt);
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const placeName = normalizeText(payload.placeName) || normalizeText(payload.toPlaceName) || normalizeText(payload.placeTag);
  const districtText = normalizeText(payload.district) || normalizeText(payload.city);
  if (event.type === "ArrivedPlace") {
    return `[位置状态] ${timeLabel} 到达${placeName || "新地点"}${districtText ? `（${districtText}）` : ""}`;
  }
  if (event.type === "LeftPlace") {
    return `[位置状态] ${timeLabel} 离开${normalizeText(payload.fromPlaceName) || normalizeText(payload.fromPlaceTag) || "原地点"}`;
  }
  if (event.type === "MajorMovement") {
    const distance = Number(payload.distanceMeters);
    const distanceText = Number.isFinite(distance)
      ? (distance >= 1000 ? `${(distance / 1000).toFixed(1)}km` : `${Math.round(distance)}m`)
      : "显著移动";
    const fromName = normalizeText(payload.fromPlaceName) || normalizeText(payload.fromPlaceTag);
    const toName = normalizeText(payload.toPlaceName) || normalizeText(payload.toPlaceTag);
    if (fromName || toName) {
      return `[位置状态] ${timeLabel} 发生显著移动：${fromName || "原地点"} -> ${toName || "新地点"}（${distanceText}）`;
    }
    return `[位置状态] ${timeLabel} 发生显著移动（${distanceText}）`;
  }
  if (event.type === "BatteryCritical") {
    const level = Number(payload.batteryLevel);
    const atPlace = normalizeText(payload.placeName) || normalizeText(payload.placeTag);
    return `[位置状态] ${timeLabel} 电量危险${Number.isFinite(level) ? `（${Math.round(level)}%）` : ""}${atPlace ? `，位置：${atPlace}` : ""}`;
  }
  return "";
}

function formatShortTime(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    return "--:--";
  }
  const date = new Date(parsed);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildRecentStateMemoryLines,
};
