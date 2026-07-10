const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createLocationStateEngine({
  longStayHours = 12,
  batteryCriticalThreshold = 10,
} = {}) {
  const longStayMs = Math.max(1, Number(longStayHours) || 12) * 60 * 60_000;
  const criticalThreshold = Number.isFinite(Number(batteryCriticalThreshold))
    ? Number(batteryCriticalThreshold)
    : 10;
  return {
    evaluate({
      point,
      enrichedPoint,
      currentStay,
      recentStays = [],
      movementEvent = null,
      previousSnapshot = {},
      now = new Date().toISOString(),
    } = {}) {
      const normalizedNow = normalizeIsoTime(now) || new Date().toISOString();
      const payloadBase = buildSnapshotBase({ point, enrichedPoint, currentStay, movementEvent, now: normalizedNow });
      const events = [];
      const previousPlaceKey = normalizeText(previousSnapshot?.currentPlaceKey);
      const currentPlaceKey = normalizeText(payloadBase.currentPlaceKey);
      const previousStayId = normalizeText(previousSnapshot?.currentStayId);
      const currentStayId = normalizeText(currentStay?.id);
      const previousStay = Array.isArray(recentStays) ? recentStays[0] || null : null;

      if (currentStayId && currentStayId !== previousStayId && currentPlaceKey && currentPlaceKey !== previousPlaceKey) {
        if (previousPlaceKey) {
          events.push(createEvent("LeftPlace", normalizedNow, {
            fromPlaceKey: previousPlaceKey,
            fromPlaceName: normalizeText(previousSnapshot?.currentPlaceName),
            fromPlaceTag: normalizeText(previousSnapshot?.currentPlaceTag),
            fromStayId: previousStayId,
            toPlaceKey: currentPlaceKey,
          }, {
            priority: "high",
            queueEligible: true,
            memoryEligible: true,
            dedupeKey: `LeftPlace:${previousStayId}:${currentStayId}`,
          }));
        }
        events.push(createEvent("ArrivedPlace", normalizedNow, {
          placeKey: currentPlaceKey,
          placeName: normalizeText(payloadBase.currentPlaceName),
          placeTag: normalizeText(payloadBase.currentPlaceTag),
          district: normalizeText(payloadBase.currentDistrict),
          city: normalizeText(payloadBase.currentCity),
          stayId: currentStayId,
        }, {
          priority: "high",
          queueEligible: true,
          memoryEligible: true,
          dedupeKey: `ArrivedPlace:${currentStayId}:${currentPlaceKey}`,
        }));
      }

      if (movementEvent) {
        events.push(createEvent("MajorMovement", normalizeIsoTime(movementEvent?.movedAt) || normalizedNow, {
          movementEventId: normalizeText(movementEvent?.id),
          distanceMeters: Number(movementEvent?.distanceMeters) || 0,
          fromPlaceName: normalizeText(previousStay?.placeName || previousStay?.address || previousStay?.placeTag),
          toPlaceName: normalizeText(payloadBase.currentPlaceName),
          fromPlaceTag: normalizeText(previousStay?.placeTag),
          toPlaceTag: normalizeText(payloadBase.currentPlaceTag),
        }, {
          priority: "high",
          queueEligible: true,
          memoryEligible: true,
          dedupeKey: `MajorMovement:${normalizeText(movementEvent?.id)}`,
        }));
      }

      const batteryLevel = normalizeFiniteNumber(point?.batteryLevel);
      const previousBatteryCritical = Boolean(previousSnapshot?.batteryCritical);
      if (Number.isFinite(batteryLevel) && batteryLevel <= criticalThreshold && !previousBatteryCritical) {
        events.push(createEvent("BatteryCritical", normalizedNow, {
          batteryLevel: Math.round(batteryLevel),
          placeName: normalizeText(payloadBase.currentPlaceName),
          placeTag: normalizeText(payloadBase.currentPlaceTag),
        }, {
          priority: "high",
          queueEligible: true,
          memoryEligible: true,
        }));
      }

      const stayEnteredAtMs = Date.parse(currentStay?.enteredAt || "");
      const longStayTriggeredStayId = normalizeText(previousSnapshot?.lastLongStayForStayId);
      if (
        currentStayId
        && Number.isFinite(stayEnteredAtMs)
        && Date.parse(normalizedNow) - stayEnteredAtMs >= longStayMs
        && longStayTriggeredStayId !== currentStayId
      ) {
        events.push(createEvent("LongStay", normalizedNow, {
          stayId: currentStayId,
          placeName: normalizeText(payloadBase.currentPlaceName),
          placeTag: normalizeText(payloadBase.currentPlaceTag),
          durationHours: round1((Date.parse(normalizedNow) - stayEnteredAtMs) / (60 * 60_000)),
        }, {
          priority: "medium",
          queueEligible: false,
          memoryEligible: false,
          dedupeKey: `LongStay:${currentStayId}`,
        }));
      }

      const snapshot = {
        currentStayId,
        currentPlaceKey,
        currentPlaceName: normalizeText(payloadBase.currentPlaceName),
        currentPlaceTag: normalizeText(payloadBase.currentPlaceTag),
        currentPlaceCategory: normalizeText(payloadBase.currentPlaceCategory),
        currentPlaceSource: normalizeText(payloadBase.currentPlaceSource),
        currentPoi: normalizeText(payloadBase.currentPoi),
        currentPoiType: normalizeText(payloadBase.currentPoiType),
        currentDistrict: normalizeText(payloadBase.currentDistrict),
        currentCity: normalizeText(payloadBase.currentCity),
        currentFormattedAddress: normalizeText(payloadBase.currentFormattedAddress),
        currentAdcode: normalizeText(payloadBase.currentAdcode),
        batteryLevel: Number.isFinite(batteryLevel) ? Math.round(batteryLevel) : null,
        batteryCritical: Number.isFinite(batteryLevel) ? batteryLevel <= criticalThreshold : previousBatteryCritical,
        lastMovementAt: normalizeIsoTime(movementEvent?.movedAt) || normalizeText(previousSnapshot?.lastMovementAt),
        lastLongStayForStayId: events.some((event) => event.type === "LongStay")
          ? currentStayId
          : longStayTriggeredStayId,
        updatedAt: normalizedNow,
      };
      return {
        snapshot,
        events,
      };
    },
  };
}

class LocationStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {
      snapshot: {},
      recentSnapshots: [],
      recentResolvedPlaces: [],
      recentDecisions: [],
      memoryInjectionStats: {
        totalCalls: 0,
        totalLinesInjected: 0,
        nonEmptyCalls: 0,
        lastInjectedAt: "",
      },
      recentMemoryInjections: [],
    };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const recentSnapshots = Array.isArray(parsed?.recentSnapshots) ? parsed.recentSnapshots : [];
      const recentResolvedPlaces = Array.isArray(parsed?.recentResolvedPlaces) ? parsed.recentResolvedPlaces : [];
      const recentDecisions = Array.isArray(parsed?.recentDecisions) ? parsed.recentDecisions : [];
      const recentMemoryInjections = Array.isArray(parsed?.recentMemoryInjections) ? parsed.recentMemoryInjections : [];
      this.state = {
        snapshot: parsed?.snapshot && typeof parsed.snapshot === "object" ? parsed.snapshot : {},
        recentSnapshots: recentSnapshots.filter((item) => item && typeof item === "object").slice(-50),
        recentResolvedPlaces: recentResolvedPlaces.filter((item) => item && typeof item === "object").slice(-50),
        recentDecisions: recentDecisions.filter((item) => item && typeof item === "object").slice(-100),
        memoryInjectionStats: normalizeMemoryInjectionStats(parsed?.memoryInjectionStats),
        recentMemoryInjections: recentMemoryInjections.filter((item) => item && typeof item === "object").slice(-100),
      };
    } catch {
      this.state = {
        snapshot: {},
        recentSnapshots: [],
        recentResolvedPlaces: [],
        recentDecisions: [],
        memoryInjectionStats: normalizeMemoryInjectionStats(null),
        recentMemoryInjections: [],
      };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getSnapshot() {
    this.load();
    return { ...this.state.snapshot };
  }

  getDebugState() {
    this.load();
    return {
      snapshot: { ...this.state.snapshot },
      recentSnapshots: this.state.recentSnapshots.map((item) => ({ ...item })),
      recentResolvedPlaces: this.state.recentResolvedPlaces.map((item) => ({ ...item })),
      recentDecisions: this.state.recentDecisions.map(cloneDecisionRecord),
      memoryInjectionStats: { ...this.state.memoryInjectionStats },
      recentMemoryInjections: this.state.recentMemoryInjections.map((item) => ({ ...item, lines: Array.isArray(item.lines) ? [...item.lines] : [] })),
    };
  }

  recordSnapshot(snapshot, { resolvedPlace = null } = {}) {
    this.load();
    const normalized = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
    this.state.snapshot = normalized;
    this.state.recentSnapshots.push({
      updatedAt: normalizeIsoTime(normalized.updatedAt) || new Date().toISOString(),
      currentPlaceName: normalizeText(normalized.currentPlaceName),
      currentPlaceTag: normalizeText(normalized.currentPlaceTag),
      currentPlaceCategory: normalizeText(normalized.currentPlaceCategory),
      currentStayId: normalizeText(normalized.currentStayId),
      batteryLevel: Number.isFinite(Number(normalized.batteryLevel)) ? Number(normalized.batteryLevel) : null,
    });
    this.state.recentSnapshots = this.state.recentSnapshots.slice(-50);
    const normalizedResolvedPlace = normalizeResolvedPlace(resolvedPlace, normalized.updatedAt);
    if (normalizedResolvedPlace) {
      this.state.recentResolvedPlaces.push(normalizedResolvedPlace);
      this.state.recentResolvedPlaces = this.state.recentResolvedPlaces.slice(-50);
    }
    this.save();
    return normalized;
  }

  recordDecisions(decisions = []) {
    this.load();
    const normalized = (Array.isArray(decisions) ? decisions : [])
      .map(normalizeDecisionRecord)
      .filter(Boolean);
    if (!normalized.length) {
      return [];
    }
    this.state.recentDecisions.push(...normalized);
    this.state.recentDecisions = this.state.recentDecisions.slice(-100);
    this.save();
    return normalized.map(cloneDecisionRecord);
  }

  recordMemoryInjection({ lines = [], source = "location_v2", used = false, text = "" } = {}) {
    this.load();
    const normalizedLines = Array.isArray(lines)
      ? lines.map((item) => normalizeText(item)).filter(Boolean).slice(0, 5)
      : [];
    const normalizedUsed = used === true;
    const recordedAt = new Date().toISOString();
    this.state.memoryInjectionStats = normalizeMemoryInjectionStats({
      ...this.state.memoryInjectionStats,
      totalCalls: Number(this.state.memoryInjectionStats?.totalCalls || 0) + 1,
      totalLinesInjected: Number(this.state.memoryInjectionStats?.totalLinesInjected || 0) + normalizedLines.length,
      nonEmptyCalls: Number(this.state.memoryInjectionStats?.nonEmptyCalls || 0) + (normalizedLines.length ? 1 : 0),
      lastInjectedAt: recordedAt,
    });
    this.state.recentMemoryInjections.push({
      recordedAt,
      source: normalizeText(source) || "location_v2",
      used: normalizedUsed,
      lineCount: normalizedLines.length,
      lines: normalizedLines,
      textPreview: normalizeText(text).slice(0, 160),
    });
    this.state.recentMemoryInjections = this.state.recentMemoryInjections.slice(-100);
    this.save();
  }
}

