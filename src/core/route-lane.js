"use strict";

// Route lane identity for inbound/outbound channel traffic.
//
// Three identities are deliberately kept apart in this codebase:
//
//   1. Continuity binding  = workspaceId + accountId + senderId
//      Long-term *user memory* identity. Stable across chats, topics and
//      profiles. Never contains chatId / messageThreadId / profileId.
//
//   2. Route lane          = accountId + chatId + nullable messageThreadId
//      Per-conversation *delivery and turn-serialization* identity. Two lanes
//      never share a turn gate, pending buffer, debounce timer, reply target,
//      typing indicator or outbound thread id.
//
//   3. Session slot        = workspace + route lane + effective profile
//      Claude native transcript identity. Defined in
//      adapters/runtime/claudecode/session-slot.js, built on top of the lane
//      key produced here.
//
// This module is dependency-free and must stay that way: it is loaded by the
// channel adapter, the core app and the runtime adapter alike.

const LANE_VERSION = "v2";
const LANE_KIND_TELEGRAM = "tg";
const LANE_KIND_SYSTEM = "sys";
const LANE_KIND_LEGACY = "legacy";

// System lanes never inherit an interactive Telegram route. Each background
// producer gets its own explicit lane so a closeout turn can never land in a
// user's topic transcript, and a user turn can never be resumed by a
// background job.
const SYSTEM_LANE_CHANNELS = Object.freeze([
  "closeout",
  "liveness",
  "system-message",
  "background-author",
  "automation-sender",
]);

const MAX_ID_LENGTH = 32;

// Strict decimal integer, optional leading minus, no leading zeros, no plus,
// no exponent, no fraction, no whitespace.
const STRICT_DECIMAL_INT = /^-?(?:0|[1-9][0-9]*)$/;
const STRICT_POSITIVE_INT = /^[1-9][0-9]*$/;

class RouteLaneError extends Error {
  constructor(message, code = "route_lane_invalid") {
    super(message);
    this.name = "RouteLaneError";
    this.code = code;
  }
}

/**
 * Canonical form of a Telegram numeric id.
 *
 * Accepts only a finite safe integer Number or a strict decimal integer
 * String. Rejects floats, exponent notation, `+1`, `01`, `-0`, bigints,
 * booleans, whitespace padding, empty strings and arbitrary text ids.
 *
 * @returns {string} canonical decimal representation
 */
function canonicalTelegramId(value, field = "telegramId") {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RouteLaneError(
        `${field} must be a finite safe integer`,
        "non_canonical_id",
      );
    }
    // Object.is guards against -0 collapsing to "0" silently.
    if (Object.is(value, -0)) {
      throw new RouteLaneError(`${field} must not be negative zero`, "non_canonical_id");
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new RouteLaneError(
      `${field} must be a safe integer or a strict decimal integer string`,
      "non_canonical_id",
    );
  }
  if (!value.length || value.length > MAX_ID_LENGTH) {
    throw new RouteLaneError(`${field} has an unsupported length`, "non_canonical_id");
  }
  if (!STRICT_DECIMAL_INT.test(value)) {
    throw new RouteLaneError(
      `${field} must be a strict decimal integer string`,
      "non_canonical_id",
    );
  }
  if (value === "-0") {
    throw new RouteLaneError(`${field} must not be negative zero`, "non_canonical_id");
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new RouteLaneError(`${field} exceeds the safe integer range`, "non_canonical_id");
  }
  return value;
}

/**
 * Canonical Telegram chat id. May be negative (supergroups/channels).
 */
function canonicalTelegramChatId(value) {
  return canonicalTelegramId(value, "chatId");
}

/**
 * Canonical Telegram message thread (topic) id.
 *
 * `null` is the explicit "no topic" lane. Everything else must be a strictly
 * positive integer. An empty string, `undefined`, `0`, a negative number and
 * arbitrary text are all rejected rather than silently folded into the default
 * lane -- a missing value and the default lane must never match ambiguously.
 *
 * @returns {string|null}
 */
