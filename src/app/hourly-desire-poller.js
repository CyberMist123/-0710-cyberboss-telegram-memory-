const crypto = require("crypto");
const fs = require("fs");
const { loadDesireSchedule, isNightSkipAt, nextPlannedAt } = require("../core/desire-schedule");
const { appendDesireTelemetry } = require("../core/desire-telemetry");

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
      const marker = { owner: `${process.pid}:${crypto.randomUUID()}`, eventId: id, startedAt: tickTime };
      if (queue.hasPendingForAccount(accountId) || !tryAcquireActiveMarker(config.desireActiveFile, marker)) {
        appendDesireTelemetry({ enabled: config.desireTelemetry, filePath: config.desireTelemetryFile, eventId: id, eventType: "overlap_skipped", outcome: "success", configuredTimezone: schedule.timezone, intervalMinutes: schedule.intervalMinutes });
      } else {
        try {
          queue.enqueue({
        id,
        markerOwner: marker.owner,
        markerEventId: marker.eventId,
        accountId,
        senderId,
        workspaceRoot,
        text: buildDesireTriggerText(config),
        sourceType: "desire_checkin",
        createdAt: new Date().toISOString(),
          });
          console.log(`[desire] checkin queued id=${id} at=${new Date(tickTime).toISOString()}Z`);
        } catch (error) {
          releaseActiveMarker(config.desireActiveFile, marker);
          throw error;
        }
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
    if (Number(now) - Number(marker.startedAt) > 2 * 60 * 60 * 1000) return false;
    return Boolean(marker.owner && marker.eventId);
  } catch { return false; }
}

function tryAcquireActiveMarker(filePath, marker) {
  if (!filePath) return true;
  try {
    fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, "wx");
    try { fs.writeFileSync(fd, JSON.stringify(marker), "utf8"); } finally { fs.closeSync(fd); }
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") return false;
    try {
      const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Number(Date.now()) - Number(current.startedAt) > 2 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        return tryAcquireActiveMarker(filePath, marker);
      }
    } catch {}
    return false;
  }
}

function releaseActiveMarker(filePath, marker) {
  if (!filePath || !marker) return false;
  try {
    const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (current.owner !== marker.owner || current.eventId !== marker.eventId) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch { return false; }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runHourlyDesirePoller, isNightSkipAt, nextPlannedAt, isActiveMarkerFresh, tryAcquireActiveMarker, releaseActiveMarker };
