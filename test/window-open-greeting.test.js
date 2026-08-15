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
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

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

// The first version of this feature shipped broken and the fake queue above is
// why: it accepted anything, while the real store rejects a message with an
// empty body outright. Production logged `window-open greeting skipped: invalid
// system message` and she never heard a word. Drive the real store.
test("the queued trigger survives the real queue store's own validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-greeting-queue-"));
  const store = new SystemMessageQueueStore({ filePath: path.join(dir, "system-message-queue.json") });
  const app = {
    config: { windowOpenGreetingEnabled: true, activityPauseFile: "" },
    activeAccountId: "telegram",
    systemMessageQueue: store,
    enqueueWindowOpenGreetingFailOpen: CyberbossApp.prototype.enqueueWindowOpenGreetingFailOpen,
  };

  const queued = app.enqueueWindowOpenGreetingFailOpen(INBOUND, WORKSPACE);
  assert.ok(queued, "the real store must accept the trigger, not reject it");

  const pending = store.listForAccount ? store.listForAccount("telegram") : store.state.messages;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sourceType, "window_open");
  assert.match(pending[0].text, /\S/u, "an empty body is what the store rejects");

  fs.rmSync(dir, { recursive: true, force: true });
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

function continueApp() {
  const queued = [];
  return {
    queued,
    app: {
      // A paused activity file is deliberately present: the auto-continue must
      // still fire, because it finishes an action she herself initiated.
      config: { activityPauseFile: "" },
      activeAccountId: "telegram",
      systemMessageQueue: {
        enqueue(message) { queued.push(message); return message; },
        hasPendingForAccount(_accountId, { shouldInclude } = {}) {
          return queued.some((m) => (shouldInclude ? shouldInclude(m) : true));
        },
      },
      enqueueRoute2ContinueFailOpen: CyberbossApp.prototype.enqueueRoute2ContinueFailOpen,
    },
  };
}

const ESC_ORIGIN = { senderId: "42", workspaceRoot: WORKSPACE, bindingKey: "default:telegram:42" };

test("a route2 escalation relaunch auto-queues her continuation, no inbound message needed", () => {
  const { app, queued } = continueApp();
  app.enqueueRoute2ContinueFailOpen(ESC_ORIGIN);

  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceType, "route2_continue");
  assert.equal(queued[0].senderId, "42");
  assert.equal(queued[0].workspaceRoot, WORKSPACE);
  assert.match(queued[0].text, /\S/u, "an empty body is what the store rejects");
});

test("a burst of relaunch signals still queues only one continuation", () => {
  const { app, queued } = continueApp();
  app.enqueueRoute2ContinueFailOpen(ESC_ORIGIN);
  app.enqueueRoute2ContinueFailOpen(ESC_ORIGIN);
  assert.equal(queued.length, 1, "the second dedupes against the pending one");
});

test("the route2_continue trigger tells her the wide face is ready and to continue", () => {
  const text = buildSystemInboundText("", "2026-08-07T10:00:00.000Z", "route2_continue");

  assert.match(text, /System trigger type: route2_continue\./u);
  assert.match(text, /宽工具面/u);
  assert.match(text, /继续/u);
  assert.match(text, /\{"action":"silent"\}/u);
  // Must not fall through to the generic branch (which still says "WeChat").
  assert.equal(text.includes("WeChat"), false);
});
