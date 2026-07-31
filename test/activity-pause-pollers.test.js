"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { runHourlyDesireTick } = require("../src/app/hourly-desire-poller");
const { runSystemCheckinTick } = require("../src/app/system-checkin-poller");
const { writeActivityPauseState } = require("../src/core/activity-pause-state");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-activity-pollers-"));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

async function captureLogs(run) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: await run(), lines };
  } finally {
    console.log = originalLog;
  }
}

test("Desire tick logs paused, skips queue work, and resumes after continue", async () => {
  const root = tempRoot();
  try {
    const activityPauseFile = path.join(root, "activity-pause.json");
    const config = {
      activityPauseFile,
      desireActiveFile: "",
      desireTelemetry: false,
      desireTelemetryFile: path.join(root, "desire-usage.jsonl"),
      desireLoopMinimalEnabled: false,
    };
    const schedule = {
      enabled: true,
      intervalMinutes: 55,
      nightSkipEnabled: false,
      nightStart: "22:00",
      nightEnd: "06:00",
      timezone: "Australia/Sydney",
    };
    writeActivityPauseState(activityPauseFile, true);
    const paused = await captureLogs(() => runHourlyDesireTick({
      config,
      schedule,
      tickTime: Date.parse("2026-07-31T02:00:00Z"),
      accountId: "telegram",
      senderId: "user-1",
      workspaceRoot: root,
      queue: {
        hasPendingForAccount() {
          throw new Error("paused tick must not inspect the queue");
        },
        enqueue() {
          throw new Error("paused tick must not enqueue");
        },
      },
    }));
    assert.deepEqual(paused.result, { status: "skipped", reason: "paused" });
    assert.ok(paused.lines.some((line) => /hourly poller tick skipped: paused/.test(line)));

    writeActivityPauseState(activityPauseFile, false);
    const queued = [];
    const resumed = runHourlyDesireTick({
      config,
      schedule,
      tickTime: Date.parse("2026-07-31T02:00:00Z"),
      accountId: "telegram",
      senderId: "user-1",
      workspaceRoot: root,
      queue: {
        hasPendingForAccount() {
          return false;
        },
        enqueue(message) {
          queued.push(message);
          return message;
        },
      },
    });
    assert.equal(resumed.status, "queued");
    assert.equal(queued[0].sourceType, "desire_checkin");
  } finally {
    cleanup(root);
  }
});

test("check-in tick logs paused and corrupt state fails open", async () => {
  const root = tempRoot();
  try {
    const activityPauseFile = path.join(root, "activity-pause.json");
    const config = {
      activityPauseFile,
      userName: "User",
      desireLoopMinimalEnabled: false,
    };
    const account = { accountId: "telegram" };
    const target = { senderId: "user-1", workspaceRoot: root };
    writeActivityPauseState(activityPauseFile, true);

    const paused = await captureLogs(() => runSystemCheckinTick({
      config,
      account,
      target,
      queue: {
        hasPendingForAccount() {
          throw new Error("paused tick must not inspect the queue");
        },
        enqueue() {
          throw new Error("paused tick must not enqueue");
        },
      },
    }));
    assert.deepEqual(paused.result, { status: "skipped", reason: "paused" });
    assert.ok(paused.lines.some((line) => /checkin tick skipped: paused/.test(line)));

    fs.writeFileSync(activityPauseFile, "{broken", "utf8");
    const queued = [];
    const failOpen = runSystemCheckinTick({
      config,
      account,
      target,
      queue: {
        hasPendingForAccount() {
          return false;
        },
        enqueue(message) {
          queued.push(message);
          return message;
        },
      },
    });
    assert.equal(failOpen.status, "queued");
    assert.equal(queued[0].sourceType, "checkin");
  } finally {
    cleanup(root);
  }
});
