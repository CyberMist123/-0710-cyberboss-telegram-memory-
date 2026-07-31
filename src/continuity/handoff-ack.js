"use strict";

const { appendJsonlUnique, readJsonl } = require("./continuity-store");
const { reviewArtifactPaths, SUBJECT_CONTEXT_INJECTOR_WRITER } = require("./review-artifacts");
const { createHandoffAckId, HANDOFF_DISPOSITIONS } = require("./handoff-context");
const {
  handoffWriterLeaseArchiveDir,
  resolveHandoffWriterLeaseFile,
} = require("./handoff-writer-lease");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");

class HandoffAckLedger {
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
      || resolveHandoffWriterLeaseFile({ continuityDir: this.continuityDir, kind: "ack" });
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
  }

  record({ ack, expectedDelivery, subjectTurnId } = {}) {
    if (!this.enabled) return { status: "disabled" };
    this.assertAvailable();
    const normalized = validateAck(ack, expectedDelivery);
    const turnId = requireText(subjectTurnId, "subject_turn_id");
    const event = {
      ack_id: normalized.ack_id,
      delivery_id: normalized.delivery_id,
      handoff_id: normalized.handoff_id,
      acknowledged_at: this.now().toISOString(),
      subject_turn_id: turnId,
      disposition: normalized.disposition,
    };
    const lease = acquireHandoffLease({
      filePath: this.leaseFile,
      writer: SUBJECT_CONTEXT_INJECTOR_WRITER,
      details: this.leaseDetails,
      options: this.leaseOptions,
    });
    try {
      const existing = readJsonl(this.paths.handoffAckEvents)
        .find((item) => item?.ack_id === event.ack_id);
      if (existing) {
        assertSameAckEffect(existing, event);
        return { status: "replayed", event: existing };
      }
      const added = appendJsonlUnique(this.paths.handoffAckEvents, [event], "ack_id");
      if (added.length !== 1) {
        throw handoffAckFailure("handoff_ack_write_unverified", "ack event was not appended");
      }
      return { status: "acknowledged", event };
    } finally {
      releaseWriterLease(this.leaseFile, lease.lease_id);
    }
  }

  assertAvailable() {
    if (!this.continuityDir || !this.paths || !this.leaseFile) {
      throw handoffAckFailure("handoff_ack_unavailable", "continuityDir is required for handoff ack");
    }
  }
}

function validateAck(ack = {}, expectedDelivery = {}) {
  const deliveryId = requireText(ack.delivery_id, "delivery_id");
  const handoffId = requireText(ack.handoff_id, "handoff_id");
  const ackId = requireText(ack.ack_id, "ack_id");
  const disposition = requireText(ack.disposition, "disposition");
  if (!HANDOFF_DISPOSITIONS.includes(disposition)) {
    throw handoffAckFailure("handoff_ack_invalid", `unsupported disposition: ${disposition}`);
  }
  if (ackId !== createHandoffAckId(deliveryId)) {
    throw handoffAckFailure("handoff_ack_invalid", "ack_id does not match delivery_id");
  }
  if (deliveryId !== expectedDelivery?.delivery_id || handoffId !== expectedDelivery?.handoff_id) {
    throw handoffAckFailure("handoff_ack_route_mismatch", "ack does not belong to this delivered handoff");
  }
  return { ack_id: ackId, delivery_id: deliveryId, handoff_id: handoffId, disposition };
}

function assertSameAckEffect(existing, incoming) {
  for (const key of ["delivery_id", "handoff_id", "disposition"]) {
    if (existing?.[key] !== incoming?.[key]) {
      throw handoffAckFailure("handoff_ack_id_collision", `ack_id exists with different ${key}`);
    }
  }
}

function acquireHandoffLease({ filePath, writer, details, options }) {
  try {
    return acquireWriterLease(filePath, { writer, ...details }, options);
  } catch (error) {
    throw handoffAckFailure(
      "handoff_ack_writer_lease_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireText(value, label) {
  const normalized = normalizeText(value);
  if (!normalized) throw handoffAckFailure("handoff_ack_invalid", `${label} is required`);
  return normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function handoffAckFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { HandoffAckLedger, validateAck };
