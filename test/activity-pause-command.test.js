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

test("/pause activity and /continue activity use the real parser/dispatcher and leave chat running", async () => {
  const root = tempRoot();
  try {
    const { app, sent, chats } = makeCommandApp(root);

    await app.handlePreparedMessage({ ...INBOUND, text: "/pause activity" }, { allowCommands: true });
    assert.equal(readActivityPauseState(app.config.activityPauseFile).paused, true);
    assert.match(sent[0].text, /Desire hourly ticks/);
    assert.match(sent[0].text, /window chat and user-set reminders/);

    await app.handlePreparedMessage({ ...INBOUND, messageId: "message-2", text: "hello through the window" }, { allowCommands: true });
    assert.deepEqual(chats, ["hello through the window"]);

    await app.handlePreparedMessage({ ...INBOUND, messageId: "message-3", text: "/continue activity" }, { allowCommands: true });
    assert.equal(readActivityPauseState(app.config.activityPauseFile).paused, false);
    assert.match(sent[1].text, /Autonomous activity resumed/);
  } finally {
    cleanup(root);
  }
});

test("activity commands are registered in Telegram help and reject other arguments", async () => {
  const root = tempRoot();
  try {
    const { app, sent } = makeCommandApp(root);
    const actions = listCommandGroups().flatMap((group) => group.actions);
    assert.deepEqual(actions.find((action) => action.action === "activity.pause").weixin, ["/pause activity"]);
    assert.deepEqual(actions.find((action) => action.action === "activity.continue").weixin, ["/continue activity"]);
    assert.match(buildWeixinHelpText(), /\/pause activity/);
    assert.match(buildWeixinHelpText(), /\/continue activity/);

    await app.handlePreparedMessage({ ...INBOUND, text: "/pause reminders" }, { allowCommands: true });
    assert.equal(fs.existsSync(app.config.activityPauseFile), false);
    assert.match(sent[0].text, /Usage: \/pause activity/);
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
