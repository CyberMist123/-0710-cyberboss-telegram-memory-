const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { isActivityPaused } = require("../core/activity-pause-state");
const { writeJsonAtomic } = require("../orchestration/atomic-json");
const {
  instantForLocalTime,
  localDateKey,
  shiftDateKey,
  zonedParts,
} = require("../utils/business-day");

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const BEATS = Object.freeze({
  consolidation: Object.freeze({
    enabled: "consolidationTriggerEnabled",
    hour: "consolidationHour",
    minute: "consolidationMinute",
    text: "到整理节拍了。",
    key: "dateKey",
  }),
  reflect: Object.freeze({
    enabled: "reflectTriggerEnabled",
    hour: "reflectHour",
    minute: "reflectMinute",
    text: "到 Reflect 节拍了。",
    key: "dateKey",
  }),
});

function isScheduleDue(now, hour, minute, timeZone) {
  const parts = zonedParts(now, timeZone);
  return Boolean(parts && parts.hour * 60 + parts.minute >= Number(hour) * 60 + Number(minute));
}

function nextScheduleAt(now, hour, minute, timeZone, options = {}) {
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) return NaN;
  const normalizedOptions = typeof options === "number"
    ? { intervalDays: options }
    : (options && typeof options === "object" ? options : {});
  const intervalDays = Math.max(1, Number(normalizedOptions.intervalDays) || 1);
  const today = localDateKey(start, timeZone);
  if (!today) return NaN;
  const afterLast = normalizedOptions.lastDateKey
    ? shiftDateKey(normalizedOptions.lastDateKey, intervalDays)
    : today;
  const candidateDateKey = afterLast && afterLast > today ? afterLast : today;
  const candidate = instantForLocalTime(candidateDateKey, timeZone, hour, minute);
  return Number.isFinite(candidate) ? candidate : NaN;
}

function readState(filePath) {
  if (!filePath) return { consolidation: {}, reflect: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      consolidation: parsed?.consolidation && typeof parsed.consolidation === "object" ? parsed.consolidation : {},
      reflect: parsed?.reflect && typeof parsed.reflect === "object" ? parsed.reflect : {},
    };
  } catch {
    return { consolidation: {}, reflect: {} };
  }
}

function writeState(filePath, state) {
  if (!filePath) return;
  writeJsonAtomic(filePath, state);
}

class SubjectBeatScheduler {
  constructor(options = {}) {
    this.config = options.config || {};
    this.queueStore = options.queueStore || null;
    this.accountId = options.accountId || "";
    this.senderId = options.senderId || "";
    this.workspaceRoot = options.workspaceRoot || this.config.workspaceRoot || "";
    this.clock = options.clock || { now: () => Date.now() };
    this.timers = options.timers || { setTimeout, clearTimeout };
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.tickInFlight = null;
  }

  get enabled() {
    return Object.values(BEATS).some((beat) => this.config[beat.enabled] === true);
  }

  start() {
    if (!this.enabled || this.started) return false;
    this.started = true;
    this.stopped = false;
    void this.scheduleTick();
    return true;
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    return this.tickInFlight || undefined;
  }

  async scheduleTick() {
    if (this.stopped || !this.enabled) return;
    try {
      const now = this.clock.now();
      const state = readState(this.config.subjectBeatStateFile);
      const candidates = Object.values(BEATS)
        .filter((beat) => this.config[beat.enabled] === true)
        .map((beat) => {
          const sourceType = beat === BEATS.reflect ? "reflect" : "consolidation";
          return nextScheduleAt(
            now,
            this.config[beat.hour],
            this.config[beat.minute],
            this.config.automationTimezone,
            {
              intervalDays: sourceType === "reflect" ? this.config.reflectIntervalDays : 1,
              lastDateKey: state[sourceType]?.dateKey,
            },
          );
        })
        .filter(Number.isFinite);
      const next = candidates.length ? Math.min(...candidates) : Number(now) + this.pollIntervalMs;
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.runScheduledTick();
      }, Math.max(0, next - Number(now)));
    } catch (error) {
      console.warn(`[automation] subject beat scheduling failed: ${error?.message || String(error)}`);
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.runScheduledTick();
      }, this.pollIntervalMs);
    }
  }

  async runScheduledTick() {
    if (this.stopped) return;
    try {
      await this.tick(this.clock.now());
    } catch (error) {
      console.warn(`[automation] subject beat tick failed: ${error?.stack || error?.message || String(error)}`);
    } finally {
      await this.scheduleTick();
    }
  }

  async tick(now = this.clock.now()) {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick(now).finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  async runTick(now) {
    const result = { consolidation: null, reflect: null };
    if (isActivityPaused(this.config.activityPauseFile)) {
      return {
        ...result,
        consolidation: { status: "skipped", reason: "paused" },
        reflect: { status: "skipped", reason: "paused" },
      };
    }
    for (const [sourceType, beat] of Object.entries(BEATS)) {
      if (this.config[beat.enabled] !== true) continue;
      try {
        result[sourceType] = this.runBeat(sourceType, beat, now);
      } catch (error) {
        console.warn(`[automation] ${sourceType} beat failed: ${error?.message || String(error)}`);
        result[sourceType] = { status: "skipped", reason: "error" };
      }
    }
    return result;
  }

  runBeat(sourceType, beat, now) {
    if (!isScheduleDue(now, this.config[beat.hour], this.config[beat.minute], this.config.automationTimezone)) {
      return { status: "skipped", reason: "not_due" };
    }
    const dateKey = localDateKey(now, this.config.automationTimezone);
    if (!dateKey) {
      return { status: "skipped", reason: "not_due" };
    }
    const state = readState(this.config.subjectBeatStateFile);
    const lastDateKey = state[sourceType]?.dateKey || "";
    if (lastDateKey === dateKey) {
      return { status: "skipped", reason: "already_triggered", key: dateKey };
    }
    if (sourceType === "reflect" && lastDateKey) {
      const elapsedDays = dateKeyDistance(lastDateKey, dateKey);
      if (!Number.isFinite(elapsedDays) || elapsedDays < Number(this.config.reflectIntervalDays)) {
        return { status: "skipped", reason: "interval_not_reached", key: dateKey };
      }
    }
    if (!this.queueStore || !this.accountId || !this.senderId || !this.workspaceRoot) {
      return { status: "skipped", reason: "target_unavailable" };
    }
    if (this.queueStore.hasPendingForAccount(this.accountId, {
      shouldInclude: (message) => message?.sourceType === sourceType,
    })) {
      return { status: "skipped", reason: "overlap" };
    }
    const id = `subject-beat:${sourceType}:${dateKey}:${crypto.randomUUID()}`;
    this.queueStore.enqueue({
      id,
      accountId: this.accountId,
      senderId: this.senderId,
      workspaceRoot: this.workspaceRoot,
      text: beat.text,
      sourceType,
      createdAt: new Date(now).toISOString(),
    });
    writeState(this.config.subjectBeatStateFile, {
      ...state,
      [sourceType]: { ...state[sourceType], [beat.key]: dateKey },
    });
    return { status: "queued", id, key: dateKey };
  }
}

function dateKeyDistance(fromDateKey, toDateKey) {
  const from = parseDateKey(fromDateKey);
  const to = parseDateKey(toDateKey);
  if (!from || !to) return NaN;
  return Math.floor((to - from) / 86_400_000);
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

module.exports = {
  SubjectBeatScheduler,
  isScheduleDue,
  nextScheduleAt,
};
