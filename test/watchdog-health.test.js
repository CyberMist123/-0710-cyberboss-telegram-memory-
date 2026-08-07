"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readWatchdogHealth,
  formatWatchdogStatusLine,
  WATCHDOG_STALE_SECONDS,
} = require("../src/core/watchdog-health");
const { CyberbossApp } = require("../src/core/app");

function tempLog(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-"));
  const file = path.join(dir, "watchdog.log");
  fs.writeFileSync(file, contents, "utf8");
  return { dir, file };
}

// Format a Date exactly as watchdog.py does: "[YYYY-MM-DD HH:MM:SS] healthy ...",
// local wall-clock, no timezone. Parsed back to the same local Date, so age math
// is deterministic regardless of the machine's timezone.
function healthyLine(date, releaseId = "r1") {
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  return `[${ts}] healthy active release ${releaseId}: pid 4242 matches /opt/app/telegram`;
}

test("unset log path => unconfigured (fail-open, no throw)", () => {
  assert.deepEqual(readWatchdogHealth(""), { state: "unconfigured", ageSeconds: null, at: null });
  assert.deepEqual(readWatchdogHealth("   "), { state: "unconfigured", ageSeconds: null, at: null });
  assert.deepEqual(readWatchdogHealth(null), { state: "unconfigured", ageSeconds: null, at: null });
});

test("missing log file => unreadable (fail-open)", () => {
  const missing = path.join(os.tmpdir(), `cyberboss-watchdog-missing-${process.pid}.log`);
  assert.equal(readWatchdogHealth(missing).state, "unreadable");
});

test("log without a healthy line => unknown", () => {
  const { dir, file } = tempLog("[2026-08-03 10:00:00] check failed (will retry): boom\n");
  try {
    assert.equal(readWatchdogHealth(file).state, "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh healthy heartbeat => alive with age", () => {
  const base = new Date(2026, 7, 3, 14, 22, 1);
  const { dir, file } = tempLog(`${healthyLine(base)}\n`);
  try {
    const health = readWatchdogHealth(file, { now: base.getTime() + 45_000 });
    assert.equal(health.state, "alive");
    assert.equal(health.ageSeconds, 45);
    // The age is still computed (the LOST line needs it) but deliberately not
    // rendered when healthy — it was noise on every normal read.
    assert.equal(formatWatchdogStatusLine(health), "🐕 watchdog: alive");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale heartbeat beyond threshold => lost", () => {
  const base = new Date(2026, 7, 3, 14, 22, 1);
  const { dir, file } = tempLog(`${healthyLine(base)}\n`);
  try {
    const health = readWatchdogHealth(file, { now: base.getTime() + (WATCHDOG_STALE_SECONDS + 60) * 1000 });
    assert.equal(health.state, "lost");
    assert.match(formatWatchdogStatusLine(health), /LOST · 已 4m 没有心跳/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uses the LAST healthy line, ignoring earlier ones and non-healthy tail", () => {
  const older = new Date(2026, 7, 3, 10, 0, 0);
  const newer = new Date(2026, 7, 3, 14, 0, 0);
  const contents = [
    healthyLine(older),
    "[2026-08-03 13:00:00] check failed (will retry): blip",
    healthyLine(newer),
    "[2026-08-03 14:01:00] watchdog recovered: ok",
  ].join("\n") + "\n";
  const { dir, file } = tempLog(contents);
  try {
    const health = readWatchdogHealth(file, { now: newer.getTime() + 30_000 });
    assert.equal(health.state, "alive");
    assert.equal(health.ageSeconds, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatWatchdogStatusLine is honest for every non-alive state", () => {
  assert.match(formatWatchdogStatusLine({ state: "unconfigured" }), /log not configured/);
  assert.match(formatWatchdogStatusLine({ state: "unreadable" }), /unreadable/);
  assert.match(formatWatchdogStatusLine({ state: "unknown" }), /no healthy heartbeat/);
});

test("/status renders the watchdog line and human-readable idle state", async () => {
  // The handler reads with real Date.now(), so the heartbeat must be written at
  // the current wall-clock to read as fresh.
  const { dir, file } = tempLog(`${healthyLine(new Date())}\n`);
  const sent = [];
  const appLike = {
    config: { claudeContextWindow: 130000, claudeMaxOutputTokens: 64000, watchdogLogFile: file },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return null;
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  // Chained to the real prototype so the shared window-override ladder the
  // command calls runs its production implementation, not a per-fixture stub.
  await CyberbossApp.prototype.handleStatusCommand.call(Object.setPrototypeOf(appLike, CyberbossApp.prototype), {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /🐕 watchdog: alive$/m);
  assert.match(sent[0], /📊 status: idle · 空闲，这条 lane 没有正在跑的回合/);
  fs.rmSync(dir, { recursive: true, force: true });
});
