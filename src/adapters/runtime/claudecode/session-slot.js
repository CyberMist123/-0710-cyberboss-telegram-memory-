"use strict";

const crypto = require("node:crypto");
const fsApi = require("node:fs");

const { writeJsonAtomic } = require("../../../orchestration/atomic-json");

// Claude native session identity.
//
// A Claude transcript is NOT keyed by the long-term continuity binding. It is
// keyed by a *session slot*:
//
//     workspace  +  route lane  +  effective profile fingerprint
//
// Safety semantics this buys:
//   * topic A with profile A uses session A; topic B with profile B uses
//     session B; going A -> B -> A restores session A.
//   * lane B can never be launched with `--resume <session A>`, because the
//     resume id is only ever read from B's own slot.
//   * the same profile in two different topics still gets two slots.
//   * the same topic and profile keeps resuming one slot.
//
// The slot store is the ONLY runtime authority for a resume id. `sessions.json`
// remains a continuity / reverse-index mirror, but it is never read as a resume
// source, command target, approval target, restore target or process selector.
// The single exception is a one-shot, explicitly marked migration of the
// private/default legacy lane, recorded here so it can never be applied twice.
//
// The record carries the route descriptor needed to restore a slot at startup.
// This file is local state written 0600 alongside `sessions.json`, which
// already holds accountId/senderId; the *telemetry* rules in
// core/route-telemetry.js are what forbid these values leaving the process.

const SLOT_VERSION = 2;
const SLOT_STORE_VERSION = 3;
const MAX_SLOTS = 512;
const MAX_MIGRATION_MARKERS = 512;

function encodePart(value) {
  if (value === null || value === undefined) {
    return "~";
  }
  const text = String(value);
  return `${text.length}:${text}`;
}

/**
 * Opaque, stable slot key. Hashed so the key itself encodes nothing readable.
 */
