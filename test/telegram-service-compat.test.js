const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const { SystemMessageService } = require("../src/services/system-message-service");

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
    userId: "12345",
    workspaceRoot,
  }, {});

  assert.equal(queued.accountId, "telegram-deepseek");
  assert.equal(queued.senderId, "12345");
  assert.equal(queued.workspaceRoot, workspaceRoot);
  assert.equal(queued.text, "ping");
});
