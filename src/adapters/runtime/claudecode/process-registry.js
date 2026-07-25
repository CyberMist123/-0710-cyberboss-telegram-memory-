"use strict";

const crypto = require("node:crypto");

// Claude Code process identity and mutual exclusion.
//
// A process client key is:
//
//     session slot  +  effective launch fingerprint  +  cwd/config identity
//
// Consequences:
//   * two lanes, or two profiles, never share a process, so neither can close
//     the other's running child;
//   * start / stop / resume for one key are serialized behind a per-key lock,
//     so a concurrent inbound burst cannot spawn two children for one slot or
//     close a child that another turn is mid-way through starting;
//   * a hot profile-mapping change produces a *new* key rather than mutating
//     the existing one, so lanes that are mid-turn keep their process until
//     they finish;
//   * approvals, pending turn ids and result delivery are looked up through
//     this registry, so they can only ever reach the process that owns them.

const DEFAULT_MAX_PROCESSES = 12;

function buildProcessKey({
  sessionSlotKey = "",
  launchFingerprint = "legacy",
  cwd = "",
  configIdentity = "",
} = {}) {
  const normalizedSlot = normalizeText(sessionSlotKey);
  if (!normalizedSlot) {
    return "";
  }
  const material = [
    "v2",
    normalizedSlot,
    normalizeText(launchFingerprint) || "legacy",
    normalizeText(cwd),
    normalizeText(configIdentity),
  ].map((part) => `${part.length}:${part}`).join("|");
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

class ProcessRegistry {
  constructor({ maxProcesses = DEFAULT_MAX_PROCESSES } = {}) {
    this.maxProcesses = Number.isSafeInteger(maxProcesses) && maxProcesses > 0
      ? maxProcesses
      : DEFAULT_MAX_PROCESSES;
    /** @type {Map<string, {processKey: string, client: any, sessionSlotKey: string, laneKey: string, launchFingerprint: string, cwd: string, lastUsedAt: number}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.locks = new Map();
    /** @type {Map<string, {processKey: string, sessionSlotKey: string, laneKey: string}>} */
    this.pendingApprovals = new Map();
    this.maxPendingApprovals = 100;
  }

  /**
   * Serialize work for one process key. Every start, stop and resume for a key
   * goes through here, so they can never interleave.
   *
   * Locks for different keys are independent: a slow relaunch in one lane does
   * not block a turn in another.
   */
  withLock(processKey, fn) {
    const key = normalizeText(processKey);
    if (!key) {
      return Promise.resolve().then(fn);
    }
    const previous = this.locks.get(key) || Promise.resolve();
    // Swallow the predecessor's rejection so one failed launch does not poison
    // every later attempt on the same key.
    const next = previous.then(() => fn(), () => fn());
    this.locks.set(key, next.then(() => {}, () => {}));
    const cleanup = () => {
      if (this.locks.get(key) === trackedTail) {
        this.locks.delete(key);
      }
    };
    const trackedTail = next.then(() => {}, () => {});
    trackedTail.then(cleanup, cleanup);
    return next;
  }

  get(processKey) {
    const entry = this.entries.get(normalizeText(processKey));
    if (entry) {
      entry.lastUsedAt = Date.now();
    }
    return entry || null;
  }

  getClient(processKey) {
    return this.get(processKey)?.client || null;
  }

  set(processKey, { client, sessionSlotKey = "", laneKey = "", launchFingerprint = "legacy", cwd = "" }) {
    const key = normalizeText(processKey);
    if (!key || !client) {
      return null;
    }
    const entry = {
      processKey: key,
      client,
      sessionSlotKey: normalizeText(sessionSlotKey),
      laneKey: normalizeText(laneKey),
      launchFingerprint: normalizeText(launchFingerprint) || "legacy",
      cwd: normalizeText(cwd),
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  delete(processKey) {
    const key = normalizeText(processKey);
    if (!key) {
      return null;
    }
    const entry = this.entries.get(key) || null;
    this.entries.delete(key);
    for (const [requestId, record] of this.pendingApprovals.entries()) {
      if (record.processKey === key) {
        this.pendingApprovals.delete(requestId);
      }
    }
    return entry;
  }

  has(processKey) {
    return this.entries.has(normalizeText(processKey));
  }

  size() {
    return this.entries.size;
  }

  listEntries() {
    return [...this.entries.values()];
  }

  /**
   * Only ever matches the process that actually owns the session id, so a
   * result or approval for lane A can never be delivered through lane B's
   * client.
   */
  findEntryByThreadId(threadId) {
    const normalized = normalizeSessionId(threadId);
    if (!normalized) {
      return null;
    }
    for (const entry of this.entries.values()) {
      const client = entry.client;
      if (!client) {
        continue;
      }
      if (normalizeSessionId(client.sessionId) === normalized
        || normalizeSessionId(client.resumeSessionId) === normalized
        || normalizeSessionId(client.activeThreadId) === normalized) {
        return entry;
      }
    }
    return null;
  }

  findEntryBySessionSlotKey(sessionSlotKey) {
    const normalized = normalizeText(sessionSlotKey);
    if (!normalized) {
      return null;
    }
    for (const entry of this.entries.values()) {
      if (entry.sessionSlotKey === normalized) {
        return entry;
      }
    }
    return null;
  }

  /**
   * All live entries for one session slot whose launch identity no longer
   * matches. Used when a profile mapping changes: the stale entry is retired
   * only when it is idle, never while it is running a turn.
   */
  listStaleEntriesForSlot(sessionSlotKey, currentProcessKey) {
    const slot = normalizeText(sessionSlotKey);
    const keep = normalizeText(currentProcessKey);
    if (!slot) {
      return [];
    }
    return [...this.entries.values()].filter(
      (entry) => entry.sessionSlotKey === slot && entry.processKey !== keep,
    );
  }

  static isEntryBusy(entry) {
    const client = entry?.client;
    if (!client) {
      return false;
    }
    return Boolean(client.alive && normalizeText(client.pendingTurnId));
  }

  rememberApproval(requestId, { processKey, sessionSlotKey = "", laneKey = "" }) {
    const normalizedRequestId = normalizeText(requestId);
    const normalizedProcessKey = normalizeText(processKey);
    if (!normalizedRequestId || !normalizedProcessKey) {
      return;
    }
    if (this.pendingApprovals.size >= this.maxPendingApprovals) {
      const oldest = this.pendingApprovals.keys().next().value;
      this.pendingApprovals.delete(oldest);
    }
    this.pendingApprovals.set(normalizedRequestId, {
      processKey: normalizedProcessKey,
      sessionSlotKey: normalizeText(sessionSlotKey),
      laneKey: normalizeText(laneKey),
    });
  }

  resolveApproval(requestId) {
    return this.pendingApprovals.get(normalizeText(requestId)) || null;
  }

  forgetApproval(requestId) {
    this.pendingApprovals.delete(normalizeText(requestId));
  }

  /**
   * Candidates for eviction when the registry is over capacity.
   * Never returns a process that is mid-turn: a lane must not be able to kill
   * another lane's running child just by being busier.
   */
  pickEvictableEntries() {
    if (this.entries.size <= this.maxProcesses) {
      return [];
    }
    const idle = [...this.entries.values()]
      .filter((entry) => !ProcessRegistry.isEntryBusy(entry))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    return idle.slice(0, Math.max(0, this.entries.size - this.maxProcesses));
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

module.exports = {
  DEFAULT_MAX_PROCESSES,
  ProcessRegistry,
  buildProcessKey,
};