function buildSessionSlotKey({
  runtimeId = "claudecode",
  workspaceId = "",
  workspaceRoot = "",
  laneKey = "",
  profileFingerprint = "legacy",
} = {}) {
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const normalizedLaneKey = typeof laneKey === "string" ? laneKey.trim() : "";
  if (!normalizedWorkspaceRoot || !normalizedLaneKey) {
    return "";
  }
  const material = [
    `v${SLOT_VERSION}`,
    runtimeId,
    workspaceId,
    normalizedWorkspaceRoot,
    normalizedLaneKey,
    profileFingerprint || "legacy",
  ].map(encodePart).join("|");
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Key for the one-shot legacy migration. Scoped to (binding, workspace) rather
 * than to a slot, so the migration can only ever fire once for a given binding
 * and workspace no matter which lane asks first.
 */
function buildLegacyMigrationKey({ bindingKey = "", workspaceRoot = "" } = {}) {
  const normalizedBindingKey = typeof bindingKey === "string" ? bindingKey.trim() : "";
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return crypto
    .createHash("sha256")
    .update(["legacy-default-lane-v2", normalizedBindingKey, normalizedWorkspaceRoot].map(encodePart).join("|"), "utf8")
    .digest("hex");
}

/**
 * Is this route allowed to take part in the one-shot legacy migration?
 *
 * Only the *private/default* legacy lane qualifies:
 *   * no launch profile is applied (fingerprint `legacy`), and
 *   * either a non-Telegram legacy lane, or a Telegram lane with no topic whose
 *     chat id is the binding's own sender id (i.e. a private chat).
 *
 * A topic lane, a group lane and any profiled lane are never eligible, which is
 * what stops two unmapped topics from inheriting one transcript.
 */
function isLegacyMigrationEligible({ lane = null, profileFingerprint = "legacy", senderId = "" } = {}) {
  if ((profileFingerprint || "legacy") !== "legacy" || !lane) {
    return false;
  }
  if (lane.kind === "legacy") {
    return true;
  }
  if (lane.kind !== "tg") {
    return false;
  }
  const normalizedSenderId = typeof senderId === "string" ? senderId.trim() : "";
  return lane.messageThreadId === null
    && Boolean(normalizedSenderId)
    && lane.chatId === normalizedSenderId;
}

function normalizeRouteDescriptor(route) {
  if (!route || typeof route !== "object") {
    return null;
  }
  const out = {
    bindingKey: normalizeText(route.bindingKey),
    workspaceRoot: normalizeText(route.workspaceRoot),
    laneKey: normalizeText(route.laneKey),
    laneKind: normalizeText(route.laneKind),
    provider: normalizeText(route.provider),
    accountId: normalizeText(route.accountId),
    chatId: normalizeText(route.chatId),
    messageThreadId: route.messageThreadId === null || route.messageThreadId === undefined
      ? null
      : normalizeText(route.messageThreadId),
    profileId: normalizeText(route.profileId),
    profileFingerprint: normalizeText(route.profileFingerprint) || "legacy",
  };
  return out.laneKey && out.workspaceRoot ? out : null;
}

class SessionSlotStore {
  constructor({ filePath = "", fs = fsApi, maxSlots = MAX_SLOTS } = {}) {
    this.filePath = typeof filePath === "string" ? filePath.trim() : "";
    this.fs = fs;
    this.maxSlots = maxSlots;
    this.state = this.load();
  }

  load() {
    const empty = () => ({
      version: SLOT_STORE_VERSION,
      slots: Object.create(null),
      migrations: Object.create(null),
    });
    if (!this.filePath) {
      return empty();
    }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      const state = empty();
      copySafeEntries(parsed?.slots, (key, entry) => {
        if (!entry || typeof entry !== "object") {
          return;
        }
        const windowOverride = cloneJsonObject(entry.windowOverride);
        state.slots[key] = {
          threadId: normalizeSessionId(entry.threadId),
          contextFingerprint: normalizeText(entry.contextFingerprint),
          ...(cloneJsonObject(entry.contextInputs) ? { contextInputs: cloneJsonObject(entry.contextInputs) } : {}),
          ...(windowOverride ? { windowOverride } : {}),
          ...(cloneJsonObject(entry.route2Gate) ? { route2Gate: cloneJsonObject(entry.route2Gate) } : {}),
          updatedAt: normalizeText(entry.updatedAt),
          route: normalizeRouteDescriptor(entry.route),
        };
      });
      copySafeEntries(parsed?.migrations, (key, value) => {
        state.migrations[key] = normalizeText(value) || new Date(0).toISOString();
      });
      return state;
    } catch {
      return empty();
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    const slots = {};
    for (const key of Object.keys(this.state.slots)) {
      const entry = this.state.slots[key];
      if (!entry?.threadId && !entry?.windowOverride) {
        continue;
      }
      slots[key] = { ...entry };
    }
    const migrations = { ...this.state.migrations };
    writeJsonAtomic(this.filePath, { version: SLOT_STORE_VERSION, slots, migrations });
  }

  get(slotKey) {
    const key = normalizeText(slotKey);
    if (!key) {
      return null;
    }
    const entry = this.state.slots[key];
    return entry ? { ...entry } : null;
  }

  getThreadId(slotKey) {
    return this.get(slotKey)?.threadId || "";
  }

  getContextFingerprint(slotKey) {
    return this.get(slotKey)?.contextFingerprint || "";
  }

  // The fingerprint's raw inputs, kept beside the hash so a mismatch can name
  // exactly which input changed instead of reporting an opaque hash flip.
  getContextInputs(slotKey) {
    return cloneJsonObject(this.get(slotKey)?.contextInputs);
  }

  getWindowOverride(slotKey) {
    return cloneJsonObject(this.get(slotKey)?.windowOverride);
  }

  getRoute2Gate(slotKey) {
    return cloneJsonObject(this.get(slotKey)?.route2Gate);
  }

  getRoute(slotKey) {
    const route = this.get(slotKey)?.route;
    return route ? { ...route } : null;
  }

  setThreadId(slotKey, threadId, { route = null } = {}) {
    const key = normalizeText(slotKey);
    const normalizedThreadId = normalizeSessionId(threadId);
    if (!key || !normalizedThreadId) {
      return;
    }
    const current = this.state.slots[key] || {};
    this.state.slots[key] = {
      threadId: normalizedThreadId,
      contextFingerprint: current.contextFingerprint || "",
      ...(current.contextInputs ? { contextInputs: cloneJsonObject(current.contextInputs) } : {}),
      ...(current.windowOverride ? { windowOverride: cloneJsonObject(current.windowOverride) } : {}),
      ...(current.route2Gate ? { route2Gate: cloneJsonObject(current.route2Gate) } : {}),
      updatedAt: new Date().toISOString(),
      route: normalizeRouteDescriptor(route) || current.route || null,
    };
    this.evictIfNeeded();
    this.save();
  }

  setContextFingerprint(slotKey, fingerprint, inputs = null) {
    const key = normalizeText(slotKey);
    const current = key ? this.state.slots[key] : null;
    if (!current) {
      return;
    }
    current.contextFingerprint = normalizeText(fingerprint);
    const normalizedInputs = cloneJsonObject(inputs);
    if (normalizedInputs) {
      current.contextInputs = normalizedInputs;
    }
    current.updatedAt = new Date().toISOString();
    this.save();
  }

  setWindowOverride(slotKey, value, { route = null } = {}) {
    const key = normalizeText(slotKey);
    if (!key) return;
    const current = this.state.slots[key] || {};
    const windowOverride = cloneJsonObject(value);
    this.state.slots[key] = {
      threadId: current.threadId || "",
      contextFingerprint: current.contextFingerprint || "",
      ...(current.contextInputs ? { contextInputs: cloneJsonObject(current.contextInputs) } : {}),
      ...(windowOverride ? { windowOverride } : {}),
      ...(current.route2Gate ? { route2Gate: cloneJsonObject(current.route2Gate) } : {}),
      updatedAt: new Date().toISOString(),
      route: normalizeRouteDescriptor(route) || current.route || null,
    };
    this.evictIfNeeded();
    this.save();
  }

  setRoute2Gate(slotKey, value) {
    const key = normalizeText(slotKey);
    const route2Gate = cloneJsonObject(value);
    if (!key || !route2Gate) return;
    const current = this.state.slots[key] || {};
    this.state.slots[key] = { ...current, route2Gate, updatedAt: new Date().toISOString() };
    this.evictIfNeeded();
    this.save();
  }

  clearRoute2Gate(slotKey) {
    const key = normalizeText(slotKey);
    const current = key ? this.state.slots[key] : null;
    if (!current || !Object.hasOwn(current, "route2Gate")) return;
    const { route2Gate: _route2Gate, ...rest } = current;
    this.state.slots[key] = { ...rest, updatedAt: new Date().toISOString() };
    this.save();
  }

  clear(slotKey) {
    const key = normalizeText(slotKey);
    if (!key || !this.state.slots[key]) {
      return;
    }
    delete this.state.slots[key];
    this.save();
  }

  listSlotKeys() {
    return Object.keys(this.state.slots);
  }

  /**
   * Every slot that carries a usable route descriptor, most recent first.
   * This is what startup restore iterates -- never the binding list.
   */
  listRestorableSlots() {
    return Object.keys(this.state.slots)
      .map((slotKey) => ({ slotKey, ...this.state.slots[slotKey] }))
      .filter((entry) => entry.threadId && entry.route?.laneKey && entry.route?.workspaceRoot)
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }

  findSlotKeyForThreadId(threadId) {
    const normalized = normalizeSessionId(threadId);
    if (!normalized) {
      return "";
    }
    for (const key of Object.keys(this.state.slots)) {
      if (this.state.slots[key]?.threadId === normalized) {
        return key;
      }
    }
    return "";
  }

  hasMigration(migrationKey) {
    const key = normalizeText(migrationKey);
    return Boolean(key && Object.hasOwn(this.state.migrations, key));
  }

  markMigration(migrationKey) {
    const key = normalizeText(migrationKey);
    if (!key || Object.hasOwn(this.state.migrations, key)) {
      return false;
    }
    const keys = Object.keys(this.state.migrations);
    if (keys.length >= MAX_MIGRATION_MARKERS) {
      keys.sort((left, right) => String(this.state.migrations[left]).localeCompare(String(this.state.migrations[right])));
      delete this.state.migrations[keys[0]];
    }
    this.state.migrations[key] = new Date().toISOString();
    this.save();
    return true;
  }

  evictIfNeeded() {
    const keys = Object.keys(this.state.slots);
    if (keys.length <= this.maxSlots) {
      return;
    }
    keys
      .sort((left, right) => (
        String(this.state.slots[left]?.updatedAt || "").localeCompare(
          String(this.state.slots[right]?.updatedAt || ""),
        )
      ))
      .slice(0, keys.length - this.maxSlots)
      .forEach((key) => {
        delete this.state.slots[key];
      });
  }
}

function copySafeEntries(source, apply) {
  if (!source || typeof source !== "object") {
    return;
  }
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      continue;
    }
    apply(key, source[key]);
  }
}

function cloneJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

module.exports = {
  MAX_MIGRATION_MARKERS,
  MAX_SLOTS,
  SLOT_STORE_VERSION,
  SLOT_VERSION,
  SessionSlotStore,
  buildLegacyMigrationKey,
  buildSessionSlotKey,
  isLegacyMigrationEligible,
  normalizeRouteDescriptor,
};
