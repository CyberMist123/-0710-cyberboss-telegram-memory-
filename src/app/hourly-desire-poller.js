const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadDesireSchedule, isNightSkipAt, nextPlannedAt } = require("../core/desire-schedule");
const { appendDesireTelemetry } = require("../core/desire-telemetry");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const { readLatestDesireHistory } = require("../core/desire-state-persistence");
const { isActivityPaused } = require("../core/activity-pause-state");

const ACTIVE_MARKER_STALE_MS = 2 * 60 * 60 * 1000;
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
    runHourlyDesireTick({
      config,
      queue,
      accountId,
      senderId,
      workspaceRoot,
      tickTime,
      schedule,
    });
    // Advance from the planned start, not from completion, and skip missed
    // intervals after sleep/resume instead of replaying them in a burst.
    plannedAt = nextPlannedAt(plannedAt, schedule.intervalMinutes, Date.now());
    writePlanMarker(config.desirePlanFile, plannedAt);
  }
}

function runHourlyDesireTick({
  config = {},
  queue,
  accountId,
  senderId,
  workspaceRoot,
  tickTime = Date.now(),
  schedule = loadDesireSchedule(config.desireScheduleFile),
} = {}) {
  if (isActivityPaused(config.activityPauseFile)) {
    console.log("[desire] hourly poller tick skipped: paused");
    return { status: "skipped", reason: "paused" };
  }
  if (schedule.enabled && !isNightSkipAt(tickTime, schedule)) {
    const id = crypto.randomUUID();
    const marker = { owner: `${process.pid}:${crypto.randomUUID()}`, eventId: id, startedAt: tickTime };
    if (queue.hasPendingForAccount(accountId) || !tryAcquireActiveMarker(config.desireActiveFile, marker)) {
      appendDesireTelemetry({ enabled: config.desireTelemetry, filePath: config.desireTelemetryFile, eventId: id, eventType: "overlap_skipped", outcome: "success", configuredTimezone: schedule.timezone, intervalMinutes: schedule.intervalMinutes });
      return { status: "skipped", reason: "overlap" };
    }
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
      console.log(`[desire] checkin queued id=${id} at=${new Date(tickTime).toISOString()}`);
      return { status: "queued", id };
    } catch (error) {
      releaseActiveMarker(config.desireActiveFile, marker);
      throw error;
    }
  }
  if (schedule.enabled && isNightSkipAt(tickTime, schedule)) {
    appendDesireTelemetry({ enabled: config.desireTelemetry, filePath: config.desireTelemetryFile, eventId: crypto.randomUUID(), eventType: "night_skipped", outcome: "success", configuredTimezone: schedule.timezone, intervalMinutes: schedule.intervalMinutes });
    return { status: "skipped", reason: "night" };
  }
  return { status: "skipped", reason: "disabled" };
}

function writePlanMarker(filePath, plannedAt) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ nextPlannedAt: new Date(plannedAt).toISOString() }), "utf8");
  } catch {}
}

function isActiveMarkerFresh(filePath, now = Date.now(), options = {}) {
  if (!filePath) return false;
  try {
    return markerIsFresh(JSON.parse(fs.readFileSync(filePath, "utf8")), now, options);
  } catch {
    return false;
  }
}

function tryAcquireActiveMarker(filePath, marker, now = Date.now(), options = {}) {
  if (!filePath) return true;
  const result = withActiveMarkerLease(filePath, () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let current = null;
    try {
      current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    if (current && markerIsFresh(current, now, options)) return false;
    if (current) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
      }
    }
    let handle;
    try {
      handle = fs.openSync(filePath, "wx");
      fs.writeFileSync(handle, JSON.stringify(marker), "utf8");
      fs.fsyncSync(handle);
      return true;
    } catch {
      return false;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  });
  return result.acquired && result.value === true;
}

function releaseActiveMarker(filePath, marker) {
  if (!filePath || !marker) return false;
  const result = withActiveMarkerLease(filePath, () => {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return false;
    }
    if (current.owner !== marker.owner || current.eventId !== marker.eventId) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  });
  return result.acquired && result.value === true;
}

function withActiveMarkerLease(filePath, action) {
  const leaseFile = `${filePath}.lease`;
  let lease;
  try {
    lease = acquireWriterLease(leaseFile, {
      writer: "desire-poller",
      model: "runtime",
      phase: "active-marker",
      branch: "runtime",
      worktree: path.dirname(filePath),
      base_sha: "runtime",
    }, {
      recoverStale: true,
      staleArchiveDir: path.join(path.dirname(filePath), ".stale-desire-marker-leases"),
    });
  } catch {
    return { acquired: false, value: false };
  }
  try {
    return { acquired: true, value: action() };
  } finally {
    try {
      releaseWriterLease(leaseFile, lease.lease_id);
    } catch {}
  }
}

function markerIsFresh(marker, now = Date.now(), { isProcessAlive = probeProcessAlive } = {}) {
  const timeFresh = Boolean(
    marker
    && marker.owner
    && marker.eventId
    && Number.isFinite(Number(marker.startedAt))
    && Number(now) - Number(marker.startedAt) <= ACTIVE_MARKER_STALE_MS
  );
  if (!timeFresh) return false;
  const pid = ownerPid(marker.owner);
  if (!pid) return true;
  const alive = isProcessAlive(pid);
  // An unknown process state (permission/platform boundary) retains the old
  // timestamp guard: waiting is safer than creating a second writer.
  return alive !== false;
}

function ownerPid(owner) {
  const match = /^(\d+):/u.exec(String(owner || "").trim());
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function probeProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
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
  if (!config?.desireLoopMinimalEnabled) {
    return `${userName}又过了一小时。回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？`;
  }
  const last = readLatestDesireHistory(config?.desireHistoryFile || "");
  const fallback = `${userName}又过了一小时。回顾这一小时，你内心有什么变化？上次你想做的那件事，后来做了没有、现在还想不想？此刻最想做的事是什么？各维度和上次比有什么变化？`;
  if (!last) {
    return fallback;
  }
  const previousWant = normalizeText(last.most_want);
  if (!isNaturalPreviousWant(previousWant)) {
    return fallback;
  }
  return `${userName}又过了一小时。上次你最想做的是「${previousWant}」。这件事后来做了没有、现在还想不想？回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度和上次比有什么变化？`;
}

function isNaturalPreviousWant(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.toLowerCase() === "none") {
    return false;
  }
  return !/^[a-z][a-z0-9_-]*$/i.test(normalized);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  runHourlyDesirePoller,
  isNightSkipAt,
  nextPlannedAt,
  isActiveMarkerFresh,
  tryAcquireActiveMarker,
  releaseActiveMarker,
  markerIsFresh,
  ownerPid,
  probeProcessAlive,
  buildDesireTriggerText,
  runHourlyDesireTick,
};
