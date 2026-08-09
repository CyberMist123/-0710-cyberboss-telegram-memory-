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
    key: "weekKey",
  }),
});

function isScheduleDue(now, hour, minute, timeZone) {
  const parts = zonedParts(now, timeZone);
  return Boolean(parts && parts.hour * 60 + parts.minute >= Number(hour) * 60 + Number(minute));
}

function nextScheduleAt(now, hour, minute, timeZone, weekday = null) {
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) return NaN;
  let dateKey = localDateKey(start, timeZone);
  if (!dateKey) return NaN;
  for (let offset = 0; offset <= (weekday === null ? 2 : 8); offset += 1) {
    const candidateDateKey = offset ? shiftDateKey(dateKey, offset) : dateKey;
    if (!candidateDateKey) continue;
    if (weekday !== null && weekdayForDateKey(candidateDateKey) !== Number(weekday)) continue;
    const candidate = instantForLocalTime(candidateDateKey, timeZone, hour, minute);
    if (Number.isFinite(candidate) && candidate >= start.getTime()) return candidate;
  }
  return NaN;
}

function weekdayForDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return NaN;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function isoWeekKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
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
      const candidates = Object.values(BEATS)
        .filter((beat) => this.config[beat.enabled] === true)
        .map((beat) => nextScheduleAt(
          now,
          this.config[beat.hour],
          this.config[beat.minute],
          this.config.automationTimezone,
          beat === BEATS.reflect ? this.config.reflectWeekday : null,
        ))
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
    const weekKey = isoWeekKey(dateKey);
    if (!dateKey || (sourceType === "reflect" && weekdayForDateKey(dateKey) !== Number(this.config.reflectWeekday))) {
      return { status: "skipped", reason: "not_due" };
    }
    const key = sourceType === "reflect" ? weekKey : dateKey;
    const state = readState(this.config.subjectBeatStateFile);
    if (state[sourceType]?.[beat.key] === key) {
      return { status: "skipped", reason: "already_triggered", key };
    }
    if (!this.queueStore || !this.accountId || !this.senderId || !this.workspaceRoot) {
      return { status: "skipped", reason: "target_unavailable" };
    }
    if (this.queueStore.hasPendingForAccount(this.accountId, {
      shouldInclude: (message) => message?.sourceType === sourceType,
    })) {
      return { status: "skipped", reason: "overlap" };
    }
    const id = `subject-beat:${sourceType}:${key}:${crypto.randomUUID()}`;
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
      [sourceType]: { ...state[sourceType], [beat.key]: key },
    });
    return { status: "queued", id, key };
  }
}

module.exports = {
  SubjectBeatScheduler,
  isoWeekKey,
  isScheduleDue,
  nextScheduleAt,
  weekdayForDateKey,
};
