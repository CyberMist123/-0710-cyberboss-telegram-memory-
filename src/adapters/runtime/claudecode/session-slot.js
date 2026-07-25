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
// Long-term continuity is shared through memory/reentry injection, never by
// pointing two lanes at one Claude transcript.

const SLOT_VERSION = 2;
const SLOT_STORE_VERSION = 2;
const MAX_SLOTS = 512;

function encodePart(value) {
  if (value === null || value === undefined) {
    return "~";
  }
  const text = String(value);
  return `${text.length}:${text}`;
}

/**
 * Opaque, stable slot key.
 *
 * Hashed rather than concatenated so the on-disk state file never contains a
 * chat id, topic id or filesystem path in plaintext.
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
 * True when the slot represents the pre-v2 default lane with no profile
 * applied. Only such a slot may seed itself from the legacy SessionStore, so
 * an upgrade keeps resuming the existing Claude session instead of opening a
 * fresh transcript.
 */
function isLegacyEquivalentSlot({ profileFingerprint = "legacy", laneKind = "" } = {}) {
  return (profileFingerprint || "legacy") === "legacy"
    && (laneKind === "legacy" || laneKind === "telegram" || laneKind === "tg");
}

/**
 * Persistent map of session slot -> Claude session id.
 *
 * Deliberately a separate file from sessions.json: the legacy store is keyed
 * by continuity binding and is still used for binding-level state (workspace
 * roots, runtime params, approval prompts). Mixing lane-scoped session ids into
 * it would re-create exactly the collision this change removes.
 */
class SessionSlotStore {
  constructor({ filePath = "", fs = fsApi, maxSlots = MAX_SLOTS } = {}) {
    this.filePath = typeof filePath === "string" ? filePath.trim() : "";
    this.fs = fs;
    this.maxSlots = maxSlots;
    this.state = this.load();
  }

  load() {
    if (!this.filePath) {
      return { version: SLOT_STORE_VERSION, slots: Object.create(null) };
    }
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, "utf8"));
      const slots = Object.create(null);
      const rawSlots = parsed && typeof parsed === "object" ? parsed.slots : null;
      if (rawSlots && typeof rawSlots === "object") {
        for (const key of Object.keys(rawSlots)) {
          if (key === "__proto__" || key === "prototype" || key === "constructor") {
            continue;
          }
          const entry = rawSlots[key];
          if (!entry || typeof entry !== "object") {
            continue;
          }
          slots[key] = {
            threadId: normalizeSessionId(entry.threadId),
            contextFingerprint: normalizeText(entry.contextFingerprint),
            updatedAt: normalizeText(entry.updatedAt),
          };
        }
      }
      return { version: SLOT_STORE_VERSION, slots };
    } catch {
      return { version: SLOT_STORE_VERSION, slots: Object.create(null) };
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    // Serialize through an explicit copy: the in-memory map is null-prototype
    // and JSON.stringify of it is fine, but this also drops empty entries.
    const slots = {};
    for (const key of Object.keys(this.state.slots)) {
      const entry = this.state.slots[key];
      if (!entry?.threadId) {
        continue;
      }
      slots[key] = { ...entry };
    }
    writeJsonAtomic(this.filePath, { version: SLOT_STORE_VERSION, slots });
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

  setThreadId(slotKey, threadId) {
    const key = normalizeText(slotKey);
    const normalizedThreadId = normalizeSessionId(threadId);
    if (!key || !normalizedThreadId) {
      return;
    }
    const current = this.state.slots[key] || {};
    this.state.slots[key] = {
      threadId: normalizedThreadId,
      contextFingerprint: current.contextFingerprint || "",
      updatedAt: new Date().toISOString(),
    };
    this.evictIfNeeded();
    this.save();
  }

  setContextFingerprint(slotKey, fingerprint) {
    const key = normalizeText(slotKey);
    if (!key) {
      return;
    }
    const current = this.state.slots[key];
    if (!current) {
      return;
    }
    current.contextFingerprint = normalizeText(fingerprint);
    current.updatedAt = new Date().toISOString();
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

module.exports = {
  MAX_SLOTS,
  SLOT_STORE_VERSION,
  SLOT_VERSION,
  SessionSlotStore,
  buildSessionSlotKey,
  isLegacyEquivalentSlot,
};
