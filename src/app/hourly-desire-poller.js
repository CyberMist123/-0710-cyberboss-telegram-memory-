const crypto = require("crypto");
const fs = require("fs");
const { loadDesireSchedule, isNightSkipAt, nextPlannedAt } = require("../core/desire-schedule");
const { appendDesireTelemetry } = require("../core/desire-telemetry");

const SHANGHAI_TZ = "Asia/Shanghai";

async function runHourlyDesirePoller(config = {}) {
  if (!config.desireDriven) {
    console.log("[desire] hourly poller disabled");
    return;
  }

  const { SessionStore } = require("../adapters/runtime/codex/session-store");
  const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });

  const { accountId, senderId, workspaceRoot } = resolveDesirePollerTargets({ config, sessionStore });
  if (!senderId || !workspaceRoot) {
    console.error("[desire] hourly poller: cannot resolve sender/workspace, aborting");
    return;
  }

  let plannedAt = nextPlannedAt(null, 55, Date.now());
  writePlanMarker(config.desirePlanFile, plannedAt);
  console.log(`[desire] poller starts, next planned tick in ${Math.round(Math.max(0, plannedAt - Date.now()) / 60000)}m`);
  while (true) {
    await sleep(Math.max(0, plannedAt - Date.now()));
    const tickTime = Date.now();
    const schedule = loadDesireSchedule(config.desireScheduleFile);
    if (schedule.enabled && !isNightSkipAt(tickTime, schedule)) {
      const id = crypto.randomUUID();
      if (queue.hasPendingForAccount(accountId) || isActiveMarkerFresh(config.desireActiveFile)) {
        appendDesireTelemetry({ enabled: config.desireTelemetry, filePath: config.desireTelemetryFile, eventId: id, eventType: "overlap_skipped", outcome: "success", configuredTimezone: schedule.timezone, intervalMinutes: schedule.intervalMinutes });
      } else {
        writeActiveMarker(config.desireActiveFile, id, tickTime);
      queue.enqueue({
        id,
        accountId,
        senderId,
        workspaceRoot,
        text: buildDesireTriggerText(config),
        sourceType: "desire_checkin",
        createdAt: new Date().toISOString(),
      });
      console.log(`[desire] hourly checkin queued id=${id} at=${formatShanghai(tickTime)}`);
      }
    } else if (schedule.enabled && isNightSkipAt(tickTime, schedule)) {
      appendDesireTelemetry({ enabled: config.desireTelemetry, filePath: config.desireTelemetryFile, eventId: crypto.randomUUID(), eventType: "night_skipped", outcome: "success", configuredTimezone: schedule.timezone, intervalMinutes: schedule.intervalMinutes });
    }
    // Advance from the planned start, not from completion, and skip missed
    // intervals after sleep/resume instead of replaying them in a burst.
    plannedAt = nextPlannedAt(plannedAt, schedule.intervalMinutes, Date.now());
    writePlanMarker(config.desirePlanFile, plannedAt);
  }
}

function writePlanMarker(filePath, plannedAt) {
  if (!filePath) return;
  try {
    fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ nextPlannedAt: new Date(plannedAt).toISOString() }), "utf8");
  } catch {}
}

function isActiveMarkerFresh(filePath, now = Date.now()) {
  if (!filePath) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Number(now) - Number(marker.startedAt) > 2 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      return false;
    }
    return Boolean(marker.id);
  } catch { return false; }
}

function writeActiveMarker(filePath, id, startedAt) {
  if (!filePath) return;
  try {
    fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ id, startedAt }), "utf8");
  } catch {}
}

function resolveDesirePollerTargets({ config, sessionStore }) {
  const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
  if (config.channel === "telegram") {
    const accountId = normalizeText(config.accountId) || "telegram";
    const senderId = resolvePreferredSenderId({ config, accountId, sessionStore });
    const workspaceRoot = resolvePreferredWorkspaceRoot({ config, accountId, senderId, sessionStore });
    return { accountId, senderId, workspaceRoot };
  }

  const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
  const account = resolveSelectedAccount(config);
  const senderId = resolvePreferredSenderId({ config, accountId: account.accountId, sessionStore });
  const workspaceRoot = resolvePreferredWorkspaceRoot({ config, accountId: account.accountId, senderId, sessionStore });
  return { accountId: account.accountId, senderId, workspaceRoot };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildDesireTriggerText(config) {
  const userName = (process.env.CYBERBOSS_USER_NAME || "").trim() || "ta";
  return `${userName}又过了一小时。回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？`;
}

function isDesireWindow(value) {
  const date = value instanceof Date ? value : new Date(value);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SHANGHAI_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour >= 6 && hour < 22;
}

function nextHourlyTickMs(now) {
  const OFFSET_MS = 8 * 60 * 60 * 1000;
  const localMs = now + OFFSET_MS;
  const nextLocalMs = Math.floor(localMs / 3_600_000) * 3_600_000 + 3_600_000;
  return Math.max(0, nextLocalMs - OFFSET_MS - now);
}

function formatShanghai(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runHourlyDesirePoller, isNightSkipAt, nextPlannedAt, isActiveMarkerFresh };
