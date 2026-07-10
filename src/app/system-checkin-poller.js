const crypto = require("crypto");

const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, SleepScheduleStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

async function runSystemCheckinPoller(config) {
  const account = resolveCheckinAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sleepScheduleStore = new SleepScheduleStore({ filePath: config.sleepScheduleFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
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
    });
    let delayMs = pickRandomDelayMs(effectiveRange.minIntervalMs, effectiveRange.maxIntervalMs);
    delayMs = capDelayAtSleepBoundary(delayMs, now);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config),
      sourceType: "checkin",
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

function resolveEffectiveRange({ defaultRange, sleepState, now, sleepScheduleStore }) {
  const baseRange = defaultRange || resolveDefaultCheckinRange();
  const inSleepWindow = isShanghaiSleepWindow(now);

  if (!inSleepWindow && sleepState?.sleeping && sleepScheduleStore?.setAwake) {
    sleepScheduleStore.setAwake({ resumedAt: new Date(now).toISOString() });
    console.log("[cyberboss] sleep mode auto-restored to awake after 06:30 Asia/Shanghai");
  }

  if (!inSleepWindow) {
    return baseRange;
  }

  return {
    minIntervalMs: 240 * 60_000,
    maxIntervalMs: 360 * 60_000,
  };
}

function capDelayAtSleepBoundary(delayMs, now) {
  if (!isShanghaiSleepWindow(now)) {
    return delayMs;
  }

  const boundaryAt = nextShanghaiWakeTimestamp(now);
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

function isShanghaiSleepWindow(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const [hourText, minuteText] = text.split(":");
  const hour = Number.parseInt(hourText || "0", 10);
  const minute = Number.parseInt(minuteText || "0", 10);
  return hour >= 22 || hour < 6 || (hour === 6 && minute < 30);
}

function nextShanghaiWakeTimestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return NaN;
  }

  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = local.split("-");
  return Date.parse(`${year}-${month}-${day}T06:30:00+08:00`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
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

module.exports = { runSystemCheckinPoller };
