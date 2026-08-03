"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { CyberbossApp } = require("../src/core/app");
const {
  isActivityPaused,
  readActivityPauseState,
  writeActivityPauseState,
} = require("../src/core/activity-pause-state");
const { buildWeixinHelpText, listCommandGroups } = require("../src/core/command-registry");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-activity-command-"));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function makeCommandApp(root) {
  const sent = [];
  const chats = [];
  const app = Object.create(CyberbossApp.prototype);
  app.config = { activityPauseFile: path.join(root, "activity-pause.json") };
  app.runtimeAdapter = {
    getSessionStore() {
      return {
        buildBindingKey() {
          return "binding-1";
        },
      };
    },
  };
  app.channelAdapter = {
    async sendText(payload) {
      sent.push(payload);
    },
  };
  app.resolveWorkspaceRoot = () => root;
  app.prepareIncomingMessageForRuntime = async (normalized) => ({
    ...normalized,
    attachments: [],
  });
  app.hasPendingImageInbound = () => false;
  app.dispatchTelegramPreparedInbound = async ({ prepared }) => {
    chats.push(prepared.text);
    return true;
  };
  return { app, sent, chats };
}

const INBOUND = {
  provider: "telegram",
  workspaceId: "default",
  accountId: "telegram",
  senderId: "user-1",
  chatId: "user-1",
  threadKey: "telegram:user-1",
  messageId: "message-1",
  contextToken: "telegram:user-1",
  attachments: [],
};

test("/pause_heartbeat and /continue_heartbeat use the real parser/dispatcher and leave chat running", async () => {
  const root = tempRoot();
  try {
    const { app, sent, chats } = makeCommandApp(root);

    await app.handlePreparedMessage({ ...INBOUND, text: "/pause_heartbeat" }, { allowCommands: true });
    assert.equal(readActivityPauseState(app.config.activityPauseFile).paused, true);
    assert.match(sent[0].text, /Desire hourly ticks/);
    assert.match(sent[0].text, /window chat and user-set reminders/);

    await app.handlePreparedMessage({ ...INBOUND, messageId: "message-2", text: "hello through the window" }, { allowCommands: true });
    assert.deepEqual(chats, ["hello through the window"]);

    await app.handlePreparedMessage({ ...INBOUND, messageId: "message-3", text: "/continue_heartbeat" }, { allowCommands: true });
    assert.equal(readActivityPauseState(app.config.activityPauseFile).paused, false);
    assert.match(sent[1].text, /Autonomous activity resumed/);
  } finally {
    cleanup(root);
  }
});

test("heartbeat commands are registered under the Autonomy group in Telegram help", async () => {
  const root = tempRoot();
  try {
    const { app, sent } = makeCommandApp(root);
    const actions = listCommandGroups().flatMap((group) => group.actions);
    assert.deepEqual(actions.find((action) => action.action === "activity.pause").weixin, ["/pause_heartbeat"]);
    assert.deepEqual(actions.find((action) => action.action === "activity.continue").weixin, ["/continue_heartbeat"]);
    const autonomy = listCommandGroups().find((group) => group.id === "autonomy");
    assert.ok(autonomy, "expected an Autonomy command group");
    assert.deepEqual(autonomy.actions.map((a) => a.action), ["activity.pause", "activity.continue"]);
    assert.match(buildWeixinHelpText(), /\/pause_heartbeat/);
    assert.match(buildWeixinHelpText(), /\/continue_heartbeat/);
    // The old two-word forms are gone from the front-end surface.
    assert.doesNotMatch(buildWeixinHelpText(), /\/pause activity/);

    // The single-token form carries the meaning: no "activity" arg required.
    await app.handlePreparedMessage({ ...INBOUND, text: "/pause_heartbeat" }, { allowCommands: true });
    assert.equal(readActivityPauseState(app.config.activityPauseFile).paused, true);
    assert.match(sent[0].text, /Autonomous activity paused/);
  } finally {
    cleanup(root);
  }
});

test("missing or corrupt activity state fails open and persisted pause survives fresh readers", () => {
  const root = tempRoot();
  try {
    const filePath = path.join(root, "activity-pause.json");
    assert.equal(isActivityPaused(filePath), false);

    writeActivityPauseState(filePath, true, { now: Date.parse("2026-07-31T00:00:00Z") });
    assert.equal(readActivityPauseState(filePath).paused, true);
    assert.equal(readActivityPauseState(filePath).updatedAt, "2026-07-31T00:00:00.000Z");

    fs.writeFileSync(filePath, "{broken", "utf8");
    assert.equal(isActivityPaused(filePath), false);
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, paused: "true" }), "utf8");
    assert.equal(isActivityPaused(filePath), false);
  } finally {
    cleanup(root);
  }
});

test("pause retains autonomous queue entries while reminder scheduling and other sources still deliver", async () => {
  const root = tempRoot();
  try {
    const activityPauseFile = path.join(root, "activity-pause.json");
    const queueStore = new SystemMessageQueueStore({
      filePath: path.join(root, "system-message-queue.json"),
    });
    const baseMessage = {
      accountId: "telegram",
      senderId: "user-1",
      workspaceRoot: root,
      text: "trigger",
    };
    for (const [index, sourceType] of ["desire_checkin", "checkin", "liveness_alert", "system"].entries()) {
      queueStore.enqueue({
        ...baseMessage,
        id: `${sourceType}-${index}`,
        sourceType,
        createdAt: new Date(Date.parse("2026-07-31T00:00:00Z") + index * 1000).toISOString(),
      });
    }
    writeActivityPauseState(activityPauseFile, true);

    const dispatcher = new SystemMessageDispatcher({
      queueStore,
      config: { workspaceId: "default", workspaceRoot: root, activityPauseFile },
      accountId: "telegram",
    });
    assert.deepEqual(dispatcher.drainPending().map((message) => message.sourceType), ["system"]);
    assert.equal(dispatcher.hasPending(), false);

    const reminder = {
      id: "reminder-1",
      accountId: "telegram",
      senderId: "user-1",
      text: "user asked for this",
    };
    await CyberbossApp.prototype.flushDueReminders.call({
      reminderQueue: {
        listDue() {
          return [reminder];
        },
        enqueue() {
          throw new Error("reminder should not be rescheduled");
        },
      },
      systemMessageQueue: queueStore,
      resolveReminderWorkspaceRoot() {
        return root;
      },
      config: { userName: "User" },
    }, { accountId: "telegram" });

    assert.equal(dispatcher.hasPending(), true);
    assert.deepEqual(dispatcher.drainPending().map((message) => message.sourceType), ["reminder"]);
    assert.equal(dispatcher.hasPending(), false);

    writeActivityPauseState(activityPauseFile, false);
    const restartedDispatcher = new SystemMessageDispatcher({
      queueStore: new SystemMessageQueueStore({ filePath: queueStore.filePath }),
      config: { workspaceId: "default", workspaceRoot: root, activityPauseFile },
      accountId: "telegram",
    });
    assert.deepEqual(
      restartedDispatcher.drainPending().map((message) => message.sourceType),
      ["desire_checkin", "checkin", "liveness_alert"],
    );
  } finally {
    cleanup(root);
  }
});
