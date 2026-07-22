const test = require("node:test");
const assert = require("node:assert/strict");
const { collectStatus, formatStatus, resolveProcessDirectory } = require("../scripts/status");

test("status reports git state and all monitored services", () => {
  const values = new Map([
    ["branch", "feat/q3-status-script"],
    ["sha", "abc1234"],
    ["main", "def5678"],
    ["counts", "2 5"],
  ]);
  const run = (_command, args) => {
    const key = args.includes("--show-current") ? "branch"
      : args.includes("--short") && args.includes("HEAD") ? "sha"
        : args.includes("origin/main") && args.includes("rev-parse") ? "main" : "counts";
    return values.get(key) || "";
  };
  const status = collectStatus({ run, processSnapshot: [
    { pid: 101, commandLine: 'node "C:\\runtime\\app\\telegram\\bin\\cyberboss.js" start' },
    { pid: 102, commandLine: 'powershell -File C:\\runtime\\watchdog\\cyberboss-watchdog.ps1' },
    { pid: 103, commandLine: 'node C:\\runtime\\mcp-stdio-server.js' },
    { pid: 104, commandLine: 'C:\\nginx\\nginx.exe -p C:\\nginx' },
  ]});
  assert.equal(status.directory, "C:\\runtime\\app\\telegram\\bin");
  assert.equal(status.commitsBehindMain, 5);
  assert.deepEqual(Object.fromEntries(Object.entries(status.services).map(([key, value]) => [key, value.alive])), {
    runtime: true, watchdog: true, mcp: true, nginx: true,
  });
  assert.match(formatStatus(status), /Commits behind main: 5/);
});

test("missing process is reported down and paths are parsed", () => {
  assert.equal(resolveProcessDirectory('node "D:\\release\\bin\\cyberboss.js"'), "D:\\release\\bin");
  const status = collectStatus({ run: () => "", processSnapshot: [] });
  assert.equal(status.services.runtime.alive, false);
  assert.match(status.directory, /not found/);
});
