"use strict";

const fs = require("fs");

// The watchdog writes one "healthy active release ..." heartbeat per cycle,
// default --interval 60s (extensions/relationship-memory/launcher/watchdog.py).
// Treat >3x that with no fresh healthy line as "lost": long enough to ignore a
// single skipped cycle, short enough to surface the battery-policy silent stop
// the watchdog is known to be prone to.
const WATCHDOG_HEARTBEAT_SECONDS = 60;
const WATCHDOG_STALE_SECONDS = 3 * WATCHDOG_HEARTBEAT_SECONDS;

// Bound how much of the (append-only, possibly large) log we read on each /status.
const WATCHDOG_TAIL_BYTES = 32 * 1024;

// Only the healthy heartbeat line counts as a liveness signal. Timestamp is the
// watchdog's local wall-clock, "[YYYY-MM-DD HH:MM:SS]", no timezone (parsed as
// local time here — /status runs on the same machine that wrote the log).
const HEALTHY_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+healthy active release\b/;

function readTailUtf8(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function findLastHealthyDate(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = HEALTHY_LINE.exec(lines[i]);
    if (match) {
      const parsed = new Date(match[1]);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  return null;
}

// Classify watchdog liveness from the freshness of its last healthy heartbeat.
// Pure read-only, fail-open: an unset path, a missing/unreadable log, or a log
// with no healthy line yields a non-throwing verdict rather than an exception.
//   state: "unconfigured" | "unreadable" | "unknown" | "alive" | "lost"
function readWatchdogHealth(logFilePath, options = {}) {
  const now = typeof options.now === "number" ? options.now : Date.now();
  const staleSeconds = typeof options.staleSeconds === "number" ? options.staleSeconds : WATCHDOG_STALE_SECONDS;
  const path = typeof logFilePath === "string" ? logFilePath.trim() : "";
  if (!path) {
    return { state: "unconfigured", ageSeconds: null, at: null };
  }
  let text;
  try {
    text = readTailUtf8(path, WATCHDOG_TAIL_BYTES);
  } catch {
    return { state: "unreadable", ageSeconds: null, at: null };
  }
  const lastHealthy = findLastHealthyDate(text);
  if (!lastHealthy) {
    return { state: "unknown", ageSeconds: null, at: null };
  }
  const ageSeconds = Math.max(0, Math.floor((now - lastHealthy.getTime()) / 1000));
  return {
    state: ageSeconds > staleSeconds ? "lost" : "alive",
    ageSeconds,
    at: lastHealthy,
  };
}

// One human-readable /status line. Honest about every non-alive state; never
// claims alive when the log cannot confirm it.
function formatWatchdogStatusLine(health) {
  const state = health?.state;
  const age = typeof health?.ageSeconds === "number" ? formatAge(health.ageSeconds) : null;
  switch (state) {
    case "alive":
      return `🐕 watchdog: alive · last healthy ${age} ago`;
    case "lost":
      return `🐕 watchdog: LOST · last healthy ${age} ago (no heartbeat > ${WATCHDOG_STALE_SECONDS}s)`;
    case "unreadable":
      return "🐕 watchdog: unknown · health log unreadable";
    case "unknown":
      return "🐕 watchdog: unknown · no healthy heartbeat in log";
    case "unconfigured":
    default:
      return "🐕 watchdog: unknown · log not configured (set CYBERBOSS_WATCHDOG_LOG)";
  }
}

function formatAge(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  const minutes = Math.floor(s / 60);
  if (minutes < 60) {
    return `${minutes}m${s % 60 ? ` ${s % 60}s` : ""}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

module.exports = {
  readWatchdogHealth,
  formatWatchdogStatusLine,
  WATCHDOG_HEARTBEAT_SECONDS,
  WATCHDOG_STALE_SECONDS,
};
