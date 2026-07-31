"use strict";

const { appendJsonlUnique, readJsonl, sha256 } = require("./continuity-store");
const {
  HANDOFF_DISPATCHER_WRITER,
  HANDOFF_ENVELOPE_SCHEMA_VERSION,
  readHandoffEnvelopes,
  reviewArtifactPaths,
} = require("./review-artifacts");
const {
  SUBJECT_ROUTE_MATCH_EXACT,
  SUBJECT_ROUTE_MATCH_WINDOW_GONE,
  matchSubjectRouteWindow,
} = require("./subject-route");
const {
  handoffWriterLeaseArchiveDir,
  resolveHandoffWriterLeaseFile,
} = require("./handoff-writer-lease");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");

const MAX_DELIVERY_ATTEMPTS = 2;
const DELIVERY_RESULTS = Object.freeze([
  "delivered",
  "retryable_failed",
  "terminal_failed",
  "window_gone",
]);
const DELIVERY_TRIGGERS = Object.freeze(["synchronous", "next_subject_turn"]);

class HandoffDispatcher {
  constructor({
    continuityDir = "",
    enabled = false,
    now = () => new Date(),
    leaseFile = "",
    leaseOptions = {},
    leaseDetails = {},
  } = {}) {
    this.continuityDir = normalizeText(continuityDir);
    this.enabled = enabled === true;
    this.now = now;
    this.paths = this.continuityDir ? reviewArtifactPaths(this.continuityDir) : null;
    this.leaseFile = normalizeText(leaseFile)
      || resolveHandoffWriterLeaseFile({ continuityDir: this.continuityDir, kind: "delivery" });
    this.leaseOptions = {
      recoverStale: true,
      staleArchiveDir: handoffWriterLeaseArchiveDir(this.continuityDir),
      ...leaseOptions,
    };
    this.leaseDetails = {
      model: "subject-runtime",
      phase: "g2-5",
      branch: "runtime",
      worktree: this.continuityDir || "runtime",
      base_sha: "0".repeat(40),
      ...leaseDetails,
    };
    this.activeTokens = new WeakSet();
  }

  /**
   * Select at most one handoff for this exact subject turn while holding the
   * delivery writer lease. Disabled mode returns before reading any file or
   * creating a directory.
   */
  beginSubjectTurn({ currentRoute, trigger = "next_subject_turn" } = {}) {
    if (!this.enabled) return { status: "disabled" };
    this.assertAvailable();
    if (!DELIVERY_TRIGGERS.includes(trigger)) {
      throw handoffDeliveryFailure("handoff_trigger_invalid", `unsupported trigger: ${trigger}`);
    }
    const lease = acquireHandoffLease({
      filePath: this.leaseFile,
      details: this.leaseDetails,
      options: this.leaseOptions,
    });
    try {
      const deliveryEvents = readJsonl(this.paths.handoffDeliveryEvents);
      const eventIndex = indexDeliveryEvents(deliveryEvents);
      const envelopes = readHandoffEnvelopes(this.paths.handoffEnvelopes)
        .slice()
        .sort(compareEnvelopeReads);

      for (const classified of envelopes) {
        const envelope = classified?.record || {};
        const handoffId = normalizeText(envelope.handoff_id);
        if (!handoffId || isHandoffFinal(eventIndex.get(handoffId))) continue;

        if (!classified.dispatch_eligible) {
          if (!classified.legacy
            && classified.schema_version === HANDOFF_ENVELOPE_SCHEMA_VERSION) {
            appendTerminalInvalidEnvelope({
              paths: this.paths,
              eventIndex,
              envelope,
              now: this.now,
            });
          }
          continue;
        }

        const match = matchSubjectRouteWindow(envelope.subject_route, currentRoute);
        if (match.status === SUBJECT_ROUTE_MATCH_WINDOW_GONE) {
          const attempt = nextAttempt(eventIndex.get(handoffId));
          appendDeliveryEvent(this.paths.handoffDeliveryEvents, {
            delivery_id: createDeliveryId(handoffId, attempt),
            handoff_id: handoffId,
            attempt,
            trigger,
            target_route_fingerprint: envelope.subject_route.route_fingerprint,
            started_at: this.now().toISOString(),
            delivered_at: null,
            result: "window_gone",
            reason: "window_gone",
          });
          eventIndex.set(handoffId, [
            ...(eventIndex.get(handoffId) || []),
            { result: "window_gone", attempt },
          ]);
          continue;
        }
        if (match.status !== SUBJECT_ROUTE_MATCH_EXACT) continue;

        const attempt = nextAttempt(eventIndex.get(handoffId));
        if (attempt > MAX_DELIVERY_ATTEMPTS) continue;
        const token = {
          envelope,
          delivery_id: createDeliveryId(handoffId, attempt),
          handoff_id: handoffId,
          attempt,
          trigger,
          target_route_fingerprint: envelope.subject_route.route_fingerprint,
          started_at: this.now().toISOString(),
          route_match: "EXACT",
          lease,
          closed: false,
        };
        this.activeTokens.add(token);
        return { status: "ready", token, envelope };
      }

      releaseWriterLease(this.leaseFile, lease.lease_id);
      return { status: "none" };
    } catch (error) {
      try { releaseWriterLease(this.leaseFile, lease.lease_id); } catch {}
      throw error;
    }
  }

