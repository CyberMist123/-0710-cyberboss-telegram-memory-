const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateReleaseDescriptor } = require("../src/orchestration/release-descriptor");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-owner-"));
}

function target(root, name) {
  const releaseDir = path.join(root, name);
  fs.mkdirSync(path.join(releaseDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "bin", "cyberboss.js"), "// entry\n", "utf8");
  fs.writeFileSync(path.join(releaseDir, "start-safe.ps1"), "# watchdog\n", "utf8");
  const stateDir = path.join(root, `${name}-state`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, `${name}-config`), { recursive: true });
  fs.mkdirSync(path.join(root, `${name}-logs`), { recursive: true });
  return {
    telegram_entry: path.join(releaseDir, "bin", "cyberboss.js"),
    config_dir: path.join(root, `${name}-config`),
    state_dir: stateDir,
    log_dir: path.join(root, `${name}-logs`),
    pid_file: path.join(stateDir, "cyberboss.pid"),
    watchdog_target: path.join(releaseDir, "start-safe.ps1"),
  };
}

function baseDescriptor(root) {
  const active = target(root, "active");
  const rollback = target(root, "rollback");
  return {
    active_release_id: "active",
    ...active,
    last_verified_sha: "1".repeat(40),
    rollback_release: { release_id: "rollback", ...rollback, last_verified_sha: "2".repeat(40) },
  };
}

test("watchdog_owner_dir outside both release paths and existing passes strict validation", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const ownerDir = path.join(root, "watchdog-owner");
  fs.mkdirSync(ownerDir, { recursive: true });
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: ownerDir }, { requireExistingPaths: true });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("watchdog_owner_dir is optional and an empty string is accepted", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: "" });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("watchdog_owner_dir rejects a relative path", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: "relative\\owner" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /watchdog_owner_dir: must be an absolute, normalized path/);
});

test("watchdog_owner_dir rejects a path inside the active release", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const insideActive = path.dirname(path.dirname(base.telegram_entry));
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: insideActive });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /watchdog_owner_dir: must be outside active\.release_path/);
});

test("watchdog_owner_dir rejects a path inside the rollback release", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const insideRollback = path.dirname(path.dirname(base.rollback_release.telegram_entry));
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: insideRollback });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /watchdog_owner_dir: must be outside rollback\.release_path/);
});

test("strict validation rejects a missing watchdog_owner_dir directory", () => {
  const root = tempRoot();
  const base = baseDescriptor(root);
  const missing = path.join(root, "does-not-exist-owner");
  const result = validateReleaseDescriptor({ ...base, watchdog_owner_dir: missing }, { requireExistingPaths: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /watchdog_owner_dir: does not exist as a directory/);
});
