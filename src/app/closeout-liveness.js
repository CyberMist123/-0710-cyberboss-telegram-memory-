const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const { writeJsonAtomic } = require("../orchestration/atomic-json");
const { createContinuityPipeline, runAuthoritativeCloseout } = require("../continuity/closeout-job");
const { isActivityPaused } = require("../core/activity-pause-state");
const {
  DEFAULT_AUTOMATION_TIMEZONE: DEFAULT_TIMEZONE,
  businessDayForDate,
  isBusinessDayWindowClosed,
  resolveBusinessDay,
  zonedParts,
} = require("../utils/business-day");
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_CLOSEOUT_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_CLOSEOUT_MAX_ATTEMPTS = 3;
const MAX_ALERT_DELIVERY_ATTEMPTS = 3;

function businessDateKey(now, timeZone = DEFAULT_TIMEZONE) {
  return resolveBusinessDay(timeZone, now)?.dateKey || "";
}

function nextCloseoutRetryAt(filePath, now) {
  const state = readState(filePath);
  const entries = state.closeout && typeof state.closeout === "object"
    ? Object.values(state.closeout)
    : [];
  let next = Infinity;
  for (const entry of entries) {
    if (!entry || !["failed", "no_output", "retryable_no_output"].includes(entry.status)) continue;
    const retryAt = Date.parse(entry.next_retry_at || "");
    if (Number.isFinite(retryAt)) next = Math.min(next, Math.max(Number(now), retryAt));
    else if (["no_output", "retryable_no_output"].includes(entry.status)) next = Math.min(next, Number(now));
  }
  return next;
}

function pendingCloseoutDates(state, currentBusinessDateKey, maxAttempts) {
  const closeout = state.closeout && typeof state.closeout === "object" ? state.closeout : {};
  return Object.entries(closeout)
    .filter(([date, entry]) => /^\d{4}-\d{2}-\d{2}$/.test(date)
      && date < currentBusinessDateKey
      && (["no_output", "retryable_no_output"].includes(entry?.status)
        || (entry?.status === "failed" && Number(entry.attempts || 0) < maxAttempts)))
    .map(([date]) => date)
    .sort();
}

function isScheduleDue(now, hour, minute, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(now, timeZone);
  if (!parts) return false;
  return parts.hour * 60 + parts.minute >= Number(hour) * 60 + Number(minute);
}

