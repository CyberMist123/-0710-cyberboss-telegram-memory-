const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesireService } = require("../src/services/desire-service");
const { DRIVE_KEYS, persistReportedDesireState, readLatestDesireHistory } = require("../src/core/desire-state-persistence");

test("Desire sole writer appends an eight-dimensional dashboard history row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-history-"));
  const config = {
    desireStateFile: path.join(root, "desire-state.json"),
    desireHistoryFile: path.join(root, "desire-history.jsonl"),
    desireThoughtsFile: path.join(root, "desire-thoughts.json"),
    memoryDir: path.join(root, "memory"),
    desireDriven: false,
    desireThoughtMax: 80,
  };
  const service = new DesireService(config);
  assert.equal(fs.existsSync(config.desireStateFile), false);
  assert.equal(fs.existsSync(config.desireHistoryFile), false);
  service.save();

  const rows = fs.readFileSync(config.desireHistoryFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  for (const key of ["attachment", "curiosity", "reflection", "duty", "social", "fatigue", "libido", "stress"]) {
    assert.equal(typeof rows.at(-1)[key], "number");
  }
  assert.equal(rows.at(-1).note, "desire-runtime");
});

test("Claude reported octants persist realtime and one deduplicated history row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-octants-"));
  const stateFile = path.join(root, "desire-state.json");
  const historyFile = path.join(root, "desire-history.jsonl");
  const state = {
    most_want: "继续读书",
    drives: DRIVE_KEYS.map((key, index) => ({ key, label: `label-${key}`, score: (index + 1) / 10, change: "steady", cause: `cause-${key}` })),
  };
  const first = persistReportedDesireState({ state, stateFile, historyFile, now: "2026-07-12T06:00:00.000Z" });
  const duplicate = persistReportedDesireState({ state, stateFile, historyFile, now: "2026-07-12T06:00:01.000Z" });
  assert.equal(first.saved, true);
  assert.equal(duplicate.reason, "duplicate_report");
  const realtime = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(realtime.drives.length, 8);
  assert.equal(realtime.updatedAt, "2026-07-12T06:00:00.000Z");
  const rows = fs.readFileSync(historyFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "claude-runtime-reported");
  assert.equal(rows[0].attachment, 0.1);
  assert.equal(rows[0].stress, 0.8);
  assert.deepEqual(rows[0].drives[0], { key: "attachment", label: "label-attachment", score: 0.1, change: "steady", cause: "cause-attachment" });
});


test("latest desire history row can be read back for the next heartbeat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-history-read-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, [
    JSON.stringify({ time: "2026-07-12T05:00:00.000Z", most_want: "继续读书", attachment: 0.2 }),
    "not-json",
    JSON.stringify({ time: "2026-07-12T06:00:00.000Z", most_want: "去看看外面", social: 0.6, stress: 0.4 }),
  ].join("\n"), "utf8");

  assert.deepEqual(readLatestDesireHistory(historyFile), {
    time: "2026-07-12T06:00:00.000Z",
    most_want: "去看看外面",
    social: 0.6,
    stress: 0.4,
  });
});
