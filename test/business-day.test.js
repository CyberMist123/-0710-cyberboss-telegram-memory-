const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CloseoutLivenessAutomation } = require("../src/app/closeout-liveness");
const { ContinuityPipeline } = require("../src/continuity/continuity-pipeline");
const { weekKey } = require("../src/continuity/weekly-reflect");
const { ConversationRecorder } = require("../src/services/conversation-recorder");
const { formatDate, formatTime } = require("../src/services/diary-service");
const {
  businessDayForDate,
  resolveBusinessDay,
} = require("../src/utils/business-day");

const TIMEZONE = "Australia/Sydney";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-business-day-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createPipeline(root) {
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  fs.mkdirSync(conversationDir, { recursive: true });
  return new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile: path.join(continuityDir, ".jobs", "writer.lease.json"),
    reviewScript: __filename,
    worktree: root,
    automationTimezone: TIMEZONE,
  });
}

function writeConversation(pipeline, date, text = "晚到的真实材料") {
  fs.mkdirSync(pipeline.conversationDir, { recursive: true });
  fs.writeFileSync(path.join(pipeline.conversationDir, `${date}.jsonl`), [
    JSON.stringify({ type: "user", timestamp: `${date}T12:00:00Z`, text }),
    JSON.stringify({ type: "assistant", timestamp: `${date}T12:01:00Z`, text: "我在。" }),
  ].join("\n") + "\n", "utf8");
}

function automationConfig(root) {
  const continuityDir = path.join(root, "continuity");
  return {
    channel: "telegram",
    workspaceRoot: root,
    continuityDir,
    continuityBranch: "test",
    continuityWorktree: root,
    continuityBaseSha: "0".repeat(40),
    stateDir: root,
    conversationDir: path.join(root, "conversations"),
    closeoutAutomationLeaseFile: path.join(continuityDir, ".jobs", "automation.lease.json"),
    closeoutRetryStateFile: path.join(continuityDir, ".jobs", "retry.json"),
    automationTimezone: TIMEZONE,
    nightlyCloseoutEnabled: true,
    nightlyCloseoutHour: 4,
    nightlyCloseoutMinute: 30,
  };
}

test("DST business days are the previous complete Sydney local day", () => {
  const spring = resolveBusinessDay(TIMEZONE, "2026-10-03T17:30:00Z");
  assert.equal(spring.dateKey, "2026-10-03");
  assert.equal(spring.candidateTimestamp, "2026-10-03T13:59:59.000Z");

  const autumn = resolveBusinessDay(TIMEZONE, "2026-04-04T18:30:00Z");
  assert.equal(autumn.dateKey, "2026-04-04");
  assert.equal(autumn.candidateTimestamp, "2026-04-04T12:59:59.000Z");

  assert.equal(resolveBusinessDay("Not/A_Timezone", Date.now()), null);
});

test("conversation recorder and closeout agree across local midnight", (t) => {
  const root = tempRoot(t);
  const conversationDir = path.join(root, "conversations");
  const recorder = new ConversationRecorder({
    dirPath: conversationDir,
    automationTimezone: TIMEZONE,
  });
  recorder.record({ type: "user", timestamp: "2026-07-11T13:59:59Z", text: "before" });
  recorder.record({ type: "user", timestamp: "2026-07-11T14:00:00Z", text: "after" });

  assert.equal(fs.existsSync(path.join(conversationDir, "2026-07-11.jsonl")), true);
  assert.equal(fs.existsSync(path.join(conversationDir, "2026-07-12.jsonl")), true);
  assert.equal(
    resolveBusinessDay(TIMEZONE, "2026-07-11T14:05:00Z").dateKey,
    "2026-07-11",
  );
  assert.equal(formatDate("2026-07-11T14:00:00Z", TIMEZONE), "2026-07-12");
  assert.equal(formatTime("2026-07-11T14:00:00Z", TIMEZONE), "00:00");
  assert.equal(weekKey("2026-07-19T13:30:00Z", TIMEZONE), "2026-07-13");
  assert.equal(weekKey("2026-07-19T13:30:00Z", "Pacific/Auckland"), "2026-07-20");
});

