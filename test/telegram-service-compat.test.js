const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { SystemMessageService } = require("../src/services/system-message-service");
const { TimelineService } = require("../src/services/timeline-service");

test("system message service queues telegram messages without WeChat account files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-system-telegram-"));
  const workspaceRoot = path.join(tempDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const service = new SystemMessageService({
    config: {
      channel: "telegram",
      accountId: "telegram-deepseek",
      systemMessageQueueFile: path.join(tempDir, "system-message-queue.json"),
      sleepScheduleFile: path.join(tempDir, "sleep-schedule.json"),
      allowedUserIds: [],
    },
    sessionStore: {
      getBindings() {
        return {};
      },
    },
  });

  const queued = service.queueMessage({
    text: "ping",
    userId: "8719061650",
    workspaceRoot,
  }, {});

  assert.equal(queued.accountId, "telegram-deepseek");
  assert.equal(queued.senderId, "8719061650");
  assert.equal(queued.workspaceRoot, workspaceRoot);
  assert.equal(queued.text, "ping");
});

test("timeline service queues telegram screenshots without WeChat account files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-timeline-telegram-"));
  const service = new TimelineService({
    config: {
      channel: "telegram",
      accountId: "telegram-deepseek",
      timelineScreenshotQueueFile: path.join(tempDir, "timeline-screenshot-queue.json"),
      workspaceId: "deepseek",
      allowedUserIds: [],
    },
    timelineIntegration: {
      async runSubcommand() {
        return {};
      },
    },
    sessionStore: {
      getBindings() {
        return {};
      },
    },
  });

  const queued = service.queueScreenshot({
    userId: "8719061650",
    date: "2026-06-10",
  }, {});

  assert.equal(queued.accountId, "telegram-deepseek");
  assert.equal(queued.senderId, "8719061650");
  assert.equal(queued.date, "2026-06-10");
});
