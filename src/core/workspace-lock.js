"use strict";

const fsApi = require("node:fs");
const path = require("node:path");

// Workspace read/write locking.
//
// v2 deliberately lets different lanes run different Claude processes at the
// same time. That is the point of lane isolation -- but two writers in one
// working directory is a real hazard, and the round-1 report flagged it as the
// top residual risk.
//
// This is the narrow fix: keep the independent sessions and processes, and
// serialize only the part that actually conflicts -- concurrent access to one
// filesystem workspace.
//
//   read  + read   -> concurrent
//   write + read   -> mutually exclusive
//   write + write  -> mutually exclusive
//
// The lock is held for a whole turn (write, stream, result) and released on
// result, cancel or failure. Waiters are served first-in-first-out, so a stream
// of readers cannot starve a writer.
//
// Keys are canonicalized with realpath, so a drive-letter path, the same path
// written through .., and a symlink to it are one workspace and not two.

const ACCESS_MODES = Object.freeze(["read", "write"]);
const DEFAULT_ACCESS = "write";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

class WorkspaceLockError extends Error {
  constructor(message, code = "workspace_lock_failed") {
    super(message);
    this.name = "WorkspaceLockError";
    this.code = code;
  }
}

function normalizeAccessMode(value, { field = "workspaceAccess" } = {}) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ACCESS;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!ACCESS_MODES.includes(text)) {
    throw new WorkspaceLockError(
      `${field} must be one of ${ACCESS_MODES.join("|")}`,
      "invalid_access_mode",
    );
  }
  return text;
}

/**
 * Canonical lock key for a workspace path.
 *
 * realpath when the path exists; otherwise the resolved absolute path, so a
 * not-yet-created directory still locks consistently. Case-folded on
 * case-insensitive platforms.
 */
function canonicalWorkspaceKey(workspaceRoot, { fs = fsApi } = {}) {
  const text = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!text) {
    return "";
  }
  let resolved = path.resolve(text);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Not created yet; the resolved path is still a stable key.
  }
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

class WorkspaceLockManager {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, fs = fsApi } = {}) {
    this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fs = fs;
    /** @type {Map<string, {readers: number, writer: boolean, queue: Array<object>}>} */
    this.states = new Map();
  }

  stateFor(key) {
    let state = this.states.get(key);
    if (!state) {
      state = { readers: 0, writer: false, queue: [] };
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * Acquire the workspace lock.
   *
   * @returns {Promise<{release: Function, key: string, mode: string}>}
   *          `release` is idempotent.
   */
  async acquire(workspaceRoot, mode = DEFAULT_ACCESS, { timeoutMs = this.timeoutMs } = {}) {
    const access = normalizeAccessMode(mode);
    const key = canonicalWorkspaceKey(workspaceRoot, { fs: this.fs });
    if (!key) {
      // Nothing identifiable to protect; a no-op release keeps callers simple.
      return { release: () => {}, key: "", mode: access };
    }

    const state = this.stateFor(key);
    if (this.canGrantImmediately(state, access)) {
      this.grant(state, access);
      return this.buildHandle(key, access);
    }

    return new Promise((resolve, reject) => {
      const waiter = { access, resolve, reject, timer: null, settled: false };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        const index = state.queue.indexOf(waiter);
        if (index >= 0) {
          state.queue.splice(index, 1);
        }
        reject(new WorkspaceLockError(
          `timed out waiting for a ${access} lock on the workspace`,
          "workspace_lock_timeout",
        ));
      }, Math.max(1, timeoutMs));
      // Deliberately not unref'd: a queued turn is real pending work, and a
      // process that exits while a lane is still waiting would abandon it
      // silently. The timer is cleared as soon as the lock is granted.
      state.queue.push(waiter);
    });
  }

  canGrantImmediately(state, access) {
    if (state.writer) {
      return false;
    }
    if (access === "write") {
      return state.readers === 0 && state.queue.length === 0;
    }
    // A reader may only overtake when no writer is already waiting; otherwise a
    // steady read stream would starve the writer.
    return !state.queue.some((waiter) => waiter.access === "write");
  }

  grant(state, access) {
    if (access === "write") {
      state.writer = true;
      return;
    }
    state.readers += 1;
  }

  buildHandle(key, access) {
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.release(key, access);
    };
    return { release, key, mode: access };
  }

  release(key, access) {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    if (access === "write") {
      state.writer = false;
    } else if (state.readers > 0) {
      state.readers -= 1;
    }
    this.drain(state, key);
  }

  drain(state, key) {
    while (state.queue.length) {
      const next = state.queue[0];
      if (next.access === "write") {
        if (state.writer || state.readers > 0) {
          break;
        }
        state.queue.shift();
        clearTimeout(next.timer);
        if (next.settled) {
          continue;
        }
        next.settled = true;
        this.grant(state, "write");
        next.resolve(this.buildHandle(key, "write"));
        break;
      }
      if (state.writer) {
        break;
      }
      state.queue.shift();
      clearTimeout(next.timer);
      if (next.settled) {
        continue;
      }
      next.settled = true;
      this.grant(state, "read");
      next.resolve(this.buildHandle(key, "read"));
    }
    if (!state.writer && state.readers === 0 && state.queue.length === 0) {
      this.states.delete(key);
    }
  }

  /** Diagnostics only: counts, never paths. */
  describe() {
    let readers = 0;
    let writers = 0;
    let waiting = 0;
    for (const state of this.states.values()) {
      readers += state.readers;
      writers += state.writer ? 1 : 0;
      waiting += state.queue.length;
    }
    return Object.freeze({ keys: this.states.size, readers, writers, waiting });
  }
}

module.exports = {
  ACCESS_MODES,
  DEFAULT_ACCESS,
  DEFAULT_TIMEOUT_MS,
  WorkspaceLockError,
  WorkspaceLockManager,
  canonicalWorkspaceKey,
  normalizeAccessMode,
};