function nextScheduleAt(now, hour, minute, timeZone = DEFAULT_TIMEZONE) {
  const start = new Date(now);
  if (!Number.isFinite(start.getTime())) return NaN;
  const floor = Math.floor(start.getTime() / 60_000) * 60_000;
  const targetHour = Number(hour);
  const targetMinute = Number(minute);
  for (let offset = 0; offset <= 72 * 60; offset += 1) {
    const candidate = floor + offset * 60_000;
    const parts = zonedParts(candidate, timeZone);
    if (!parts || parts.hour !== targetHour || parts.minute !== targetMinute) continue;
    if (candidate >= start.getTime()) return candidate;
  }
  return NaN;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function recordTimestamp(record) {
  if (!record || typeof record !== "object") return null;
  for (const key of ["ts", "timestamp", "time", "created_at", "createdAt", "updated_at", "updatedAt"]) {
    const parsed = normalizeTimestamp(record[key]);
    if (parsed !== null) return parsed;
  }
  const date = String(record.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : null;
}

function inspectJsonl({ key, label, filePath, now = Date.now(), thresholdHours = 48, fsImpl = fs, authoritativeSuccessFiles = [] } = {}) {
  const result = {
    key,
    label: label || key,
    filePath: filePath || "",
    status: "missing",
    reason: "missing",
    fingerprint: `${key}:missing`,
    latestRecordAt: null,
    ageMs: null,
    validRecordCount: 0,
    tailPartial: false,
    checkedAt: new Date(now).toISOString(),
  };
  if (!filePath) {
    result.status = "unreadable";
    result.reason = "path_not_configured";
    result.fingerprint = `${key}:path_not_configured`;
    return result;
  }

  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    result.status = error?.code === "ENOENT" ? "missing" : "unreadable";
    result.reason = result.status;
    result.fingerprint = `${key}:${result.reason}`;
    result.lastErrorType = error?.code || "read_failed";
    return result;
  }
  if (!String(raw).trim()) {
    result.status = "empty";
    result.reason = "empty";
    result.fingerprint = `${key}:empty`;
    return result;
  }

  const text = String(raw);
  const hasTrailingNewline = /\r?\n\s*$/.test(text);
  const lines = text.split(/\r?\n/);
  let latest = null;
  let invalidLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("record must be an object");
      result.validRecordCount += 1;
      const timestamp = recordTimestamp(parsed);
      if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
    } catch (error) {
      const isFinalPartial = index === lines.length - 1 && !hasTrailingNewline && result.validRecordCount > 0;
      if (isFinalPartial) {
        result.tailPartial = true;
        continue;
      }
      invalidLine = true;
      result.lastErrorType = error?.message || "invalid_jsonl";
      break;
    }
  }
  if (invalidLine) {
    result.status = "corrupt";
    result.reason = "jsonl_corrupt";
    result.fingerprint = `${key}:jsonl_corrupt`;
    return result;
  }

  if (latest === null && result.validRecordCount > 0) {
    const authoritative = findAuthoritativeSuccess({ files: authoritativeSuccessFiles, now, fsImpl });
    if (authoritative) {
      latest = authoritative;
      result.authoritativeSuccess = true;
    } else {
      result.status = "no_valid_record";
      result.reason = "no_timestamped_record";
      result.fingerprint = `${key}:no_timestamped_record`;
      return result;
    }
  }
  if (result.validRecordCount === 0) {
    result.status = "corrupt";
    result.reason = "no_valid_record";
    result.fingerprint = `${key}:no_valid_record`;
    return result;
  }

  result.latestRecordAt = latest;
  result.ageMs = Math.max(0, Number(now) - latest);
  const thresholdMs = Math.max(0, Number(thresholdHours) || 0) * 60 * 60 * 1000;
  result.status = result.ageMs > thresholdMs ? "stale" : "healthy";
  result.reason = result.status;
  result.fingerprint = `${key}:${result.status}`;
  return result;
}

function findAuthoritativeSuccess({ files = [], now, fsImpl = fs } = {}) {
  let latest = null;
  for (const filePath of Array.isArray(files) ? files : []) {
    if (!filePath) continue;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
      if (String(parsed?.status || "").toLowerCase() !== "success") continue;
      const timestamp = recordTimestamp(parsed) || normalizeTimestamp(parsed.completed_at) || normalizeTimestamp(parsed.completedAt);
      if (timestamp !== null && timestamp <= Number(now) && (latest === null || timestamp > latest)) latest = timestamp;
    } catch {}
  }
  return latest;
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "尚无有效记录";
  const hours = Math.max(1, Math.floor(ageMs / 3_600_000));
  if (hours >= 48) return `${Math.floor(hours / 24)} 天`;
  return `${hours} 小时`;
}

function buildLivenessMessage({ finding, accountId, senderId, workspaceRoot, createdAt = new Date().toISOString(), alertKind = "failure" }) {
  const isRecovery = alertKind === "recovery";
  const text = isRecovery
    ? `✅ ${finding.label} 已恢复：检测到新的有效记录。`
    : `⚠️ ${finding.label}${finding.status === "stale" ? ` 已 ${formatAge(finding.ageMs)} 没有新的有效记录` : ` 当前为 ${finding.reason}`}，请检查自动记录链路。`;
  return {
    id: `liveness:${finding.key}:${alertKind}:${crypto.randomUUID()}`,
    accountId,
    senderId,
    workspaceRoot,
    text,
    sourceType: "liveness_alert",
    alertKind,
    alertKey: finding.key,
    fingerprint: finding.fingerprint,
    deliveryAttempts: 0,
    maxDeliveryAttempts: MAX_ALERT_DELIVERY_ATTEMPTS,
    createdAt,
  };
}

function readState(filePath, fsImpl = fs) {
  if (!filePath) return { checks: {} };
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object"
      ? { ...parsed, checks: parsed.checks && typeof parsed.checks === "object" ? parsed.checks : {} }
      : { checks: {} };
  } catch {
    return { checks: {} };
  }
}

