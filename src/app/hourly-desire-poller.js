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

  // First plan honors the configured cadence too, not a pinned 55.
  let plannedAt = nextPlannedAt(null, loadDesireSchedule(config.desireScheduleFile).intervalMinutes, Date.now());
  writePlanMarker(config.desirePlanFile, plannedAt);
  console.log(`[desire] poller starts, next planned tick in ${Math.round(Math.max(0, plannedAt - Date.now()) / 60000)}m`);
  // 分片轮询：每片最多睡 WAKE_POLL_SLICE_MS，既能按计划到点触发，又能读到
  // 她上一轮 checkin 自填的 next_wake（她的回复晚于本轮 tick 落盘，只有下一
  // 片才读得到）。不设 next_wake 时行为与固定 cadence 完全一致。
  const WAKE_POLL_SLICE_MS = 60_000;
  while (true) {
    await sleep(Math.min(WAKE_POLL_SLICE_MS, Math.max(0, plannedAt - Date.now())));
    // 她自填的下次唤醒优先于默认 cadence；只接受未来时刻，用后即清。
    const overrideAt = readWakeOverrideAt(config.desireWakeOverrideFile);
    if (overrideAt > Date.now()) {
      plannedAt = overrideAt;
      clearWakeOverride(config.desireWakeOverrideFile);
      writePlanMarker(config.desirePlanFile, plannedAt);
    }
    if (Date.now() < plannedAt) {
      continue;
    }
    const tickTime = Date.now();
    const schedule = loadDesireSchedule(config.desireScheduleFile);
    // 天气取用在同步 tick 之外先 await 完，fail-open：拿不到就当没有，绝不炸 checkin。
    const weatherBrief = config.weatherInjectEnabled ? await fetchWeatherBriefSafe(config) : null;
    runHourlyDesireTick({
      config,
      queue,
      accountId,
      senderId,
      workspaceRoot,
      tickTime,
      schedule,
      weatherBrief,
    });
    // Advance from the planned start, not from completion, and skip missed
    // intervals after sleep/resume instead of replaying them in a burst.
    plannedAt = nextPlannedAt(plannedAt, schedule.intervalMinutes, Date.now());
    // 清掉本轮之前可能残留的 override（她这一轮的回复尚未落盘，不受影响）。
    clearWakeOverride(config.desireWakeOverrideFile);
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
  weatherBrief = null,
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
    // 网关：当天 + 首次 + 有内容（有预警）→ 缝一行天气；否则不动 checkin 文本。
    const weather = decideWeatherLine({ config, weatherBrief });
    const triggerText = buildDesireTriggerText(config);
    const text = weather.line ? `${triggerText}\n\n${weather.line}` : triggerText;
    try {
      queue.enqueue({
        id,
        markerOwner: marker.owner,
        markerEventId: marker.eventId,
        accountId,
        senderId,
        workspaceRoot,
        text,
        sourceType: "desire_checkin",
        createdAt: new Date().toISOString(),
      });
      // 只有确实缝了、且 enqueue 成功，才记「今日已投递」，保证一天一次幂等。
      if (weather.line) {
        writeWeatherDeliveredDate(config.weatherInjectStateFile, weather.today);
      }
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

// 自主唤醒 override：她在 checkin 里自填的下次唤醒时刻（绝对时间戳）。
// 由 app 层在解析她的回复时写入，poller 分片轮询时读取，用后即清。
function readWakeOverrideAt(filePath) {
  if (!filePath) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const at = Date.parse(parsed?.nextWakeAt || "");
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

function writeWakeOverride(filePath, wakeAtMs) {
  if (!filePath || !Number.isFinite(wakeAtMs)) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ nextWakeAt: new Date(wakeAtMs).toISOString() }), "utf8");
  } catch {}
}

function clearWakeOverride(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
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

// fail-open：只在 open_meteo 且开关开时取；任何异常吞成 null，绝不炸 checkin（不变量 5）。
async function fetchWeatherBriefSafe(config) {
  try {
    if (String(config?.weatherProvider || "").toLowerCase() !== "open_meteo") {
      return null;
    }
    const { createWeatherService } = require("../services/weather-service");
    return await createWeatherService({ config }).getDailyBrief();
  } catch (error) {
    console.warn(`[desire] weather brief skipped: ${error?.message || error}`);
    return null;
  }
}

// 网关：开关开 + 有预警 + 有 todayISO + 今日尚未投递 → 返回一行；否则空行。
function decideWeatherLine({ config, weatherBrief } = {}) {
  if (!config?.weatherInjectEnabled) return { line: "" };
  const alert = weatherBrief?.alert;
  const today = normalizeText(weatherBrief?.todayISO);
  if (!alert?.hasAlert || !today) return { line: "" };
  if (readWeatherDeliveredDate(config.weatherInjectStateFile) === today) return { line: "" };
  return { line: formatWeatherLine(weatherBrief), today };
}

// 只给事实 + 一个「可提醒她」的姿态提示，不写台词（北极星：改姿态不改内容）。
function formatWeatherLine(brief) {
  const city = normalizeText(brief?.location?.city) || "当地";
  const alert = brief?.alert || {};
  const parts = [];
  if (alert.rain) {
    const prob = alert.rain.probPct;
    parts.push(Number.isFinite(prob) ? `今天可能有雨（降雨概率 ${prob}%）` : "今天可能有雨");
  }
  if (alert.tempSwing) {
    const t = alert.tempSwing;
    if (Number.isFinite(t.todayHighC) && Number.isFinite(t.yesterdayHighC)) {
      parts.push(`较昨日最高温 ${t.yesterdayHighC}→${t.todayHighC}℃`);
    } else if (Number.isFinite(t.todayLowC) && Number.isFinite(t.yesterdayLowC)) {
      parts.push(`较昨日最低温 ${t.yesterdayLowC}→${t.todayLowC}℃`);
    } else {
      parts.push("气温较昨日变化明显");
    }
  }
  return `[今日天气·可提醒她] ${city}${parts.join("；")}。`;
}

// 单 writer：这个文件只在本文件的 enqueue 成功路径写，别处不许再写。
function readWeatherDeliveredDate(filePath) {
  if (!filePath) return "";
  try {
    return normalizeText(JSON.parse(fs.readFileSync(filePath, "utf8"))?.deliveredDate);
  } catch {
    return "";
  }
}

function writeWeatherDeliveredDate(filePath, date) {
  if (!filePath || !date) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ deliveredDate: date }), "utf8");
  } catch {}
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
  writeWakeOverride,
  fetchWeatherBriefSafe,
  decideWeatherLine,
  formatWeatherLine,
  readWeatherDeliveredDate,
  writeWeatherDeliveredDate,
};
