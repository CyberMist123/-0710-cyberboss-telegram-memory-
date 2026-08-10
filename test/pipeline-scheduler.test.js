const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PipelineScheduler, buildMemoryReceiptText } = require("../src/app/pipeline-scheduler");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SystemMessageDispatcher, buildSystemInboundText } = require("../src/core/system-message-dispatcher");
const { writeActivityPauseState } = require("../src/core/activity-pause-state");

function fixture({ candidates = [candidate()] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-scheduler-"));
  const candidatesFile = path.join(root, "candidates.jsonl");
  fs.writeFileSync(candidatesFile, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""), "utf8");
  const pipeline = {
    continuityDir: root,
    paths: { candidates: candidatesFile, episodes: path.join(root, "episodes.jsonl") },
    runHistoryWriter() { return { status: "success", written: ["dec-1"] }; },
  };
  const queue = new SystemMessageQueueStore({ filePath: path.join(root, "queue.json") });
  const config = { pipelineScheduleEnabled: false, pipelineIntervalMinutes: 60, memoryReceiptEnabled: true, activityPauseFile: path.join(root, "pause.json") };
  return { root, pipeline, queue, config };
}

function candidate(overrides = {}) {
  return {
    candidate_id: "cand-1",
    ts: "2026-08-09T00:00:00.000Z",
    body: "虚构标题\n虚构正文。",
    ...overrides,
  };
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

function scheduler(value, overrides = {}) {
  return new PipelineScheduler({
    config: value.config,
    pipeline: value.pipeline,
    queueStore: value.queue,
    accountId: "fixture-account",
    senderId: "fixture-sender",
    workspaceRoot: value.root,
    runReview: () => ({ status: "success", decisions: [{ candidate_id: "cand-1", decision_id: "dec-1", result: "accepted" }] }),
    ...overrides,
  });
}

test("pipeline scheduler defaults off with no timer or pipeline work", async () => {
  const value = fixture();
  try {
    let timers = 0;
    const owner = scheduler(value, { timers: { setTimeout() { timers += 1; return timers; }, clearTimeout() {} } });
    assert.equal(owner.start(), false);
    assert.equal(timers, 0);
    await owner.stop();
  } finally { cleanup(value.root); }
});

test("pipeline scheduler runs review then history at its interval", async () => {
  const value = fixture();
  try {
    value.config.pipelineScheduleEnabled = true;
    const calls = [];
    value.pipeline.runHistoryWriter = () => { calls.push("history"); return { status: "success", written: ["dec-1"] }; };
    const owner = scheduler(value, { runReview: () => { calls.push("review"); return { status: "success", decisions: [{ candidate_id: "cand-1", decision_id: "dec-1", result: "accepted" }] }; } });
    const result = await owner.tick();
    assert.equal(result.status, "success");
    assert.deepEqual(calls, ["review", "history"]);
    assert.equal(value.queue.drainForAccount("fixture-account").length, 1);
  } finally { cleanup(value.root); }
});

test("pipeline scheduler skips a lease-conflicted review and keeps the process alive", async () => {
  const value = fixture();
  try {
    value.config.pipelineScheduleEnabled = true;
    let historyRuns = 0;
    value.pipeline.runHistoryWriter = () => { historyRuns += 1; return { status: "success", written: [] }; };
    const result = await scheduler(value, { runReview: () => ({ status: "skipped", reason: "writer_lease_unavailable" }) }).tick();
    assert.equal(result.reason, "writer_lease_unavailable");
    assert.equal(historyRuns, 0);
  } finally { cleanup(value.root); }
});

test("pipeline scheduler catches a thrown pipeline error", async () => {
  const value = fixture();
  try {
    value.config.pipelineScheduleEnabled = true;
    const result = await scheduler(value, { runReview: () => { throw new Error("fixture failure"); } }).tick();
    assert.equal(result.reason, "review_error");
  } finally { cleanup(value.root); }
});

test("pipeline scheduler uses a 60-second retry for an overdue timer", async () => {
  const value = fixture();
  try {
    value.config.pipelineScheduleEnabled = true;
    const delays = [];
    const owner = scheduler(value, {
      nextRunAt: 0,
      clock: { now: () => 1 },
      timers: { setTimeout(fn, ms) { delays.push(ms); return delays.length; }, clearTimeout() {} },
    });
    assert.equal(owner.start(), true);
    assert.deepEqual(delays, [60_000]);
    await owner.stop();
  } finally { cleanup(value.root); }
});

test("memory receipts use terminal accepted/rejected wording, merge, dedupe, and respect pause", () => {
  const value = fixture({ candidates: [candidate(), candidate({ candidate_id: "cand-2", body: "另一条\n正文" })] });
  try {
    fs.mkdirSync(path.join(value.root, "episodes"));
    fs.writeFileSync(path.join(value.root, "episodes", "ep001-fixture.md"), ["---", "seq: ep001", "candidate_id: \"cand-1\"", "---"].join("\n"));
    const text = buildMemoryReceiptText({
      pipeline: value.pipeline,
      candidates: [candidate(), candidate({ candidate_id: "cand-2", body: "另一条\n正文" })],
      decisions: [
        { candidate_id: "cand-1", decision_id: "dec-1", result: "accepted" },
        { candidate_id: "cand-2", decision_id: "dec-2", result: "rejected", reason: "source_ref_missing" },
      ],
      written: ["dec-1"],
    });
    assert.match(text, /已经入册（ep001）/u);
    assert.match(text, /审核没过（source_ref_missing）/u);
    const owner = scheduler(value);
    assert.equal(owner.enqueueReceipt({ pipeline: value.pipeline, candidates: [candidate()], review: { decisions: [{ candidate_id: "cand-1", decision_id: "dec-1", result: "accepted" }] }, history: { written: ["dec-1"] } }).status, "queued");
    assert.equal(owner.enqueueReceipt({ pipeline: value.pipeline, candidates: [candidate()], review: { decisions: [{ candidate_id: "cand-1", decision_id: "dec-1", result: "accepted" }] }, history: { written: ["dec-1"] } }).reason, "overlap");
    writeActivityPauseState(value.config.activityPauseFile, true);
    const dispatcher = new SystemMessageDispatcher({ queueStore: value.queue, config: value.config, accountId: "fixture-account" });
    assert.equal(dispatcher.drainPending().length, 0);
    assert.match(buildSystemInboundText("fixture receipt", "", "memory_receipt"), /send the receipt below exactly once/i);
  } finally { cleanup(value.root); }
});
