"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { readConfig } = require("../src/core/config");
const { buildSystemInboundText } = require("../src/core/system-message-dispatcher");
const { writeActivityPauseState } = require("../src/core/activity-pause-state");

const WORKSPACE = "C:\\fixture\\workspace";

function greetingApp({ enabled, activityPauseFile = "" }) {
  const queued = [];
  return {
    queued,
    app: {
      config: { windowOpenGreetingEnabled: enabled, activityPauseFile },
      activeAccountId: "telegram",
      systemMessageQueue: { enqueue(message) { queued.push(message); return message; } },
      enqueueWindowOpenGreetingFailOpen: CyberbossApp.prototype.enqueueWindowOpenGreetingFailOpen,
    },
  };
}

const INBOUND = { senderId: "42", accountId: "telegram" };

test("/new queues one window-open trigger when the greeting is enabled", () => {
  const { app, queued } = greetingApp({ enabled: true });
  app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE);

  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceType, "window_open");
  assert.equal(queued[0].senderId, "42");
  assert.equal(queued[0].workspaceRoot, WORKSPACE);
});

test("the greeting is off by default and stays off until the switch is set", () => {
  const original = process.env.CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED;
  try {
    delete process.env.CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED;
    assert.equal(readConfig().windowOpenGreetingEnabled, false);
  } finally {
    if (original === undefined) delete process.env.CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED;
    else process.env.CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED = original;
  }

  const { app, queued } = greetingApp({ enabled: false });
  app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE);
  assert.equal(queued.length, 0);
});

test("a paused heartbeat silences the greeting too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-greeting-"));
  const activityPauseFile = path.join(dir, "activity-pause.json");
  writeActivityPauseState(activityPauseFile, true);

  // `/pause_heartbeat` means "stop speaking to me on your own"; an unasked-for
  // opening line is exactly that.
  const { app, queued } = greetingApp({ enabled: true, activityPauseFile });
  app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE);
  assert.equal(queued.length, 0);

  writeActivityPauseState(activityPauseFile, false);
  app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE);
  assert.equal(queued.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a queue that throws costs her the greeting, never the /new", () => {
  const app = {
    config: { windowOpenGreetingEnabled: true, activityPauseFile: "" },
    activeAccountId: "telegram",
    systemMessageQueue: { enqueue() { throw new Error("queue exploded"); } },
    enqueueWindowOpenGreetingFailOpen: CyberbossApp.prototype.enqueueWindowOpenGreetingFailOpen,
  };
  assert.doesNotThrow(() => app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE));
  assert.equal(app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE), null);
});

test("the window-open trigger asks her to arrive, not to file a report", () => {
  const text = buildSystemInboundText("", "2026-08-07T10:00:00.000Z", "window_open");

  assert.match(text, /System trigger type: window_open\./u);
  assert.match(text, /读完再开口/u);
  // The whole point of the trigger: no recital of what was read.
  assert.match(text, /不要汇报你读了什么/u);
  assert.match(text, /\{"action":"send_message","message":"<你的第一句话>"\}/u);
  // It must not inherit the eight-dimension report contract.
  assert.equal(text.includes("drives"), false);
  assert.equal(text.includes("desire_state"), false);
});
