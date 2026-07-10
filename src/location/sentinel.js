function createLocationSentinel({
  eventStore,
  cooldownMinutes = 30,
  maxEventsPerHourByType = {},
} = {}) {
  const defaultCooldownMs = Math.max(1, Number(cooldownMinutes) || 30) * 60_000;
  return {
    process(events, snapshot = {}) {
      const accepted = [];
      const dropped = [];
      for (const event of Array.isArray(events) ? events : []) {
        const decision = decideEvent(event, snapshot, {
          eventStore,
          defaultCooldownMs,
          maxEventsPerHourByType,
        });
        if (decision.accepted) {
          accepted.push(decision);
        } else {
          dropped.push(decision);
        }
      }
      return { accepted, dropped };
    },
  };
}

function decideEvent(event, snapshot, { eventStore, defaultCooldownMs, maxEventsPerHourByType }) {
  const normalized = normalizeEvent(event, snapshot);
  if (!normalized) {
    return { accepted: false, event, action: "drop", reason: "invalid" };
  }
  const signalError = validateEventSignal(normalized);
  if (signalError) {
    return { accepted: false, event: normalized, action: "drop", reason: signalError };
  }
  const cooldownMs = resolveCooldownMs(normalized.type, defaultCooldownMs);
  if (eventStore?.hasRecentDedupeKey?.(normalized.dedupeKey, cooldownMs)) {
    return { accepted: false, event: normalized, action: "drop", reason: "dedupe" };
  }
  const maxPerHour = normalizePositiveInt(maxEventsPerHourByType?.[normalized.type], 0);
  if (maxPerHour > 0 && eventStore?.countRecentByType?.(normalized.type, 60 * 60_000) >= maxPerHour) {
    return { accepted: false, event: normalized, action: "drop", reason: "rate_limit" };
  }
  return {
    accepted: true,
    event: normalized,
    action: normalized.queueEligible ? "queue_and_store" : "store_only",
    reason: normalized.queueEligible ? "high_value" : "store_only",
  };
}

function validateEventSignal(event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  if (event.type === "ArrivedPlace") {
    const placeTag = normalizeText(payload.placeTag);
    const placeName = normalizeText(payload.placeName);
    if ((!placeName || placeName === "unknown") && (!placeTag || placeTag === "unknown")) {
      return "low_signal_place";
    }
    if (placeTag === "unknown" && !placeName) {
      return "unknown_place";
    }
  }
  if (event.type === "LeftPlace") {
    if (!normalizeText(payload.fromPlaceName) && !normalizeText(payload.fromPlaceTag)) {
      return "missing_origin";
    }
  }
  if (event.type === "MajorMovement") {
    const distance = Number(payload.distanceMeters);
    if (!Number.isFinite(distance) || distance <= 0) {
      return "missing_distance";
    }
  }
  if (event.type === "BatteryCritical") {
    const level = Number(payload.batteryLevel);
    if (!Number.isFinite(level)) {
      return "missing_battery";
    }
  }
  return "";
}

function normalizeEvent(event, snapshot) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const type = normalizeText(event.type);
  const occurredAt = normalizeIsoTime(event.occurredAt);
  if (!type || !occurredAt) {
    return null;
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  return {
    ...event,
    priority: normalizeText(event.priority) || "medium",
    type,
    occurredAt,
    payload,
    dedupeKey: normalizeText(event.dedupeKey) || buildDedupeKey(type, payload, snapshot, occurredAt),
    queueEligible: event.queueEligible === true,
    memoryEligible: event.memoryEligible !== false,
  };
}

function buildDedupeKey(type, payload, snapshot, occurredAt) {
  if (type === "ArrivedPlace") {
    return `${type}:${normalizeText(payload.placeTag) || normalizeText(payload.placeName)}:${snapshot?.currentStayId || normalizeText(payload.stayId)}`;
  }
  if (type === "LeftPlace") {
    return `${type}:${normalizeText(payload.fromPlaceTag) || normalizeText(payload.fromPlaceName)}:${normalizeText(payload.fromStayId)}`;
  }
  if (type === "MajorMovement") {
    return `${type}:${normalizeText(payload.movementEventId) || occurredAt}`;
  }
  if (type === "BatteryCritical") {
    return `${type}:${Math.floor(Date.parse(occurredAt) / (60 * 60_000))}`;
  }
  if (type === "LongStay") {
    return `${type}:${normalizeText(payload.stayId)}`;
  }
  return `${type}:${occurredAt}`;
}

function resolveCooldownMs(type, fallback) {
  if (type === "BatteryCritical") {
    return 2 * 60 * 60_000;
  }
  if (type === "LongStay") {
    return 12 * 60 * 60_000;
  }
  return fallback;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createLocationSentinel,
};
