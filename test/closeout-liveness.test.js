const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { readConfig } = require("../src/core/config");
const {
  CloseoutLivenessAutomation,
  businessDateKey,
  inspectJsonl,
  isScheduleDue,
  nextScheduleAt,
} = require("../src/app/closeout-liveness");
const { buildSystemInboundText } = require("../src/core/system-message-dispatcher");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-p0-"));
}

function baseConfig(root, overrides = {}) {
  const continuityDir = path.join(root, "continuity");
  fs.mkdirSync(continuityDir, { recursive: true });
  return {
    channel: "telegram",
    workspaceRoot: root,
    continuityDir,
    continuityBranch: "test",
    continuityWorktree: root,
    continuityBaseSha: "0".repeat(40),
    stateDir: root,
    conversationDir: path.join(root, "conversations"),
    writerLeaseFile: path.join(continuityDir, ".jobs", "writer.lease"),
    closeoutAutomationLeaseFile: path.join(continuityDir, ".jobs", "closeout.lease"),
    closeoutLivenessLeaseFile: path.join(continuityDir, ".jobs", "liveness.lease"),
    closeoutRetryStateFile: path.join(continuityDir, ".jobs", "retry.json"),
    closeoutLivenessStateFile: path.join(continuityDir, ".jobs", "liveness.json"),
    canonEpisodesFile: path.join(continuityDir, "episodes.jsonl"),
    recallLogFile: path.join(continuityDir, "recall_log.jsonl"),
    automationTimezone: "Australia/Sydney",
    nightlyCloseoutEnabled: false,
    nightlyCloseoutHour: 4,
    nightlyCloseoutMinute: 30,
    canonLivenessEnabled: false,
    canonLivenessThresholdHours: 48,
    recallLivenessEnabled: false,
    recallLivenessThresholdHours: 48,
    livenessStartupGraceMinutes: 30,
    livenessAlertCooldownHours: 24,
    livenessRecoveryEnabled: true,
    ...overrides,
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("configuration is off by default and rejects ambiguous values", () => {
  const keys = [
    "CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED",
    "CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR",
    "CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE",
    "CYBERBOSS_CANON_LIVENESS_THRESHOLD_HOURS",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const config = readConfig();
    assert.equal(config.nightlyCloseoutEnabled, false);
    assert.equal(config.canonLivenessEnabled, false);
    assert.equal(config.recallLivenessEnabled, false);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED = "maybe";
    assert.throws(() => readConfig(), /explicit boolean/);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED = "true";
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR = "24";
    assert.throws(() => readConfig(), /HOUR must be an integer/);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR = "-1";
    assert.throws(() => readConfig(), /HOUR must be an integer/);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR = "4abc";
    assert.throws(() => readConfig(), /HOUR must be an integer/);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR = "4";
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE = "60";
    assert.throws(() => readConfig(), /MINUTE must be an integer/);
    process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE = "-1";
    assert.throws(() => readConfig(), /MINUTE must be an integer/);
    delete process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR;
    delete process.env.CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE;
    process.env.CYBERBOSS_CANON_LIVENESS_THRESHOLD_HOURS = "-1";
    assert.throws(() => readConfig(), /THRESHOLD_HOURS must be an integer/);
    process.env.CYBERBOSS_CANON_LIVENESS_THRESHOLD_HOURS = "48abc";
    assert.throws(() => readConfig(), /THRESHOLD_HOURS must be an integer/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("Sydney schedule survives DST boundaries", () => {
  const springTarget = Date.parse("2026-10-03T17:30:00Z");
  const autumnTarget = Date.parse("2026-04-04T18:30:00Z");
  assert.equal(businessDateKey(springTarget, "Australia/Sydney"), "2026-10-03");
  assert.equal(isScheduleDue(springTarget, 4, 30, "Australia/Sydney"), true);
  assert.equal(nextScheduleAt(Date.parse("2026-10-03T16:00:00Z"), 4, 30, "Australia/Sydney"), springTarget);
  assert.equal(businessDateKey(autumnTarget, "Australia/Sydney"), "2026-04-04");
  assert.equal(isScheduleDue(autumnTarget, 4, 30, "Australia/Sydney"), true);
});

test("liveness reads record timestamps rather than file mtime and tolerates a partial tail", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");
  const finding = inspectJsonl({
    key: "canon",
    filePath: "episodes.jsonl",
    now,
    thresholdHours: 48,
    fsImpl: {
      readFileSync() { return '{"ts":"2026-07-20T00:00:00Z"}\n{"ts":"2026-07-21T00:00:00Z"}\n{"partial"'; },
    },
  });
  assert.equal(finding.status, "stale");
  assert.equal(finding.latestRecordAt, Date.parse("2026-07-21T00:00:00Z"));
  assert.equal(finding.tailPartial, true);
});

test("missing, empty, corrupt, and unreadable JSONL remain distinct", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");
  const make = (raw, error) => inspectJsonl({
    key: "recall",
    filePath: "recall.jsonl",
    now,
    fsImpl: { readFileSync() { if (error) throw Object.assign(new Error("read"), { code: error }); return raw; } },
  });
  assert.equal(make("", null).status, "empty");
  assert.equal(make("{bad}\n", null).status, "corrupt");
  assert.equal(make("", "EACCES").status, "unreadable");
  assert.equal(make("", "ENOENT").status, "missing");
});

test("two closeout owners can claim only one Sydney business date", async () => {
  const root = tempRoot();
  try {
    let calls = 0;
    const config = baseConfig(root, { nightlyCloseoutEnabled: true });
    const runner = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { status: "success" };
    };
    const first = new CloseoutLivenessAutomation({ config, closeoutRunner: runner });
    const second = new CloseoutLivenessAutomation({ config, closeoutRunner: runner });
    const now = Date.parse("2026-07-25T00:00:00Z");
    const results = await Promise.all([first.tick(now), second.tick(now)]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map((item) => item.closeout.status).sort(), ["skipped", "success"]);
    const retryState = JSON.parse(fs.readFileSync(config.closeoutRetryStateFile, "utf8"));
    assert.equal(retryState.closeout["2026-07-24"].status, "success");
  } finally {
    cleanup(root);
  }
});

test("automation owner is idempotent, uses one timer, and stops cleanly", async () => {
  const root = tempRoot();
  try {
    const callbacks = new Map();
    let nextId = 1;
    let cleared = 0;
    const timers = {
      setTimeout(callback, delay) { const id = nextId++; callbacks.set(id, { callback, delay }); return id; },
      clearTimeout(id) { if (callbacks.delete(id)) cleared += 1; },
    };
    const config = baseConfig(root, { nightlyCloseoutEnabled: true });
    const owner = new CloseoutLivenessAutomation({
      config,
      timers,
      clock: { now: () => Date.parse("2026-07-25T00:00:00Z") },
      closeoutRunner: async () => ({ status: "success" }),
    });
    assert.equal(owner.start(), true);
    assert.equal(owner.start(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks.size, 1);
    await owner.stop();
    assert.equal(cleared, 1);
  } finally {
    cleanup(root);
  }
});

test("closeout failure retries with durable backoff and never records false success", async () => {
  const root = tempRoot();
  try {
    let calls = 0;
    const config = baseConfig(root, { nightlyCloseoutEnabled: true });
    const owner = new CloseoutLivenessAutomation({ config, retryDelayMs: 60_000, closeoutRunner: async () => { calls += 1; throw new Error("boom"); } });
    const now = Date.parse("2026-07-25T00:00:00Z");
    await assert.rejects(owner.runCloseout(now), /boom/);
    assert.equal(calls, 1);
    const skipped = await owner.runCloseout(now + 1_000);
    assert.equal(skipped.reason, "retry_backoff");
    const state = JSON.parse(fs.readFileSync(config.closeoutRetryStateFile, "utf8"));
    assert.equal(state.closeout["2026-07-24"].status, "failed");
    assert.equal(state.closeout["2026-07-24"].attempts, 1);
  } finally {
    cleanup(root);
  }
});

test("canon and recall alerts have independent thresholds, cooldown, and one recovery", async () => {
  const root = tempRoot();
  try {
    const now = Date.parse("2026-07-25T00:00:00Z");
    const config = baseConfig(root, {
      canonLivenessEnabled: true,
      recallLivenessEnabled: true,
      canonLivenessThresholdHours: 48,
      recallLivenessThresholdHours: 200,
      livenessStartupGraceMinutes: 0,
    });
    fs.mkdirSync(path.dirname(config.canonEpisodesFile), { recursive: true });
    fs.writeFileSync(config.canonEpisodesFile, JSON.stringify({ ts: "2026-07-20T00:00:00Z" }) + "\n");
    fs.writeFileSync(config.recallLogFile, JSON.stringify({ ts: "2026-07-24T00:00:00Z" }) + "\n");
    const queue = { messages: [], enqueue(message) { this.messages.push(message); } };
    const owner = new CloseoutLivenessAutomation({ config, queueStore: queue, accountId: "telegram", senderId: "42", workspaceRoot: root });
    const first = await owner.runLivenessChecks(now);
    assert.equal(first.find((item) => item.finding.key === "canon").queued, true);
    assert.equal(first.find((item) => item.finding.key === "recall").queued, false);
    assert.equal(queue.messages.length, 1);
    await owner.runLivenessChecks(now + 60 * 60 * 1000);
    assert.equal(queue.messages.length, 1);
    owner.markAlertDelivered(queue.messages[0]);
    fs.writeFileSync(config.canonEpisodesFile, JSON.stringify({ ts: new Date(now + 2 * 60 * 60 * 1000).toISOString() }) + "\n");
    const recovered = await owner.runLivenessChecks(now + 2 * 60 * 60 * 1000);
    assert.equal(recovered.find((item) => item.finding.key === "canon").queued, true);
    assert.equal(queue.messages.length, 2);
    owner.markAlertDelivered(queue.messages[1]);
    await owner.runLivenessChecks(now + 3 * 60 * 60 * 1000);
    assert.equal(queue.messages.length, 2);
    const state = JSON.parse(fs.readFileSync(config.closeoutLivenessStateFile, "utf8"));
    assert.equal(state.checks.canon.last_alerted_at !== null, true);
    assert.equal(state.checks.canon.recovery_alerted_at !== null, true);
  } finally {
    cleanup(root);
  }
});

test("startup grace suppresses no-data alerts but not explicit corruption", async () => {
  const root = tempRoot();
  try {
    const now = Date.parse("2026-07-25T00:00:00Z");
    const config = baseConfig(root, { recallLivenessEnabled: true, livenessStartupGraceMinutes: 30 });
    const queue = { messages: [], enqueue(message) { this.messages.push(message); } };
    const owner = new CloseoutLivenessAutomation({ config, queueStore: queue, accountId: "telegram", senderId: "42", workspaceRoot: root });
    await owner.runLivenessChecks(now);
    assert.equal(queue.messages.length, 0);
    fs.writeFileSync(config.recallLogFile, "{broken}\n");
    await owner.runLivenessChecks(now + 60_000);
    assert.equal(queue.messages.length, 1);
  } finally {
    cleanup(root);
  }
});

test("liveness uses the existing system-message Telegram path", () => {
  const prepared = buildSystemInboundText("⚠️ canon episodes 当前为 jsonl_corrupt", new Date().toISOString(), "liveness_alert", "failure");
  assert.match(prepared, /existing Telegram reply path/);
  assert.match(prepared, /Do not write episodes, canon, recall_log/);
});