test("late material remains retryable until the processing window closes", (t) => {
  const root = tempRoot(t);
  const pipeline = createPipeline(root);
  const date = "2026-07-11";
  let authorCalls = 0;

  const empty = pipeline.runCloseout({
    date,
    windowClosed: false,
    author: () => {
      authorCalls += 1;
      return {};
    },
  });
  assert.equal(empty.status, "retryable_no_output");
  assert.equal(empty.reason, "no_materials");
  assert.equal(authorCalls, 0);

  writeConversation(pipeline, date);
  const completed = pipeline.runCloseout({
    date,
    windowClosed: false,
    author: () => {
      authorCalls += 1;
      return { episodes: [{ body: "这条材料晚到了，但仍进入同一业务日候选。" }] };
    },
  });
  assert.equal(completed.status, "success");
  assert.equal(authorCalls, 1);
  assert.equal(completed.candidates[0].ts, businessDayForDate(date, TIMEZONE).candidateTimestamp);

  const sealedRoot = tempRoot(t);
  const sealedPipeline = createPipeline(sealedRoot);
  const sealed = sealedPipeline.runCloseout({ date, windowClosed: true, author: () => ({}) });
  assert.equal(sealed.status, "sealed_no_output");
  writeConversation(sealedPipeline, date, "窗口关闭后的材料");
  const afterSeal = sealedPipeline.runCloseout({
    date,
    windowClosed: true,
    author: () => {
      throw new Error("sealed day must not call the author");
    },
  });
  assert.equal(afterSeal.status, "sealed_no_output");
  assert.equal(afterSeal.reason, "already_ran");
});

test("restart retries durable and legacy no_output state without sealing the day", async (t) => {
  const root = tempRoot(t);
  const config = automationConfig(root);
  const now = Date.parse("2026-07-12T00:00:00Z");
  const firstPipeline = createPipeline(root);
  const firstOwner = new CloseoutLivenessAutomation({
    config,
    retryDelayMs: 1_000,
    closeoutRunner: ({ date, windowClosed }) => firstPipeline.runCloseout({
      date,
      windowClosed,
      author: () => ({ episodes: [] }),
    }),
  });

  const first = await firstOwner.runCloseout(now);
  assert.equal(first.status, "retryable_no_output");
  const date = "2026-07-11";
  const ledgerPath = path.join(config.continuityDir, ".jobs", `closeout-${date}.json`);
  const retryPath = config.closeoutRetryStateFile;

  const legacyLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  legacyLedger.status = "no_output";
  fs.writeFileSync(ledgerPath, JSON.stringify(legacyLedger, null, 2) + "\n", "utf8");
  const legacyRetry = JSON.parse(fs.readFileSync(retryPath, "utf8"));
  legacyRetry.closeout[date].status = "no_output";
  fs.writeFileSync(retryPath, JSON.stringify(legacyRetry, null, 2) + "\n", "utf8");

  writeConversation(firstPipeline, date, "重启后补到的材料");
  const restartedPipeline = createPipeline(root);
  let restartedCalls = 0;
  const restartedOwner = new CloseoutLivenessAutomation({
    config,
    retryDelayMs: 1_000,
    closeoutRunner: ({ date: targetDate, windowClosed }) => restartedPipeline.runCloseout({
      date: targetDate,
      windowClosed,
      author: () => {
        restartedCalls += 1;
        return { episodes: [{ body: "重启补跑成功。" }] };
      },
    }),
  });
  const recovered = await restartedOwner.runCloseout(now + 1_000);
  assert.equal(recovered.status, "success");
  assert.equal(restartedCalls, 1);
  const state = JSON.parse(fs.readFileSync(retryPath, "utf8"));
  assert.equal(state.closeout[date].status, "success");
});

test("same business day success is byte-idempotent", (t) => {
  const root = tempRoot(t);
  const pipeline = createPipeline(root);
  const date = "2026-07-11";
  writeConversation(pipeline, date);
  let authorCalls = 0;
  const run = () => pipeline.runCloseout({
    date,
    windowClosed: false,
    author: () => {
      authorCalls += 1;
      return { episodes: [{ body: "同日只写一次。" }] };
    },
  });

  assert.equal(run().status, "success");
  const before = {
    candidates: fs.readFileSync(pipeline.paths.candidates, "utf8"),
    ledger: fs.readFileSync(path.join(pipeline.paths.jobs, `closeout-${date}.json`), "utf8"),
  };
  const second = run();
  assert.equal(second.status, "success");
  assert.equal(second.reason, "already_ran");
  assert.equal(authorCalls, 1);
  assert.deepEqual({
    candidates: fs.readFileSync(pipeline.paths.candidates, "utf8"),
    ledger: fs.readFileSync(path.join(pipeline.paths.jobs, `closeout-${date}.json`), "utf8"),
  }, before);
});