function canonicalTelegramMessageThreadId(value) {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RouteLaneError(
        "messageThreadId must be a positive safe integer or null",
        "non_canonical_id",
      );
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new RouteLaneError(
      "messageThreadId must be a positive integer or null",
      "non_canonical_id",
    );
  }
  if (!value.length || value.length > MAX_ID_LENGTH || !STRICT_POSITIVE_INT.test(value)) {
    throw new RouteLaneError(
      "messageThreadId must be a strict positive decimal integer string or null",
      "non_canonical_id",
    );
  }
  if (!Number.isSafeInteger(Number(value))) {
    throw new RouteLaneError("messageThreadId exceeds the safe integer range", "non_canonical_id");
  }
  return value;
}

/**
 * Inbound normalization for a Telegram update.
 *
 * A missing key (`undefined`) means "the platform did not send a topic", which
 * is the default lane. `null` is the same explicit default lane. An empty
 * string is *not* an alias for the default lane and is rejected.
 */
function normalizeInboundMessageThreadId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return canonicalTelegramMessageThreadId(value);
}

function canonicalAccountId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new RouteLaneError("accountId is required", "missing_account");
  }
  if (text.length > 128) {
    throw new RouteLaneError("accountId is too long", "route_lane_invalid");
  }
  return text;
}

// Length-prefixed encoding. Guarantees the key of ("a","bc") can never collide
// with ("ab","c") no matter what separator characters appear inside an id.
function encodeLanePart(value) {
  if (value === null) {
    return "~";
  }
  return `${value.length}:${value}`;
}

function buildLaneKey(kind, parts) {
  return `${LANE_VERSION}|${kind}|${parts.map(encodeLanePart).join("|")}`;
}

/**
 * Build the Telegram route lane for one interaction.
 *
 * @param {{accountId: string, chatId: string|number, messageThreadId?: string|number|null}} input
 */
function buildTelegramRouteLane({ accountId, chatId, messageThreadId = null } = {}) {
  const normalizedAccountId = canonicalAccountId(accountId);
  const normalizedChatId = canonicalTelegramChatId(chatId);
  const normalizedThreadId = canonicalTelegramMessageThreadId(messageThreadId);
  return Object.freeze({
    kind: LANE_KIND_TELEGRAM,
    provider: "telegram",
    accountId: normalizedAccountId,
    chatId: normalizedChatId,
    messageThreadId: normalizedThreadId,
    laneKey: buildLaneKey(LANE_KIND_TELEGRAM, [
      normalizedAccountId,
      normalizedChatId,
      normalizedThreadId,
    ]),
  });
}

/**
 * Explicit lane for a system/background producer. These never inherit a
 * Telegram route profile or session.
 */
function buildSystemRouteLane(channel) {
  const normalized = typeof channel === "string" ? channel.trim() : "";
  if (!normalized) {
    throw new RouteLaneError("system lane channel is required", "route_lane_invalid");
  }
  return Object.freeze({
    kind: LANE_KIND_SYSTEM,
    provider: "system",
    channel: normalized,
    accountId: null,
    chatId: null,
    messageThreadId: null,
    laneKey: buildLaneKey(LANE_KIND_SYSTEM, [normalized]),
  });
}

/**
 * Lane for a non-Telegram channel. Keeps the pre-v2 grouping (one lane per
 * continuity binding) so WeChat behaviour is byte-for-byte unchanged, while
 * still flowing through the lane-shaped plumbing.
 */
function buildLegacyRouteLane({ provider = "", bindingKey = "" } = {}) {
  const normalizedProvider = typeof provider === "string" ? provider.trim() : "";
  const normalizedBindingKey = typeof bindingKey === "string" ? bindingKey.trim() : "";
  if (!normalizedBindingKey) {
    throw new RouteLaneError("legacy lane requires a bindingKey", "route_lane_invalid");
  }
  return Object.freeze({
    kind: LANE_KIND_LEGACY,
    provider: normalizedProvider || "legacy",
    accountId: null,
    chatId: null,
    messageThreadId: null,
    laneKey: buildLaneKey(LANE_KIND_LEGACY, [normalizedProvider || "legacy", normalizedBindingKey]),
  });
}

