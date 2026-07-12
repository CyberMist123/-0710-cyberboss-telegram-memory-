const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { formatReadableTime, formatReadableTimesInText } = require("../src/core/readable-time");
const { authorCloseout } = require("../src/continuity/background-author");
const { searchEpisodes } = require("../src/services/memory-lookup-service");

test("readable time removes T, seconds, and timezone suffix without converting the clock", () => {
  assert.equal(formatReadableTime("2026-07-11T23:59:59+08:00"), "2026-07-11 23:59");
  assert.equal(formatReadableTime("2026-07-11T15:59:59.123Z"), "2026-07-11 15:59");
  assert.equal(formatReadableTime("2026-07-11 23:59:59"), "2026-07-11 23:59");
  assert.equal(formatReadableTime("2026-07-11"), "2026-07-11");
  assert.equal(formatReadableTime("unknown"), "unknown");
});

test("readable time rewrites ISO timestamps inside model-facing text", () => {
  const input = "[2026-07-11T23:59:59+08:00] user: hello\n[2026-07-12T00:01:03.200+08:00] assistant: hi";
  assert.equal(
    formatReadableTimesInText(input),
    "[2026-07-11 23:59] user: hello\n[2026-07-12 00:01] assistant: hi",
  );
});

test("closeout prompt receives readable timestamps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-readable-time-"));
  const promptFile = path.join(root, "persona.md");
  fs.writeFileSync(promptFile, "persona", "utf8");
  let captured = null;
  await authorCloseout({
    runtimeAdapter: {
      async runBackgroundTurn(payload) {
        captured = payload.text;
        return JSON.stringify({ episodes: [], self_note: "", reentry_draft: "" });
      },
    },
    config: {
      workspaceRoot: root,
      runtime: "claudecode",
      claudeModel: "fixture",
      weixinInstructionsFile: promptFile,
      reentryAuthoringMode: "ai_direct",
    },
    materials: "[2026-07-11T23:59:59+08:00] user: hello",
  });
  assert.match(captured, /\[2026-07-11 23:59\] user: hello/u);
  assert.doesNotMatch(captured, /T23:59:59\+08:00/u);
});

test("memory lookup returns readable episode timestamps", () => {
  const hits = searchEpisodes([
    { ep_id: "ep-1", ts: "2026-07-11T23:59:59+08:00", body: "anchor memory" },
  ], "anchor");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ts, "2026-07-11 23:59");
});
