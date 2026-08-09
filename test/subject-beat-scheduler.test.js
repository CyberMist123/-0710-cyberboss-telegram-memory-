const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SubjectBeatScheduler } = require("../src/app/subject-beat-scheduler");
const { buildSystemInboundText } = require("../src/core/system-message-dispatcher");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { writeActivityPauseState } = require("../src/core/activity-pause-state");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-subject-beat-"));
  const continuityDir = path.join(root, "continuity");
  fs.mkdirSync(continuityDir, { recursive: true });
  const config = {
    automationTimezone: "UTC",
    activityPauseFile: path.join(root, "activity-pause.json"),
    subjectBeatStateFile: path.join(continuityDir, ".jobs", "subject-beat-state.json"),
    consolidationTriggerEnabled: false,
    consolidationHour: 21,
    consolidationMinute: 30,
    reflectTriggerEnabled: false,
    reflectWeekday: 0,
    reflectHour: 20,
    reflectMinute: 30,
  };
  const queue = new SystemMessageQueueStore({ filePath: path.join(root, "system-message-queue.json") });
  return { root, config, queue };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function scheduler(fixtureValue, overrides = {}) {
  return new SubjectBeatScheduler({
    config: fixtureValue.config,
    queueStore: fixtureValue.queue,
    accountId: "fixture-account",
    senderId: "fixture-sender",
    workspaceRoot: fixtureValue.root,
    ...overrides,
  });
}

test("both subject beats default off with no timer, state, or queue mutation", async () => {
  const value = fixture();
  try {
    let timers = 0;
    const owner = scheduler(value, { timers: { setTimeout() { timers += 1; return timers; }, clearTimeout() {} } });
    assert.equal(owner.start(), false);
    assert.equal(timers, 0);
    assert.equal(fs.existsSync(value.config.subjectBeatStateFile), false);
    assert.deepEqual(value.queue.drainForAccount("fixture-account"), []);
    await owner.stop();
  } finally {
    cleanup(value.root);
  }
});

test("consolidation enqueues once per local date and reflect once per ISO week", async () => {
  const value = fixture();
  try {
    value.config.consolidationTriggerEnabled = true;
    value.config.reflectTriggerEnabled = true;
    const owner = scheduler(value);
    const now = Date.parse("2026-08-09T21:30:00Z");
    const first = await owner.tick(now);
    assert.equal(first.consolidation.status, "queued");
    assert.equal(first.reflect.status, "queued");
    assert.deepEqual(value.queue.drainForAccount("fixture-account").map((item) => item.sourceType).sort(), ["consolidation", "reflect"]);
    const second = await owner.tick(now + 60_000);
    assert.equal(second.consolidation.reason, "already_triggered");
    assert.equal(second.reflect.reason, "already_triggered");
    assert.deepEqual(value.queue.drainForAccount("fixture-account"), []);
    await owner.stop();
  } finally {
    cleanup(value.root);
  }
});

test("paused activity and same-source pending messages skip the beat", async () => {
  const value = fixture();
  try {
    value.config.consolidationTriggerEnabled = true;
    const owner = scheduler(value);
    const now = Date.parse("2026-08-09T21:30:00Z");
    writeActivityPauseState(value.config.activityPauseFile, true, { now });
    assert.equal((await owner.tick(now)).consolidation.reason, "paused");
    assert.equal(fs.existsSync(value.config.subjectBeatStateFile), false);
    writeActivityPauseState(value.config.activityPauseFile, false, { now });
    value.queue.enqueue({
      id: "existing", accountId: "fixture-account", senderId: "fixture-sender", workspaceRoot: value.root,
      text: "existing", sourceType: "consolidation", createdAt: new Date(now).toISOString(),
    });
    assert.equal((await owner.tick(now)).consolidation.reason, "overlap");
    assert.equal(value.queue.drainForAccount("fixture-account").length, 1);
    await owner.stop();
  } finally {
    cleanup(value.root);
  }
});

test("subject beat dispatcher uses override first and otherwise gives non-metric opportunities", () => {
  const consolidation = buildSystemInboundText("到整理节拍了。", "2026-08-09T21:30:00Z", "consolidation", "failure", { promptOverride: "fixture override" });
  assert.match(consolidation, /fixture override/u);
  assert.doesNotMatch(consolidation, /翻翻 episodes\/index\.md/u);
  const reflect = buildSystemInboundText("到 Reflect 节拍了。", "2026-08-09T20:30:00Z", "reflect");
  assert.match(reflect, /跨窗口反复出现/u);
  assert.match(reflect, /没有就停/u);
});
