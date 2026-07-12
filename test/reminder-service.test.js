const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ReminderService } = require("../src/services/reminder-service");

test("reminder service creates telegram reminders without WeChat account files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-reminder-telegram-"));
  const service = new ReminderService({
    config: {
      channel: "telegram",
      accountId: "telegram-deepseek",
      reminderQueueFile: path.join(tempDir, "reminder-queue.json"),
      allowedUserIds: [],
    },
    sessionStore: {
      getBindings() {
        return {};
      },
    },
  });

  const reminder = await service.create({
    text: "test telegram reminder",
    delayMinutes: 1,
    userId: "12345",
  }, {});

  assert.equal(reminder.accountId, "telegram-deepseek");
  assert.equal(reminder.senderId, "12345");
  assert.equal(reminder.contextToken, "telegram:12345");
  assert.equal(reminder.text, "test telegram reminder");
  assert.match(reminder.id, /^[0-9a-f-]{36}$/i);
});