function buildSnapshotBase({ point, enrichedPoint, currentStay, movementEvent, now } = {}) {
  const placeTag = normalizeText(enrichedPoint?.placeTag) || normalizeText(currentStay?.placeTag);
  const placeName = normalizeText(enrichedPoint?.placeName)
    || normalizeText(currentStay?.placeName)
    || normalizeText(currentStay?.address)
    || normalizeText(enrichedPoint?.formattedAddress);
  const district = normalizeText(enrichedPoint?.district);
  const city = normalizeText(enrichedPoint?.city);
  const formattedAddress = normalizeText(enrichedPoint?.formattedAddress) || normalizeText(currentStay?.address);
  const poi = normalizeText(enrichedPoint?.poi);
  const poiType = normalizeText(enrichedPoint?.poiType);
  const placeCategory = normalizeText(enrichedPoint?.placeCategory);
  const placeSource = normalizeText(enrichedPoint?.placeSource);
  const adcode = normalizeText(enrichedPoint?.adcode);
  return {
    currentPlaceKey: buildCurrentPlaceKey({ placeTag, placeName, poi, city, district, formattedAddress, adcode }),
    currentPlaceTag: placeTag,
    currentPlaceCategory: placeCategory,
    currentPlaceSource: placeSource,
    currentPlaceName: placeName,
    currentPoi: poi,
    currentPoiType: poiType,
    currentDistrict: district,
    currentCity: city,
    currentFormattedAddress: formattedAddress,
    currentAdcode: adcode,
    movementEventId: normalizeText(movementEvent?.id),
    pointId: normalizeText(point?.id),
    updatedAt: now,
  };
}

