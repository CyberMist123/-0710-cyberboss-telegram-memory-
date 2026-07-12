const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCanary } = require("../src/orchestration/canary-runner");

test("canary runner verifies only appended local evidence and stores no message body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-canary-"));
  const source = path.join(root, "live.log");
  const statePath = path.join(root, "canary.json");
  fs.writeFileSync(source, "old message\n", "utf8");
  const pending = await runCanary({ statePath, sources: [source], timeoutMs: 1, pollIntervalMs: 1 });
  assert.equal(pending.status, "USER_ACTION_PENDING");
  fs.appendFileSync(source, `new metadata id=${pending.canary_id}\n`, "utf8");
  const verified = await runCanary({ statePath, sources: [source], resume: true, timeoutMs: 20, pollIntervalMs: 1 });
  assert.equal(verified.status, "VERIFIED");
  const stored = fs.readFileSync(statePath, "utf8");
  assert.doesNotMatch(stored, /old message|new metadata/);
});

test("canary runner source contains no Telegram polling client", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "orchestration", "canary-runner.js"), "utf8");
  assert.doesNotMatch(source, /getUpdates|api\.telegram\.org|Bot API/i);
});