/**
 * Resolve the lane for a normalized/prepared inbound message.
 *
 * Returns `null` when the message carries no usable route (the caller then
 * falls back to the pre-v2 binding scope). Throws only for a Telegram message
 * whose ids are present but non-canonical -- that is a fail-closed condition,
 * not something to route on a guess.
 */
function resolveInboundRouteLane(message, { bindingKey = "" } = {}) {
  if (!message || typeof message !== "object") {
    return null;
  }
  if (message.provider === "telegram") {
    const accountId = message.accountId ?? message.telegram?.accountId;
    const chatId = message.chatId ?? message.telegram?.chatId;
    if (accountId === undefined || accountId === null || chatId === undefined || chatId === null || chatId === "") {
      return null;
    }
    const rawThreadId = Object.hasOwn(message, "messageThreadId")
      ? message.messageThreadId
      : message.telegram?.messageThreadId;
    return buildTelegramRouteLane({
      accountId,
      chatId,
      messageThreadId: normalizeInboundMessageThreadId(rawThreadId),
    });
  }
  if (!bindingKey) {
    return null;
  }
  return buildLegacyRouteLane({ provider: message.provider, bindingKey });
}

/**
 * Scope key used by the turn gate, pending inbound buffer, image debounce
 * buffer and reply-target registry.
 *
 * The lane key is length-prefixed, so appending the workspace root cannot
 * create a collision with a different (lane, workspaceRoot) pair.
 */
function buildLaneScopeKey(lane, workspaceRoot) {
  const laneKey = typeof lane === "string" ? lane : lane?.laneKey;
  const normalizedLaneKey = typeof laneKey === "string" ? laneKey.trim() : "";
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!normalizedLaneKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedLaneKey}::${normalizedWorkspaceRoot}`;
}

/**
 * Coarse, non-identifying description of a lane for telemetry. Contains no
 * account id, chat id or topic id -- only the *shape*.
 */
function describeLaneShape(lane) {
  if (!lane || typeof lane !== "object") {
    return Object.freeze({ kind: "none", topic: "none" });
  }
  return Object.freeze({
    kind: lane.kind || "unknown",
    topic: lane.messageThreadId === null || lane.messageThreadId === undefined ? "default" : "topic",
  });
}

/**
 * Rebuild a lane object from a persisted route descriptor.
 *
 * Used by startup restore, which iterates saved session slots rather than
 * bindings. Returns null when the descriptor is not a lane this build knows how
 * to rebuild, so an unrecognised record is skipped instead of guessed at.
 */
function rebuildLaneFromDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    return null;
  }
  try {
    if (descriptor.laneKind === LANE_KIND_TELEGRAM) {
      const lane = buildTelegramRouteLane({
        accountId: descriptor.accountId,
        chatId: descriptor.chatId,
        messageThreadId: descriptor.messageThreadId ?? null,
      });
      // A descriptor whose fields no longer produce its recorded key belongs to
      // a different lane encoding; refuse rather than restore the wrong lane.
      return lane.laneKey === descriptor.laneKey ? lane : null;
    }
    if (descriptor.laneKind === LANE_KIND_SYSTEM) {
      return null;
    }
    if (descriptor.laneKind === LANE_KIND_LEGACY) {
      const lane = buildLegacyRouteLane({
        provider: descriptor.provider,
        bindingKey: descriptor.bindingKey,
      });
      return lane.laneKey === descriptor.laneKey ? lane : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isSameLane(left, right) {
  const leftKey = typeof left === "string" ? left : left?.laneKey;
  const rightKey = typeof right === "string" ? right : right?.laneKey;
  return Boolean(leftKey) && leftKey === rightKey;
}

module.exports = {
  LANE_KIND_LEGACY,
  LANE_KIND_SYSTEM,
  LANE_KIND_TELEGRAM,
  LANE_VERSION,
  RouteLaneError,
  SYSTEM_LANE_CHANNELS,
  buildLaneScopeKey,
  buildLegacyRouteLane,
  buildSystemRouteLane,
  buildTelegramRouteLane,
  canonicalTelegramChatId,
  canonicalTelegramId,
  canonicalTelegramMessageThreadId,
  describeLaneShape,
  isSameLane,
  normalizeInboundMessageThreadId,
  rebuildLaneFromDescriptor,
  resolveInboundRouteLane,
};
