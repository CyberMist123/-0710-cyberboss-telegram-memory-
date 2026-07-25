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

function materializeTarget(value) {
  for (const directory of [value.config_dir, value.state_dir, value.log_dir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(path.dirname(value.telegram_entry), { recursive: true });
  fs.writeFileSync(value.telegram_entry, "// entry\n", "utf8");
  fs.writeFileSync(value.watchdog_target, "# watchdog\n", "utf8");
  fs.writeFileSync(value.pid_file, "0\n", "utf8");
}

function materializeDescriptor(value) {
  materializeTarget(value);
  materializeTarget(value.rollback_release);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-release-"));
}

test("complete active and rollback descriptors pass strict existing-path validation", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  assert.equal(validateReleaseDescriptor(value, { requireExistingPaths: true }).ok, true);
});

test("release descriptor rejects a PID file outside its release state directory", () => {
  const value = descriptor(tempRoot());
  value.pid_file = path.join(os.tmpdir(), "somewhere-else", "cyberboss.pid");
  const result = validateReleaseDescriptor(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /active\.pid_file: must belong/);
});

test("strict validation reports active missing entry without exposing values", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  fs.unlinkSync(value.telegram_entry);
  value.telegram_bot_token = "never-print-this";
  const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
  const errors = result.errors.join("\n");
  assert.equal(result.ok, false);
  assert.match(errors, /active\.telegram_entry: does not exist/);
  assert.match(errors, /sensitive value/);
  assert.doesNotMatch(errors, /never-print-this/);
});

test("strict validation rejects rollback missing entry or watchdog target", () => {
  for (const field of ["telegram_entry", "watchdog_target"]) {
    const value = descriptor(tempRoot());
    materializeDescriptor(value);
    fs.unlinkSync(value.rollback_release[field]);
    const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`rollback\\.${field}: does not exist`));
  }
});

test("strict validation rejects rollback missing state, log, or PID path", () => {
  for (const field of ["state_dir", "log_dir", "pid_file"]) {
    const value = descriptor(tempRoot());
    materializeDescriptor(value);
    fs.rmSync(value.rollback_release[field], { recursive: field !== "pid_file", force: true });
    const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`rollback\\.${field}: does not exist`));
  }
});

test("descriptor rejects a UTF-8 BOM with a clear error", () => {
  const root = tempRoot();
  const value = descriptor(root);
  materializeDescriptor(value);
  const file = path.join(root, "current.json");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(value))]));
  assert.throws(() => loadReleaseDescriptor(file), /UTF-8 without BOM/);
});

test("descriptor rejects SHA and release identity mismatches", () => {
  const invalidSha = descriptor(tempRoot());
  invalidSha.rollback_release.last_verified_sha = "not-a-sha";
  assert.match(validateReleaseDescriptor(invalidSha).errors.join("\n"), /rollback\.last_verified_sha/);

  const duplicateIdentity = descriptor(tempRoot());
  duplicateIdentity.rollback_release.release_id = duplicateIdentity.active_release_id;
  assert.match(validateReleaseDescriptor(duplicateIdentity).errors.join("\n"), /release_id.*distinct/);
});

test("descriptor rejects state, log, and PID paths inside a release directory", () => {
  for (const field of ["state_dir", "log_dir", "pid_file"]) {
    const value = descriptor(tempRoot());
    value[field] = path.join(path.dirname(path.dirname(value.telegram_entry)), field);
    if (field === "pid_file") value.pid_file = path.join(path.dirname(path.dirname(value.telegram_entry)), "pid-state", "cyberboss.pid");
    const result = validateReleaseDescriptor(value);
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`active\\.${field}: must be outside`));
  }
});

test("rollback atomically promotes a fully preflighted rollback release", () => {
  const root = tempRoot();
  const file = path.join(root, "current.json");
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  const next = rollbackReleaseDescriptor(file);
  assert.equal(next.active_release_id, "legacy");
  assert.equal(next.rollback_release.release_id, "phase1");
  assert.equal(loadReleaseDescriptor(file, { requireExistingPaths: true }).active_release_id, "legacy");
});

test("rollback activation preflight refuses to replace the current descriptor when a target is missing", () => {
  const root = tempRoot();
  const file = path.join(root, "current.json");
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.unlinkSync(value.rollback_release.watchdog_target);
  const original = JSON.stringify(value);
  fs.writeFileSync(file, original, "utf8");
  assert.throws(() => rollbackReleaseDescriptor(file), /rollback\.watchdog_target: does not exist/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

function manifestForWriter(root, descriptorPath) {
  const value = descriptor(root);
  materializeDescriptor(value);
  return {
    telegram: {
      descriptor_path: descriptorPath,
      release_id: value.active_release_id,
      entry: value.telegram_entry,
      config_dir: value.config_dir,
      state_dir: value.state_dir,
      log_dir: value.log_dir,
      pid_file: value.pid_file,
      watchdog_target: value.watchdog_target,
    },
    dashboard: { app_root: path.dirname(path.dirname(value.telegram_entry)) },
    watchdog: { owner_dir: path.join(root, "watchdog-owner") },
    workspace_root: value.workspace_dir,
    formal_repo: { commit: value.last_verified_sha },
    rollback: value.rollback_release,
  };
}

function runWriter(manifest) {
  const script = path.join(__dirname, "..", "scripts", "windows", "cyberlink-manifest.ps1");
  const command = `. '${script.replace(/'/g, "''")}'; $manifest = $env:CYBERBOSS_TEST_MANIFEST | ConvertFrom-Json; Write-TelegramDescriptor -Manifest $manifest`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, CYBERBOSS_TEST_MANIFEST: JSON.stringify(manifest) },
  });
}

test("manifest writer atomically replaces a descriptor as UTF-8 without BOM", () => {
  const root = tempRoot();
  const descriptorPath = path.join(root, "external", "current.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, '{"old":true}\n', "utf8");
  const result = runWriter(manifestForWriter(root, descriptorPath));
  assert.equal(result.status, 0, result.stderr);
  const raw = fs.readFileSync(descriptorPath);
  assert.equal(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(loadReleaseDescriptor(descriptorPath, { requireExistingPaths: true }).active_release_id, "phase1");
  assert.equal(fs.readdirSync(path.dirname(descriptorPath)).filter((name) => /\.(tmp|bak)$/.test(name)).length, 0);
});

test("manifest writer preserves the old descriptor and cleans temp files when preflight fails", () => {
  const root = tempRoot();
  const descriptorPath = path.join(root, "external", "current.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const old = '{"old":true}\n';
  fs.writeFileSync(descriptorPath, old, "utf8");
  const manifest = manifestForWriter(root, descriptorPath);
  manifest.rollback.telegram_entry = path.join(root, "legacy", "bin", "missing-cyberboss.js");
  const result = runWriter(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback\.telegram_entry does not exist/);
  assert.equal(fs.readFileSync(descriptorPath, "utf8"), old);
  assert.equal(fs.readdirSync(path.dirname(descriptorPath)).filter((name) => /\.(tmp|bak)$/.test(name)).length, 0);
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
