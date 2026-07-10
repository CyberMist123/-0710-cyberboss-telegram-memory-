const fs = require("fs");
const path = require("path");

class LocationEventStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { events: [] };
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
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      this.state = {
        events: events.map(normalizeEvent).filter(Boolean).sort(compareEvents),
      };
    } catch {
      this.state = { events: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  append(event) {
    this.load();
    const normalized = normalizeEvent(event);
    if (!normalized) {
      throw new Error("invalid location event");
    }
    this.state.events.push(normalized);
    this.state.events.sort(compareEvents);
    this.state.events = this.state.events.slice(-500);
    this.save();
    return normalized;
  }

  listRecent({ sinceHours = 24, limit = 200 } = {}) {
    this.load();
    const sinceMs = Math.max(1, Number(sinceHours) || 24) * 60 * 60 * 1000;
    const lowerBound = Date.now() - sinceMs;
    const normalizedLimit = Math.max(1, Number(limit) || 200);
    return this.state.events
      .filter((event) => Date.parse(event.occurredAt || "") >= lowerBound)
      .slice(-normalizedLimit)
      .reverse()
      .map(cloneEvent);
  }

  hasRecentDedupeKey(dedupeKey, withinMs) {
    const normalizedKey = normalizeText(dedupeKey);
    if (!normalizedKey) {
      return false;
    }
    const lowerBound = Date.now() - Math.max(1, Number(withinMs) || 1);
    return this.listRecent({ sinceHours: 72, limit: 500 }).some((event) => {
      return event.dedupeKey === normalizedKey && Date.parse(event.occurredAt || "") >= lowerBound;
    });
  }

  countRecentByType(type, withinMs) {
    const normalizedType = normalizeText(type);
    if (!normalizedType) {
      return 0;
    }
    const lowerBound = Date.now() - Math.max(1, Number(withinMs) || 1);
    return this.listRecent({ sinceHours: 72, limit: 500 }).filter((event) => {
      return event.type === normalizedType && Date.parse(event.occurredAt || "") >= lowerBound;
    }).length;
  }

  getDashboard({ sinceHours = 24 } = {}) {
    const events = this.listRecent({ sinceHours, limit: 500 });
    const countsByType = {};
    const queueEligibleByType = {};
    const memoryEligibleByType = {};
    for (const event of events) {
      countsByType[event.type] = (countsByType[event.type] || 0) + 1;
      if (event.queueEligible) {
        queueEligibleByType[event.type] = (queueEligibleByType[event.type] || 0) + 1;
      }
      if (event.memoryEligible) {
        memoryEligibleByType[event.type] = (memoryEligibleByType[event.type] || 0) + 1;
      }
    }
    return {
      sinceHours,
      totalEvents: events.length,
      countsByType,
      queueEligibleByType,
      memoryEligibleByType,
      recentEvents: events.slice(0, 20),
    };
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const id = normalizeText(event.id);
  const type = normalizeText(event.type);
  const occurredAt = normalizeIsoTime(event.occurredAt);
  if (!id || !type || !occurredAt) {
    return null;
  }
  return {
    id,
    type,
    priority: normalizeText(event.priority) || "medium",
    occurredAt,
    dedupeKey: normalizeText(event.dedupeKey),
    queueEligible: Boolean(event.queueEligible),
    memoryEligible: event.memoryEligible !== false,
    payload: event.payload && typeof event.payload === "object" ? event.payload : {},
  };
}

function cloneEvent(event) {
  return {
    ...event,
    payload: event.payload && typeof event.payload === "object" ? { ...event.payload } : {},
  };
}

function compareEvents(left, right) {
  const leftTime = Date.parse(left?.occurredAt || "") || 0;
  const rightTime = Date.parse(right?.occurredAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
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
  LocationEventStore,
};