  markDelivered(token) {
    return this.finish(token, { result: "delivered", reason: "" });
  }

  markFailed(token, { reason = "delivery_failed", retryable = true } = {}) {
    const result = retryable === true && token?.attempt < MAX_DELIVERY_ATTEMPTS
      ? "retryable_failed"
      : "terminal_failed";
    return this.finish(token, { result, reason: normalizeText(reason) || "delivery_failed" });
  }

  finish(token, { result, reason }) {
    this.assertActiveToken(token);
    if (!DELIVERY_RESULTS.includes(result)) {
      throw handoffDeliveryFailure("handoff_result_invalid", `unsupported result: ${result}`);
    }
    const event = {
      delivery_id: token.delivery_id,
      handoff_id: token.handoff_id,
      attempt: token.attempt,
      trigger: token.trigger,
      target_route_fingerprint: token.target_route_fingerprint,
      started_at: token.started_at,
      delivered_at: result === "delivered" ? this.now().toISOString() : null,
      result,
      reason: normalizeText(reason),
    };
    try {
      appendDeliveryEvent(this.paths.handoffDeliveryEvents, event);
      return event;
    } finally {
      token.closed = true;
      releaseWriterLease(this.leaseFile, token.lease.lease_id);
    }
  }

  assertActiveToken(token) {
    if (!token || typeof token !== "object" || token.closed || !this.activeTokens.has(token)) {
      throw handoffDeliveryFailure("handoff_delivery_token_invalid", "delivery token is not active");
    }
  }

  assertAvailable() {
    if (!this.continuityDir || !this.paths || !this.leaseFile) {
      throw handoffDeliveryFailure(
        "handoff_dispatch_unavailable",
        "continuityDir is required for handoff dispatch",
      );
    }
  }
}

function createDeliveryId(handoffId, attempt) {
  const id = normalizeText(handoffId);
  const number = Number(attempt);
  if (!id || !Number.isInteger(number) || number < 1) {
    throw handoffDeliveryFailure("handoff_delivery_invalid", "handoff_id and positive attempt are required");
  }
  return `delivery-${sha256(`${id}\n${number}`).slice(0, 20)}`;
}

function appendDeliveryEvent(filePath, event) {
  const existing = readJsonl(filePath).find((item) => item?.delivery_id === event.delivery_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw handoffDeliveryFailure(
        "handoff_delivery_id_collision",
        `delivery_id exists with different immutable content: ${event.delivery_id}`,
      );
    }
    return existing;
  }
  const added = appendJsonlUnique(filePath, [event], "delivery_id");
  if (added.length !== 1) {
    throw handoffDeliveryFailure("handoff_delivery_write_unverified", "delivery event was not appended");
  }
  return event;
}

function appendTerminalInvalidEnvelope({ paths, eventIndex, envelope, now }) {
  const handoffId = normalizeText(envelope.handoff_id);
  if (!handoffId || isHandoffFinal(eventIndex.get(handoffId))) return;
  const attempt = nextAttempt(eventIndex.get(handoffId));
  const event = {
    delivery_id: createDeliveryId(handoffId, attempt),
    handoff_id: handoffId,
    attempt,
    trigger: "next_subject_turn",
    target_route_fingerprint: normalizeText(envelope?.subject_route?.route_fingerprint) || "invalid",
    started_at: now().toISOString(),
    delivered_at: null,
    result: "terminal_failed",
    reason: "invalid_subject_route",
  };
  appendDeliveryEvent(paths.handoffDeliveryEvents, event);
  eventIndex.set(handoffId, [...(eventIndex.get(handoffId) || []), event]);
}

