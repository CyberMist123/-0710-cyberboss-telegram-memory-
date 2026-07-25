const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

// NOTE: these are Windows integration tests. They spawn real background
// `powershell.exe` processes with a crafted command line so that
// Test-ExistingTelegramPoller (Win32_Process based) can be exercised against
// a real, queryable process, and they invoke the actual candidate launcher
// script via `powershell.exe -File`. They can only run on a Windows host
// with PowerShell on PATH; on any other platform every test is skipped.

const LAUNCHER = path.join(__dirname, "..", "scripts", "windows", "runtime-startup", "stable-telegram-launcher.candidate.ps1");
const IS_WINDOWS = process.platform === "win32";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-launcher-"));
}

function makeReleaseFiles(root, name) {
  const releaseDir = path.join(root, name);
  const bin = path.join(releaseDir, "bin");
  const launcherDir = path.join(releaseDir, "extensions", "windows-launcher");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(launcherDir, { recursive: true });
  const entry = path.join(bin, "cyberboss.js");
  const watchdogTarget = path.join(launcherDir, "start-safe.ps1");
  fs.writeFileSync(entry, "// dummy entry\n", "utf8");
  fs.writeFileSync(watchdogTarget, "Write-Output 'dummy watchdog'\n", "utf8");
  return { releaseDir, entry, watchdogTarget };
}

function makeTarget(root, name) {
  const { entry, watchdogTarget } = makeReleaseFiles(root, name);
  const configDir = path.join(root, `${name}-config`);
  const stateDir = path.join(root, `${name}-state`);
  const logDir = path.join(root, `${name}-logs`);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  return {
    telegram_entry: entry,
    config_dir: configDir,
    state_dir: stateDir,
    log_dir: logDir,
    pid_file: path.join(stateDir, "cyberboss.pid"),
    watchdog_target: watchdogTarget,
  };
}

function baseDescriptor(root) {
  const active = makeTarget(root, "active-release");
  const rollback = makeTarget(root, "rollback-release");
  return {
    active_release_id: "active-release",
    ...active,
    workspace_dir: root,
    last_verified_sha: "1".repeat(40),
    rollback_release: {
      release_id: "rollback-release",
      ...rollback,
      last_verified_sha: "2".repeat(40),
    },
  };
}

function writeDescriptor(root, value, options = {}) {
  const file = path.join(root, "current.json");
  const json = JSON.stringify(value, null, 2);
  if (options.withBom) {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]));
  } else {
    fs.writeFileSync(file, json, "utf8");
  }
  return file;
}

function runLauncher(descriptorFile) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", LAUNCHER, "-DescriptorPath", descriptorFile, "-DryRun"],
    { encoding: "utf8", timeout: 20000 }
  );
}

// Spawns a real, idling powershell.exe whose reported Win32 CommandLine is
// (approximately): powershell.exe ... -Command "<scriptBlock>" "<entryPath>" "start" ["--flag"]
// so Get-CimInstance-based detection can be exercised against a genuine
// process without ever actually invoking cyberboss.js.
function spawnFakePoller(entryPath, extraArgs = []) {
  const fakeScript = path.join(os.tmpdir(), "cyberboss-stable-launcher-idle.ps1");
  if (!fs.existsSync(fakeScript)) {
    fs.writeFileSync(fakeScript, "param($entry,$mode,$flag)\nStart-Sleep -Seconds 30\n", "utf8");
  }
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-File",
    fakeScript,
    entryPath,
    "start",
    ...extraArgs,
  ];
  const child = spawn("powershell.exe", args, { stdio: "ignore" });
  return child;
}

async function withFakePoller(entryPath, extraArgs, fn) {
  const child = spawnFakePoller(entryPath, extraArgs);
  try {
    // Give WMI/Win32_Process a moment to register the new process.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fn(child.pid);
  } finally {
    try { child.kill(); } catch { /* best effort cleanup */ }
  }
}

test("correct active poller exists: no-op, nothing started", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  await withFakePoller(descriptor.telegram_entry, [], async () => {
    const result = runLauncher(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already (running|exists)/i);
    assert.doesNotMatch(result.stdout, /DRY-RUN/);
  });
});

test("only an old release poller is running: must not be misidentified as active", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  const oldRelease = makeReleaseFiles(root, "old-release");
  await withFakePoller(oldRelease.entry, [], async () => {
    const result = runLauncher(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
  });
});

test("only a `start --checkin` process is running: must enter the dry-run start path", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  await withFakePoller(descriptor.telegram_entry, ["--checkin"], async () => {
    const result = runLauncher(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
  });
});

test("same-named cyberboss.js in a different directory running `start`: must not be misidentified", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  const other = makeReleaseFiles(root, "other-directory-release");
  await withFakePoller(other.entry, [], async () => {
    const result = runLauncher(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
  });
});

test("stale PID file (process not running): must enter the dry-run start path", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  // A PID essentially guaranteed not to be a live process on the test host.
  fs.writeFileSync(descriptor.pid_file, "999999", "utf8");
  const file = writeDescriptor(root, descriptor);
  const result = runLauncher(file);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY-RUN/);
});

test("PID file points at a `start --checkin` process: must enter the dry-run start path", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  await withFakePoller(descriptor.telegram_entry, ["--checkin"], async (pid) => {
    fs.writeFileSync(descriptor.pid_file, String(pid), "utf8");
    const result = runLauncher(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
  });
});

test("active entry missing from descriptor: fails", { skip: !IS_WINDOWS }, () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  delete descriptor.telegram_entry;
  const file = writeDescriptor(root, descriptor);
  const result = runLauncher(file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Descriptor field missing: telegram_entry/);
});

test("descriptor has a UTF-8 BOM: fails", { skip: !IS_WINDOWS }, () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor, { withBom: true });
  const result = runLauncher(file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOM/);
});

test("multiple exact active pollers: fail closed", { skip: !IS_WINDOWS }, async () => {
  const root = tempRoot();
  const descriptor = baseDescriptor(root);
  const file = writeDescriptor(root, descriptor);
  const first = spawnFakePoller(descriptor.telegram_entry, []);
  const second = spawnFakePoller(descriptor.telegram_entry, []);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = runLauncher(file);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Multiple exact active Telegram pollers/);
  } finally {
    try { first.kill(); } catch { /* best effort cleanup */ }
    try { second.kill(); } catch { /* best effort cleanup */ }
  }
});
