const fs = require("fs");

const { writeJsonAtomic } = require("../orchestration/atomic-json");

const ACTIVITY_PAUSE_VERSION = 1;
const PAUSED_SYSTEM_MESSAGE_SOURCE_TYPES = new Set([
  "checkin",
  "desire_checkin",
  "liveness_alert",
]);

function readActivityPauseState(filePath, fsImpl = fs) {
  if (!filePath) {
    return defaultActivityPauseState();
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || parsed.version !== ACTIVITY_PAUSE_VERSION
      || typeof parsed.paused !== "boolean"
    ) {
      return defaultActivityPauseState();
    }
    return {
      version: ACTIVITY_PAUSE_VERSION,
      paused: parsed.paused,
      updatedAt: normalizeIsoTime(parsed.updatedAt),
    };
  } catch {
    return defaultActivityPauseState();
  }
}

function isActivityPaused(filePath, fsImpl = fs) {
  return readActivityPauseState(filePath, fsImpl).paused;
}

function writeActivityPauseState(filePath, paused, { now = Date.now() } = {}) {
  if (!filePath) {
    throw new Error("CYBERBOSS_STATE_DIR is required before changing autonomous activity.");
  }
  const state = {
    version: ACTIVITY_PAUSE_VERSION,
    paused: paused === true,
    updatedAt: new Date(now).toISOString(),
  };
  writeJsonAtomic(filePath, state);
  return state;
}

function isPausedSystemMessageSource(sourceType) {
  return PAUSED_SYSTEM_MESSAGE_SOURCE_TYPES.has(normalizeText(sourceType));
}

function defaultActivityPauseState() {
  return {
    version: ACTIVITY_PAUSE_VERSION,
    paused: false,
    updatedAt: "",
  };
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  const parsed = Date.parse(normalized);
  return normalized && Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ACTIVITY_PAUSE_VERSION,
  isActivityPaused,
  isPausedSystemMessageSource,
  readActivityPauseState,
  writeActivityPauseState,
};