function indexDeliveryEvents(events = []) {
  const byDeliveryId = new Map();
  const byHandoffId = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const deliveryId = normalizeText(event?.delivery_id);
    const handoffId = normalizeText(event?.handoff_id);
    if (!deliveryId || !handoffId) continue;
    const existing = byDeliveryId.get(deliveryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
      throw handoffDeliveryFailure(
        "handoff_delivery_id_collision",
        `conflicting delivery rows: ${deliveryId}`,
      );
    }
    if (existing) continue;
    byDeliveryId.set(deliveryId, event);
    if (!byHandoffId.has(handoffId)) byHandoffId.set(handoffId, []);
    byHandoffId.get(handoffId).push(event);
  }
  return byHandoffId;
}

function nextAttempt(events = []) {
  return (Array.isArray(events) ? events : []).reduce(
    (max, event) => Math.max(max, Number.isInteger(event?.attempt) ? event.attempt : 0),
    0,
  ) + 1;
}

function isHandoffFinal(events = []) {
  return (Array.isArray(events) ? events : []).some(
    (event) => ["delivered", "terminal_failed", "window_gone"].includes(event?.result),
  );
}

function summarizeHandoffDeliveries({ deliveryEvents = [], ackEvents = [] } = {}) {
  const rows = new Map();
  for (const event of uniqueEvents(deliveryEvents, "delivery_id")) {
    const handoffId = normalizeText(event?.handoff_id);
    if (!handoffId) continue;
    const row = ensureSummary(rows, handoffId);
    const result = normalizeText(event.result);
    if (Object.hasOwn(row, result) && typeof row[result] === "number") row[result] += 1;
    row.attempts = Math.max(row.attempts, Number(event.attempt) || 0);
    if (["retryable_failed", "terminal_failed", "window_gone"].includes(result)) {
      const at = normalizeText(event.delivered_at) || normalizeText(event.started_at);
      if (!row.latest_failure_at || at >= row.latest_failure_at) {
        row.latest_failure_at = at;
        row.latest_failure_reason = normalizeText(event.reason);
      }
    }
  }
  for (const ack of uniqueEvents(ackEvents, "ack_id")) {
    const handoffId = normalizeText(ack?.handoff_id);
    if (!handoffId) continue;
    ensureSummary(rows, handoffId).acked += 1;
  }
  return [...rows.values()]
    .map((row) => ({ ...row, terminal_state: terminalState(row) }))
    .sort((left, right) => left.handoff_id.localeCompare(right.handoff_id));
}

function readHandoffDeliverySummary({ deliveryEventsPath, ackEventsPath = "" } = {}) {
  return summarizeHandoffDeliveries({
    deliveryEvents: readJsonl(deliveryEventsPath),
    ackEvents: ackEventsPath ? readJsonl(ackEventsPath) : [],
  });
}

function ensureSummary(rows, handoffId) {
  if (!rows.has(handoffId)) {
    rows.set(handoffId, {
      handoff_id: handoffId,
      delivered: 0,
      acked: 0,
      retryable_failed: 0,
      terminal_failed: 0,
      window_gone: 0,
      attempts: 0,
      latest_failure_reason: "",
      latest_failure_at: "",
    });
  }
  return rows.get(handoffId);
}

function terminalState(row) {
  if (row.window_gone) return "window_gone";
  if (row.acked) return "acked";
  if (row.delivered) return "delivered";
  if (row.terminal_failed) return "terminal_failed";
  if (row.retryable_failed) return "retryable_failed";
  return "pending";
}

function uniqueEvents(events, key) {
  const unique = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const id = normalizeText(event?.[key]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(event);
  }
  return unique;
}

function compareEnvelopeReads(left, right) {
  const leftRecord = left?.record || {};
  const rightRecord = right?.record || {};
  return String(leftRecord.created_at || "").localeCompare(String(rightRecord.created_at || ""))
    || String(leftRecord.handoff_id || "").localeCompare(String(rightRecord.handoff_id || ""));
}

function acquireHandoffLease({ filePath, details, options }) {
  try {
    return acquireWriterLease(filePath, {
      writer: HANDOFF_DISPATCHER_WRITER,
      ...details,
    }, options);
  } catch (error) {
    throw handoffDeliveryFailure(
      "handoff_delivery_writer_lease_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function handoffDeliveryFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  DELIVERY_RESULTS,
  DELIVERY_TRIGGERS,
  HandoffDispatcher,
  MAX_DELIVERY_ATTEMPTS,
  createDeliveryId,
  indexDeliveryEvents,
  readHandoffDeliverySummary,
  summarizeHandoffDeliveries,
};