function writeState(filePath, state) {
  if (!filePath) return;
  writeJsonAtomic(filePath, state);
}

function normalizeState(previous, finding, now) {
  const prior = previous && typeof previous === "object" ? previous : {};
  const failing = finding.status !== "healthy";
  const sameFailure = prior.status === "failing" && prior.fingerprint === finding.fingerprint;
  return {
    status: failing ? "failing" : "healthy",
    fingerprint: failing ? finding.fingerprint : "healthy",
    first_seen_at: failing && sameFailure ? prior.first_seen_at || now : (failing ? now : prior.first_seen_at || null),
    last_checked_at: now,
    last_alerted_at: prior.last_alerted_at || null,
    recovered_at: failing ? null : (prior.status === "failing" ? now : prior.recovered_at || null),
    last_error_type: failing ? finding.reason : null,
    last_alert_attempted_at: prior.last_alert_attempted_at || null,
    last_delivery_status: prior.last_delivery_status || null,
    last_delivery_error: prior.last_delivery_error || null,
    recovery_alerted_at: prior.recovery_alerted_at || null,
    recovery_attempted_at: prior.recovery_attempted_at || null,
    alert_pending: prior.alert_pending === true,
  };
}

function shouldSuppressInitialAlert(previous, current, finding, now, graceMinutes) {
  if (finding.status === "healthy") return false;
  if (["corrupt", "unreadable"].includes(finding.status)) return false;
  if (previous && previous.first_seen_at) return false;
  return Number(now) - Date.parse(current.first_seen_at) < Math.max(0, Number(graceMinutes) || 0) * 60_000;
}

function shouldAlertFailure(previous, current, finding, now, options = {}) {
  if (finding.status === "healthy") return false;
  if (shouldSuppressInitialAlert(previous, current, finding, now, options.startupGraceMinutes)) return false;
  if (current.alert_pending) return false;
  if (previous?.status !== "failing" || previous.fingerprint !== finding.fingerprint) return true;
  const lastAttempt = Date.parse(current.last_alert_attempted_at || "");
  const cooldownMs = Math.max(0, Number(options.cooldownHours) || 0) * 60 * 60 * 1000;
  return !Number.isFinite(lastAttempt) || Number(now) - lastAttempt >= cooldownMs;
}

function acquireLivenessLease(filePath, config, options = {}) {
  if (!filePath) return null;
  return acquireWriterLease(filePath, {
    writer: "closeout-liveness",
    model: "runtime",
    phase: "alerts",
    branch: config?.continuityBranch || "runtime",
    worktree: config?.continuityWorktree || config?.workspaceRoot || path.dirname(filePath),
    base_sha: config?.continuityBaseSha || "0".repeat(40),
  }, {
    recoverStale: true,
    staleArchiveDir: path.join(path.dirname(filePath), ".stale-liveness-leases"),
    isProcessAlive: options.isProcessAlive,
  });
}

class CloseoutLivenessAutomation {
  constructor(options = {}) {
    this.config = options.config || {};
    this.queueStore = options.queueStore || null;
    this.runtimeAdapter = options.runtimeAdapter || null;
    this.accountId = options.accountId || "";
    this.senderId = options.senderId || "";
    this.workspaceRoot = options.workspaceRoot || this.config.workspaceRoot || "";
    this.closeoutRunner = options.closeoutRunner || null;
    this.clock = options.clock || { now: () => Date.now() };
    this.timers = options.timers || { setTimeout, clearTimeout };
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.retryDelayMs = options.retryDelayMs || DEFAULT_CLOSEOUT_RETRY_DELAY_MS;
    this.maxCloseoutAttempts = options.maxCloseoutAttempts || DEFAULT_CLOSEOUT_MAX_ATTEMPTS;
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.tickInFlight = null;
  }

  get enabled() {
    return Boolean(this.config.nightlyCloseoutEnabled || this.config.canonLivenessEnabled || this.config.recallLivenessEnabled);
  }

