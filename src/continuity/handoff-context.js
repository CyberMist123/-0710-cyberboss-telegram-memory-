"use strict";

const crypto = require("node:crypto");

const HANDOFF_BLOCK_TAG = "subject_memory_handoff";
const HANDOFF_ACK_TAG = "subject_memory_handoff_ack";
const HANDOFF_DISPOSITIONS = Object.freeze([
  "rewrite_submitted",
  "abandoned",
  "read_only",
]);

/**
 * Deterministic D26-3 assembly only: copy immutable envelope fields into a
 * one-shot context block. This module deliberately has no runtime/model
 * dependency and performs no summarisation or semantic extraction.
 */
function formatSubjectMemoryHandoff({ envelope, deliveryId } = {}) {
  const handoffId = requireText(envelope?.handoff_id, "handoff_id");
  const id = requireText(deliveryId, "delivery_id");
  const candidateBody = requireString(envelope?.candidate_body, "candidate_body");
  const reasonCode = requireText(envelope?.reason?.code, "reason.code");
  const ackId = createHandoffAckId(id);
  return [
    `<${HANDOFF_BLOCK_TAG}>`,
    `handoff_id: ${handoffId}`,
    `delivery_id: ${id}`,
    `reason_code: ${reasonCode}`,
    "allowed_actions: rewrite | abandon | read_only",
    `ack_id: ${ackId}`,
    `ack_dispositions: ${HANDOFF_DISPOSITIONS.join(" | ")}`,
    "ack_format:",
    `<${HANDOFF_ACK_TAG}>{"ack_id":"${ackId}","delivery_id":"${id}","handoff_id":"${handoffId}","disposition":"<one ack_disposition>"}</${HANDOFF_ACK_TAG}>`,
    "candidate_body:",
    candidateBody,
    `</${HANDOFF_BLOCK_TAG}>`,
  ].join("\n");
}

function injectSubjectMemoryHandoff(runtimeText, handoffBlock) {
  const text = String(runtimeText ?? "");
  const block = requireText(handoffBlock, "handoff_block");
  return text ? `${block}\n\n${text}` : block;
}

function createHandoffAckId(deliveryId) {
  const id = requireText(deliveryId, "delivery_id");
  return `ack-${crypto.createHash("sha256").update(id, "utf8").digest("hex").slice(0, 20)}`;
}

/**
 * Acknowledgements are accepted only from the explicit tagged JSON object.
 * Free-form prose never becomes an ack and malformed data is ignored fail-open.
 */
function parseSubjectMemoryHandoffAck(value) {
  const text = String(value ?? "");
  const match = text.match(
    /<subject_memory_handoff_ack\b[^>]*>([\s\S]*?)<\/subject_memory_handoff_ack>/iu,
  );
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const expectedKeys = ["ack_id", "delivery_id", "disposition", "handoff_id"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return null;
  const ackId = normalizeText(parsed.ack_id);
  const deliveryId = normalizeText(parsed.delivery_id);
  const handoffId = normalizeText(parsed.handoff_id);
  const disposition = normalizeText(parsed.disposition);
  if (!ackId || !deliveryId || !handoffId || !HANDOFF_DISPOSITIONS.includes(disposition)) {
    return null;
  }
  if (ackId !== createHandoffAckId(deliveryId)) return null;
  return Object.freeze({
    ack_id: ackId,
    delivery_id: deliveryId,
    handoff_id: handoffId,
    disposition,
  });
}

function requireText(value, label) {
  const normalized = normalizeText(value);
  if (!normalized) throw handoffContextFailure("handoff_context_invalid", `${label} is required`);
  return normalized;
}

function requireString(value, label) {
  if (typeof value !== "string") {
    throw handoffContextFailure("handoff_context_invalid", `${label} must be a string`);
  }
  return value;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function handoffContextFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  HANDOFF_ACK_TAG,
  HANDOFF_BLOCK_TAG,
  HANDOFF_DISPOSITIONS,
  createHandoffAckId,
  formatSubjectMemoryHandoff,
  injectSubjectMemoryHandoff,
  parseSubjectMemoryHandoffAck,
};