function buildCurrentPlaceKey({ placeTag = "", placeName = "", poi = "", city = "", district = "", formattedAddress = "", adcode = "" } = {}) {
  if (placeTag && placeTag !== "unknown") {
    return `tag:${placeTag}`;
  }
  if (poi) {
    return `poi:${poi}`;
  }
  if (adcode && district) {
    return `district:${adcode}:${district}`;
  }
  if (city && district) {
    return `district:${city}:${district}`;
  }
  if (placeName) {
    return `name:${placeName}`;
  }
  if (formattedAddress) {
    return `address:${formattedAddress}`;
  }
  return "unknown";
}

function normalizeResolvedPlace(value, updatedAt) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    updatedAt: normalizeIsoTime(updatedAt) || new Date().toISOString(),
    placeName: normalizeText(value.placeName),
    placeTag: normalizeText(value.placeTag),
    placeCategory: normalizeText(value.placeCategory),
    placeSource: normalizeText(value.placeSource),
    city: normalizeText(value.city),
    district: normalizeText(value.district),
    poi: normalizeText(value.poi),
    poiType: normalizeText(value.poiType),
    formattedAddress: normalizeText(value.formattedAddress),
    adcode: normalizeText(value.adcode),
  };
}

function normalizeDecisionRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const event = value.event && typeof value.event === "object" ? value.event : {};
  return {
    accepted: value.accepted !== false,
    action: normalizeText(value.action) || "drop",
    reason: normalizeText(value.reason) || "unknown",
    recordedAt: normalizeIsoTime(event.occurredAt) || new Date().toISOString(),
    event: {
      id: normalizeText(event.id),
      type: normalizeText(event.type),
      occurredAt: normalizeIsoTime(event.occurredAt) || "",
      queueEligible: event.queueEligible === true,
      memoryEligible: event.memoryEligible !== false,
      dedupeKey: normalizeText(event.dedupeKey),
      payload: event.payload && typeof event.payload === "object" ? { ...event.payload } : {},
    },
  };
}

function cloneDecisionRecord(value) {
  return {
    ...value,
    event: value?.event && typeof value.event === "object"
      ? {
        ...value.event,
        payload: value.event.payload && typeof value.event.payload === "object" ? { ...value.event.payload } : {},
      }
      : {},
  };
}

function normalizeMemoryInjectionStats(value) {
  return {
    totalCalls: Math.max(0, Number.parseInt(String(value?.totalCalls || "0"), 10) || 0),
    totalLinesInjected: Math.max(0, Number.parseInt(String(value?.totalLinesInjected || "0"), 10) || 0),
    nonEmptyCalls: Math.max(0, Number.parseInt(String(value?.nonEmptyCalls || "0"), 10) || 0),
    lastInjectedAt: normalizeIsoTime(value?.lastInjectedAt) || "",
  };
}

function createEvent(type, occurredAt, payload, options = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    occurredAt,
    payload,
    priority: normalizeText(options.priority) || "medium",
    queueEligible: Boolean(options.queueEligible),
    memoryEligible: options.memoryEligible !== false,
    dedupeKey: normalizeText(options.dedupeKey),
  };
}

function normalizeFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

module.exports = {
  createLocationStateEngine,
  LocationStateStore,
};