  start() {
    if (!this.enabled || this.started) return false;
    this.started = true;
    this.stopped = false;
    void this.scheduleTick(true);
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

  async scheduleTick(immediate = false) {
    if (this.stopped) return;
    if (immediate) {
      await this.runScheduledTick();
      return;
    }
    const now = this.clock.now();
    if (isActivityPaused(this.config.activityPauseFile)) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.runScheduledTick();
      }, this.pollIntervalMs);
      return;
    }
    const nextCloseout = this.config.nightlyCloseoutEnabled
      ? Math.min(
        nextScheduleAt(now, this.config.nightlyCloseoutHour, this.config.nightlyCloseoutMinute, this.config.automationTimezone),
        nextCloseoutRetryAt(this.config.closeoutRetryStateFile, now),
      )
      : Infinity;
    const nextLiveness = (this.config.canonLivenessEnabled || this.config.recallLivenessEnabled)
      ? Number(now) + this.pollIntervalMs
      : Infinity;
    const delay = Math.max(0, Math.min(nextCloseout, nextLiveness) - Number(now));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.runScheduledTick();
    }, Number.isFinite(delay) ? delay : this.pollIntervalMs);
  }

  async runScheduledTick() {
    if (this.stopped) return;
    try {
      await this.tick(this.clock.now());
    } catch (error) {
      console.error(`[automation] closeout/liveness tick failed: ${error?.stack || error?.message || String(error)}`);
    } finally {
      await this.scheduleTick(false);
    }
  }

  async tick(now = this.clock.now()) {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick(now).finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  async runTick(now) {
    const result = { closeout: null, liveness: [] };
    if (isActivityPaused(this.config.activityPauseFile)) {
      console.log("[automation] closeout/liveness tick skipped: paused");
      return {
        ...result,
        closeout: { status: "skipped", reason: "paused" },
      };
    }
    if (this.config.nightlyCloseoutEnabled && isScheduleDue(now, this.config.nightlyCloseoutHour, this.config.nightlyCloseoutMinute, this.config.automationTimezone)) {
      try {
        result.closeout = await this.runCloseout(now);
      } catch (error) {
        console.error(`[automation] nightly closeout failed: ${error?.stack || error?.message || String(error)}`);
      }
    }
    if (this.config.canonLivenessEnabled || this.config.recallLivenessEnabled) {
      try {
        result.liveness = await this.runLivenessChecks(now);
      } catch (error) {
        console.error(`[automation] liveness check failed: ${error?.stack || error?.message || String(error)}`);
      }
    }
    return result;
  }

  async runCloseout(now) {
    const currentBusinessDay = resolveBusinessDay(this.config.automationTimezone, now);
    if (!currentBusinessDay) return { status: "skipped", reason: "invalid_business_date" };
    const state = readState(this.config.closeoutRetryStateFile);
    const dates = [
      ...pendingCloseoutDates(state, currentBusinessDay.dateKey, this.maxCloseoutAttempts),
      currentBusinessDay.dateKey,
    ];
    const results = [];
    for (const date of [...new Set(dates)]) {
      const businessDay = date === currentBusinessDay.dateKey
        ? currentBusinessDay
        : businessDayForDate(date, this.config.automationTimezone);
      if (!businessDay) {
        results.push({ status: "skipped", reason: "invalid_business_date", date });
        continue;
      }
      results.push(await this.runCloseoutDate({
        now,
        date,
        businessDay,
        windowClosed: isBusinessDayWindowClosed(date, currentBusinessDay.dateKey),
      }));
    }
    if (results.length === 1) return results[0];
    return { status: "batch", date: currentBusinessDay.dateKey, results };
  }

  async runCloseoutDate({ now, date, businessDay, windowClosed }) {
    const state = readState(this.config.closeoutRetryStateFile);
    const previous = state.closeout?.[date] || {};
    const nowMs = Number(now);
    if (previous.status === "success" || previous.status === "sealed_no_output") {
      return { status: "skipped", reason: "already_completed", date };
    }
    if (!windowClosed && previous.next_retry_at && Date.parse(previous.next_retry_at) > nowMs) {
      return { status: "skipped", reason: "retry_backoff", date };
    }
    if (previous.status === "failed" && Number(previous.attempts || 0) >= this.maxCloseoutAttempts) {
      return { status: "skipped", reason: "retry_limit", date };
    }

    let claim;
    try {
      claim = acquireLivenessLease(this.config.closeoutAutomationLeaseFile, this.config);
    } catch (error) {
      if (/already held/.test(error?.message || "")) {
        return { status: "skipped", reason: "claim_unavailable", date };
      }
      throw error;
    }

    const runner = this.closeoutRunner || ((payload) => runAuthoritativeCloseout({
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      date: payload.date,
      businessDay: payload.businessDay,
      windowClosed: payload.windowClosed,
      pipeline: createContinuityPipeline(this.config),
    }));
    try {
      const output = await runner({ date, businessDate: date, businessDay, windowClosed, now });
      const status = output?.status === "success"
        ? "success"
        : output?.status === "sealed_no_output"
          ? "sealed_no_output"
          : output?.status === "retryable_no_output"
            ? "retryable_no_output"
            : output?.status === "no_output"
              ? (windowClosed ? "sealed_no_output" : "retryable_no_output")
              : "failed";
      const attempts = Number(previous.attempts || 0) + (status === "failed" ? 1 : 0);
      const shouldRetry = status === "retryable_no_output"
        || (status === "failed" && attempts < this.maxCloseoutAttempts);
      this.writeCloseoutState(date, {
        status,
        attempts,
        last_attempt_at: new Date(nowMs).toISOString(),
        next_retry_at: shouldRetry ? new Date(nowMs + this.retryDelayMs).toISOString() : null,
        last_error: status === "failed" ? "authoritative_closeout_incomplete" : null,
      });
      return { ...output, status, date, window_closed: windowClosed };
    } catch (error) {
      const attempts = Number(previous.attempts || 0) + 1;
      this.writeCloseoutState(date, {
        status: "failed",
        attempts,
        last_attempt_at: new Date(nowMs).toISOString(),
        next_retry_at: attempts < this.maxCloseoutAttempts
          ? new Date(nowMs + this.retryDelayMs).toISOString()
          : null,
        last_error: error?.message || String(error),
      });
      throw error;
    } finally {
      try {
        releaseWriterLease(this.config.closeoutAutomationLeaseFile, claim.lease_id);
      } catch {}
    }
  }

  writeCloseoutState(date, entry) {
    if (!this.config.closeoutRetryStateFile) return;
    const state = readState(this.config.closeoutRetryStateFile);
    state.closeout = state.closeout && typeof state.closeout === "object" ? state.closeout : {};
    state.closeout[date] = { ...(state.closeout[date] || {}), ...entry };
    writeState(this.config.closeoutRetryStateFile, state);
  }

  async runLivenessChecks(now) {
    if (!this.config.closeoutLivenessStateFile || !this.config.closeoutLivenessLeaseFile) return [];
    let lease;
    try {
      lease = acquireLivenessLease(this.config.closeoutLivenessLeaseFile, this.config);
    } catch (error) {
      if (/already held/.test(error?.message || "")) return [{ status: "skipped", reason: "lease_unavailable" }];
      throw error;
    }
    try {
      const state = readState(this.config.closeoutLivenessStateFile);
      const findings = this.buildFindings(now);
      const results = [];
      for (const finding of findings) {
        const previous = state.checks[finding.key] || null;
        const current = normalizeState(previous, finding, new Date(now).toISOString());
        let queued = false;
        if (finding.status !== "healthy" && shouldAlertFailure(previous, current, finding, now, {
          startupGraceMinutes: this.config.livenessStartupGraceMinutes,
          cooldownHours: this.config.livenessAlertCooldownHours,
        })) {
          if (this.canAlert()) {
            const message = buildLivenessMessage({ finding, accountId: this.accountId, senderId: this.senderId, workspaceRoot: this.workspaceRoot });
            try {
              this.queueStore.enqueue(message);
              current.last_alert_attempted_at = new Date(now).toISOString();
              current.last_delivery_status = "queued";
              current.last_delivery_error = null;
              current.alert_pending = true;
              queued = true;
            } catch (error) {
              current.last_delivery_status = "failed";
              current.last_delivery_error = error?.message || String(error);
            }
          }
        } else if (finding.status === "healthy" && previous?.status === "failing" && this.config.livenessRecoveryEnabled && !current.recovery_alerted_at && !current.recovery_attempted_at) {
          if (this.canAlert()) {
            const message = buildLivenessMessage({ finding, accountId: this.accountId, senderId: this.senderId, workspaceRoot: this.workspaceRoot, alertKind: "recovery" });
            try {
              this.queueStore.enqueue(message);
              current.recovery_attempted_at = new Date(now).toISOString();
              current.last_delivery_status = "queued";
              current.alert_pending = true;
              queued = true;
            } catch (error) {
              current.last_delivery_status = "failed";
              current.last_delivery_error = error?.message || String(error);
            }
          }
        }
        state.checks[finding.key] = current;
        results.push({ finding, state: current, queued });
      }
      writeState(this.config.closeoutLivenessStateFile, state);
      return results;
    } finally {
      try { releaseWriterLease(this.config.closeoutLivenessLeaseFile, lease.lease_id); } catch {}
    }
  }

  buildFindings(now) {
    const jobsDir = this.config.continuityDir ? path.join(this.config.continuityDir, ".jobs") : "";
    const closeoutLedgerFiles = jobsDir ? listCloseoutLedgers(jobsDir) : [];
    const findings = [];
    if (this.config.canonLivenessEnabled) {
      findings.push(inspectJsonl({
        key: "canon",
        label: "canon episodes",
        filePath: this.config.canonEpisodesFile || (this.config.continuityDir ? path.join(this.config.continuityDir, "episodes.jsonl") : ""),
        now,
        thresholdHours: this.config.canonLivenessThresholdHours,
        authoritativeSuccessFiles: closeoutLedgerFiles,
      }));
    }
    if (this.config.recallLivenessEnabled) {
      findings.push(inspectJsonl({
        key: "recall",
        label: "recall log",
        filePath: this.config.recallLogFile,
        now,
        thresholdHours: this.config.recallLivenessThresholdHours,
      }));
    }
    return findings;
  }

  canAlert() {
    return this.config.channel === "telegram"
      && Boolean(this.queueStore)
      && Boolean(this.accountId && this.senderId && this.workspaceRoot);
  }

  markAlertDelivered(message) {
    return this.updateAlertDelivery(message, { status: "sent", error: null });
  }

  markAlertDeliveryFailed(message, error) {
    return this.updateAlertDelivery(message, { status: "failed", error: error?.message || String(error || "delivery_failed") });
  }

  updateAlertDelivery(message, result) {
    if (!message?.alertKey || !this.config.closeoutLivenessStateFile || !this.config.closeoutLivenessLeaseFile) return false;
    let lease;
    try { lease = acquireLivenessLease(this.config.closeoutLivenessLeaseFile, this.config); } catch { return false; }
    try {
      const state = readState(this.config.closeoutLivenessStateFile);
      const current = state.checks[message.alertKey];
      if (!current) return false;
      current.alert_pending = false;
      current.last_delivery_status = result.status;
      current.last_delivery_error = result.error || null;
      if (result.status === "sent") {
        if (message.alertKind === "recovery") current.recovery_alerted_at = new Date().toISOString();
        else current.last_alerted_at = new Date().toISOString();
      }
      writeState(this.config.closeoutLivenessStateFile, state);
      return true;
    } finally {
      try { releaseWriterLease(this.config.closeoutLivenessLeaseFile, lease.lease_id); } catch {}
    }
  }
}

function listCloseoutLedgers(jobsDir) {
  try {
    return fs.readdirSync(jobsDir).filter((name) => /^closeout-\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => path.join(jobsDir, name));
  } catch { return []; }
}

module.exports = {
  CloseoutLivenessAutomation,
  DEFAULT_TIMEZONE,
  MAX_ALERT_DELIVERY_ATTEMPTS,
  businessDateKey,
  buildLivenessMessage,
  inspectJsonl,
  isScheduleDue,
  nextScheduleAt,
  readState,
  shouldAlertFailure,
  zonedParts,
};
