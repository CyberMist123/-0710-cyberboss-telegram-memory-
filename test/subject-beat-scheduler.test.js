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
    reflectIntervalDays: 3,
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

test("consolidation is daily and reflect observes a three-day interval", async () => {
  const value = fixture();
  try {
    value.config.reflectTriggerEnabled = true;
    const owner = scheduler(value);
    const now = Date.parse("2026-08-09T20:30:00Z");
    const first = await owner.tick(now);
    assert.equal(first.reflect.status, "queued");
    value.queue.drainForAccount("fixture-account");
    const sameDay = await owner.tick(Date.parse("2026-08-09T21:30:00Z"));
    assert.equal(sameDay.reflect.reason, "already_triggered");
    const intervalNotReached = await owner.tick(Date.parse("2026-08-11T20:30:00Z"));
    assert.equal(intervalNotReached.reflect.reason, "interval_not_reached");
    const afterInterval = await owner.tick(Date.parse("2026-08-12T20:30:00Z"));
    assert.equal(afterInterval.reflect.status, "queued");
    assert.equal(value.queue.drainForAccount("fixture-account").length, 1);
    await owner.stop();
  } finally {
    cleanup(value.root);
  }
});

test("consolidation remains once per local date", async () => {
  const value = fixture();
  try {
    value.config.consolidationTriggerEnabled = true;
    const owner = scheduler(value);
    const now = Date.parse("2026-08-09T21:30:00Z");
    const first = await owner.tick(now);
    assert.equal(first.consolidation.status, "queued");
    value.queue.drainForAccount("fixture-account");
    const second = await owner.tick(now + 60_000);
    assert.equal(second.consolidation.reason, "already_triggered");
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

// 2026-08-09 真机复盘：到点却没敲成（暂停/重叠）时 next 停在过去，差值取 0 就成了
// setTimeout(0) 忙转。回归钉住：过期重排必须垫非零延迟。
test("overdue reschedule uses a non-zero retry delay instead of spinning", async () => {
  const value = fixture();
  try {
    value.config.reflectTriggerEnabled = true;
    const delays = [];
    const owner = scheduler(value, {
      clock: { now: () => Date.parse("2026-08-09T23:00:00Z") },
      timers: { setTimeout(fn, ms) { delays.push(ms); return delays.length; }, clearTimeout() {} },
    });
    writeActivityPauseState(value.config.activityPauseFile, true, { now: Date.parse("2026-08-09T23:00:00Z") });
    assert.equal(owner.start(), true);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 60_000, `expected >=60s retry delay, got ${delays[0]}`);
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
  const menu = "如果此刻想安静整理，可以翻翻 episodes / 记记账本（memory_candidate_submit type=details），或看看观察池。";
  for (const desireLoopMinimalEnabled of [false, true]) {
    const desire = buildSystemInboundText(
      "到 Desire 节拍了。",
      "2026-08-09T20:30:00Z",
      "desire_checkin",
      "failure",
      { desireLoopMinimalEnabled, promptOverride: "" },
    );
    assert.match(desire, new RegExp(menu));
    assert.ok(desire.indexOf(menu) < desire.indexOf("Trigger:"));
  }
});
