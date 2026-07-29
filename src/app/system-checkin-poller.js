const crypto = require("crypto");

const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, SleepScheduleStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { readPersistedDesireState } = require("../core/desire-state-persistence");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { resolveAppTimezone } = require("../utils/app-timezone");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

async function runSystemCheckinPoller(config) {
  const account = resolveCheckinAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sleepScheduleStore = new SleepScheduleStore({ filePath: config.sleepScheduleFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  const timezone = resolveAppTimezone();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const sleepState = sleepScheduleStore.getState();
    const now = Date.now();
    const effectiveRange = resolveEffectiveRange({
      defaultRange: currentRange,
      sleepState,
      now,
      sleepScheduleStore,
      timezone,
    });
    let delayMs = pickRandomDelayMs(effectiveRange.minIntervalMs, effectiveRange.maxIntervalMs);
    delayMs = capDelayAtSleepBoundary(delayMs, now, timezone);
    const wakeAt = formatLocalTime(Date.now() + delayMs, timezone);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    const desireState = config.desireLoopMinimalEnabled === true
      ? readPersistedDesireState(config.desireStateFile)
      : null;
    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config),
      sourceType: "checkin",
      createdAt: new Date().toISOString(),
      ...(desireState ? { desireState } : {}),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

function resolveEffectiveRange({
  defaultRange,
  sleepState,
  now,
  sleepScheduleStore,
  timezone = resolveAppTimezone(),
}) {
  const baseRange = defaultRange || resolveDefaultCheckinRange();
  const inSleepWindow = isSleepWindow(now, timezone);

  if (!inSleepWindow && sleepState?.sleeping && sleepScheduleStore?.setAwake) {
    sleepScheduleStore.setAwake({ resumedAt: new Date(now).toISOString() });
    console.log(`[cyberboss] sleep mode auto-restored to awake after 06:30 ${timezone}`);
  }

  if (!inSleepWindow) {
    return baseRange;
  }

  return {
    minIntervalMs: 240 * 60_000,
    maxIntervalMs: 360 * 60_000,
  };
}

function capDelayAtSleepBoundary(delayMs, now, timezone = resolveAppTimezone()) {
  if (!isSleepWindow(now, timezone)) {
    return delayMs;
  }

  const boundaryAt = nextWakeTimestamp(now, timezone);
  const boundaryDelayMs = boundaryAt - now;
  if (!Number.isFinite(boundaryDelayMs) || boundaryDelayMs <= 0) {
    return delayMs;
  }
  return Math.min(delayMs, boundaryDelayMs);
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the target user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the target user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function resolveCheckinAccount(config) {
  if (normalizeText(config?.channel) === "telegram") {
    return {
      accountId: normalizeText(config?.accountId) || "telegram",
      baseUrl: "https://api.telegram.org",
    };
  }
  const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
  return resolveSelectedAccount(config);
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSleepWindow(value, timezone = resolveAppTimezone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const { hour, minute } = resolveZonedDateParts(date, timezone);
  return hour >= 22 || hour < 6 || (hour === 6 && minute < 30);
}

function nextWakeTimestamp(value, timezone = resolveAppTimezone()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return NaN;
  }

  const local = resolveZonedDateParts(date, timezone);
  const afterWake = local.hour > 6 || (local.hour === 6 && local.minute >= 30);
  const wakeDate = afterWake
    ? shiftCalendarDate(local, 1)
    : local;
  return zonedWallTimeToTimestamp({
    year: wakeDate.year,
    month: wakeDate.month,
    day: wakeDate.day,
    hour: 6,
    minute: 30,
    second: 0,
  }, timezone);
}

function resolveZonedDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10),
    day: Number.parseInt(map.day, 10),
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10),
    second: Number.parseInt(map.second, 10),
  };
}

function shiftCalendarDate({ year, month, day }, days) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedWallTimeToTimestamp(parts, timezone) {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let timestamp = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = resolveZonedDateParts(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = targetAsUtc - actualAsUtc;
    if (adjustment === 0) {
      return timestamp;
    }
    timestamp += adjustment;
  }

  return timestamp;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value, timezone = resolveAppTimezone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  return INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
}

module.exports = {
  capDelayAtSleepBoundary,
  isSleepWindow,
  nextWakeTimestamp,
  resolveEffectiveRange,
  runSystemCheckinPoller,
};
