const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  loadReleaseDescriptor,
  rollbackReleaseDescriptor,
  validateReleaseDescriptor,
} = require("../src/orchestration/release-descriptor");

function descriptor(root) {
  const activeState = path.join(root, "active-state");
  const oldState = path.join(root, "old-state");
  return {
    active_release_id: "phase1",
    telegram_entry: path.join(root, "phase1", "bin", "cyberboss.js"),
    config_dir: path.join(root, "active-config"),
    state_dir: activeState,
    log_dir: path.join(root, "active-logs"),
    pid_file: path.join(activeState, "cyberboss.pid"),
    watchdog_target: path.join(root, "phase1", "start-safe.ps1"),
    workspace_dir: path.join(root, "workspace"),
    rollback_release: {
      release_id: "legacy",
      telegram_entry: path.join(root, "legacy", "bin", "cyberboss.js"),
      config_dir: path.join(root, "old-config"),
      state_dir: oldState,
      log_dir: path.join(root, "old-logs"),
      pid_file: path.join(oldState, "cyberboss.pid"),
      watchdog_target: path.join(root, "legacy", "start-safe.ps1"),
      workspace_dir: path.join(root, "workspace"),
      last_verified_sha: "1".repeat(40),
    },
    last_verified_sha: "2".repeat(40),
  };
}

test("release descriptor rejects a PID file outside its release state directory", () => {
  const value = descriptor(os.tmpdir());
  value.pid_file = path.join(os.tmpdir(), "somewhere-else", "cyberboss.pid");
  const result = validateReleaseDescriptor(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /pid_file must belong/);
});

test("release descriptor rejects embedded token or env content", () => {
  const value = descriptor(os.tmpdir());
  value.telegram_bot_token = "must-not-be-stored";
  const result = validateReleaseDescriptor(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /sensitive value/);
});

test("rollback atomically promotes rollback release and preserves reverse rollback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-release-"));
  const file = path.join(root, "current.json");
  fs.writeFileSync(file, JSON.stringify(descriptor(root)), "utf8");
  const next = rollbackReleaseDescriptor(file);
  assert.equal(next.active_release_id, "legacy");
  assert.equal(next.rollback_release.release_id, "phase1");
  assert.equal(loadReleaseDescriptor(file).active_release_id, "legacy");
});

test("watchdog is release-only and can parse its CLI", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.doesNotMatch(source, /getUpdates|dashboard-hidden|wechat-hidden|TARGETS\s*=/i);
  assert.match(source, /deployment.*current\.json|DEFAULT_DESCRIPTOR/s);
  const python = process.env.PYTHON || "python";
  const result = spawnSync(python, [path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("dashboard is isolated from TG watchdog and automatic memory writes remain disabled", () => {
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "memory-kit", "dashboard.py"), "utf8");
  assert.match(dashboard, /AUTO_JANITOR_HOURS\s*=\s*0/);
  const watchdog = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.doesNotMatch(watchdog, /dashboard/i);
});
