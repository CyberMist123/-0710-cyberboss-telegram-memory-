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
// A turn that never reports a result must not wedge its lane forever.
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;

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
  constructor({ maxProcesses = DEFAULT_MAX_PROCESSES, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS } = {}) {
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
    /** @type {Map<string, {turnToken: string, settled: Promise<void>, release: Function, startedAt: number}>} */
    this.activeTurns = new Map();
    this.turnSequence = 0;
    this.turnTimeoutMs = Number.isSafeInteger(turnTimeoutMs) && turnTimeoutMs > 0
      ? turnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  }

  /**
   * Serialize work for one process key. Every start, stop and resume for a key
   * goes through here, so they can never interleave.
   *
   * Locks for different keys are independent: a slow relaunch in one lane does
   * not block a turn in another. The chain entry is removed once the last
   * waiter drains, so a long-lived process does not accumulate one map entry
   * per key forever.
   */
  withLock(processKey, fn) {
    const key = normalizeText(processKey);
    if (!key) {
      return Promise.resolve().then(fn);
    }
    const previous = this.locks.get(key) || Promise.resolve();
    // Swallow the predecessor's rejection so one failed launch does not poison
    // every later attempt on the same key.
    const result = previous.then(() => fn(), () => fn());
    const tail = result.then(() => {}, () => {});
    this.locks.set(key, tail);
    tail.then(() => {
      // Only the last waiter clears the entry; an intermediate one would let a
      // queued caller jump the chain.
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  lockCount() {
    return this.locks.size;
  }

  /**
   * Full-turn single-flight for one process key.
   *
   * The lock above only covers attach. A turn spans the write *and* the
   * streamed result, so a second turn arriving mid-stream would overwrite
   * pendingTurnId / activeThreadId on the same client. `beginTurn` waits until
   * the previous turn has settled (result, cancel or failure).
   *
   * @returns {Promise<{turnToken: string}>}
   */
  async beginTurn(processKey, { timeoutMs = this.turnTimeoutMs } = {}) {
    const key = normalizeText(processKey);
    if (!key) {
      return { turnToken: "" };
    }
    const budgetMs = Math.max(1, timeoutMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const active = this.activeTurns.get(key);
      if (!active) {
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // A turn that never settles must not wedge the lane forever. It is
        // force-settled and logged rather than silently ignored.
        console.warn(`[claudecode-runtime] force-settling a stuck turn on process ${key.slice(0, 8)}`);
        this.settleTurn(key, { force: true });
        break;
      }
      // Race the wait against the remaining budget: awaiting `settled` alone
      // would block forever on a turn that never reports a result.
      let timer;
      await Promise.race([
        active.settled.catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
    this.turnSequence += 1;
    const turnToken = `t${this.turnSequence}`;
    let release;
    const settled = new Promise((resolve) => {
      release = resolve;
    });
    this.activeTurns.set(key, { turnToken, settled, release, startedAt: Date.now() });
    return { turnToken };
  }

  /**
   * Settle the in-flight turn for a process key. Idempotent, and a stale token
   * is ignored so a late event cannot release a newer turn.
   */
  settleTurn(processKey, { turnToken = "", force = false } = {}) {
    const key = normalizeText(processKey);
    const active = key ? this.activeTurns.get(key) : null;
    if (!active) {
      return false;
    }
    if (!force && turnToken && active.turnToken !== turnToken) {
      return false;
    }
    this.activeTurns.delete(key);
    active.release();
    return true;
  }

  hasActiveTurn(processKey) {
    return this.activeTurns.has(normalizeText(processKey));
  }

  activeTurnCount() {
    return this.activeTurns.size;
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
    // Retiring a process settles whatever it was running, so a waiter is not
    // left blocked on a turn whose owner no longer exists.
    this.settleTurn(key, { force: true });
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
  DEFAULT_TURN_TIMEOUT_MS,
  ProcessRegistry,
  buildProcessKey,
};
