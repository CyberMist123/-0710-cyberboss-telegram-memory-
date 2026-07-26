const test = require("node:test");
const assert = require("node:assert/strict");
const { collectStatus, formatStatus, resolveProcessDirectory } = require("../scripts/status");

// R4 F1.3(c): these fixtures assert Windows command-line path parsing.
// resolveProcessDirectory is Windows-only by construction, so the honest guard
// is a skip on other platforms — CI runs them for real on windows-latest.
const IS_WINDOWS = process.platform === "win32";

test("status recognizes official Telegram runtime and separates legacy app-server", { skip: !IS_WINDOWS }, () => {
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
    { pid: 99, commandLine: 'node C:\\Users\\18717\\Documents\\cyberlink\\cyberboss\\bin\\cyberboss.js start' }, // PORTABILITY_FIXTURE
    { pid: 101, commandLine: 'node "C:\\Users\\18717\\Documents\\cyberlink\\runtime\\app\\telegram\\bin\\cyberboss.js" start' }, // PORTABILITY_FIXTURE
    { pid: 102, commandLine: 'powershell -File C:\\runtime\\watchdog\\cyberboss-watchdog.ps1' },
    { pid: 103, commandLine: 'node C:\\runtime\\mcp-stdio-server.js' },
  ]});
  assert.equal(status.directory, "C:\\Users\\18717\\Documents\\cyberlink\\runtime\\app\\telegram\\bin"); // PORTABILITY_FIXTURE
  assert.equal(status.commitsBehindMain, 5);
  assert.deepEqual(Object.fromEntries(Object.entries(status.services).map(([key, value]) => [key, value.alive])), {
    runtime: true, legacy: true, watchdog: true, mcp: true, nginx: false,
  });
  assert.equal(status.services.runtime.mode, undefined);
  assert.equal(status.services.legacy.mode, "legacy");
  assert.match(formatStatus(status), /nginx: DOWN .*containerized, use docker ps/);
  assert.match(formatStatus(status), /Commits behind main: 5/);
});

test("status reports nginx as containerized when docker exposes an nginx container", () => {
  const status = collectStatus({ run: (_command, args) => {
    if (args.includes("--show-current")) return "feat/q3-status-script";
    if (args.includes("--short") && args.includes("HEAD")) return "abc1234";
    if (args.includes("origin/main") && args.includes("rev-parse")) return "def5678";
    if (args.includes("docker")) return "cyberboss-nginx\n";
    return "0 0";
  }, processSnapshot: [
    { pid: 501, commandLine: 'docker ps --filter name=cyberboss-nginx' },
  ]});
  assert.deepEqual(status.services.nginx, {
    alive: true, pid: 501, mode: "containerized", message: "containerized (docker)",
  });
  assert.match(formatStatus(status), /nginx: UP \(PID 501\) — containerized \(docker\)/);
});

test("missing process is reported down and paths are parsed", { skip: !IS_WINDOWS }, () => {
  assert.equal(resolveProcessDirectory('node "D:\\release\\bin\\cyberboss.js"'), "D:\\release\\bin");
  const status = collectStatus({ run: () => "", processSnapshot: [] });
  assert.equal(status.services.runtime.alive, false);
  assert.match(status.directory, /not found/);
});
