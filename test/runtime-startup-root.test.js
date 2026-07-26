const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// R4 F4: the runtime-startup entrypoints must never walk ancestors to guess
// the workspace root, and the watchdog must never guess its descriptor. These
// tests pin both the absence of the discovery logic (static, every platform)
// and the fail-closed behaviour (behavioural, Windows).

const packageRoot = path.resolve(__dirname, "..");
const IS_WINDOWS = process.platform === "win32";

const entrypoints = {
  dashboard: path.join(packageRoot, "scripts", "windows", "runtime-startup", "start-dashboard.ps1"),
  telegram: path.join(packageRoot, "scripts", "windows", "runtime-startup", "start-telegram.ps1"),
};

function assertFailedClosed(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.notEqual(result.status, null, "process never ran: spawnSync returned status null");
  assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

function runStartup(script, env) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], { encoding: "utf8", env });
}

test("startup entrypoints contain no ancestor-walk root discovery", () => {
  for (const [name, script] of Object.entries(entrypoints)) {
    const source = fs.readFileSync(script, "utf8");
    assert.doesNotMatch(source, /while\s*\(\s*\$candidate\s*\)/, `${name}: ancestor walk is back`);
    assert.doesNotMatch(source, /Split-Path\s+-Parent\s+\$candidate/, `${name}: ancestor walk is back`);
    assert.match(source, /CYBERLINK_ROOT is not set/, `${name}: missing the fail-closed root requirement`);
  }
});

test("watchdog has no descriptor guessing and requires --descriptor", () => {
  const watchdog = path.join(packageRoot, "extensions", "relationship-memory", "launcher", "watchdog.py");
  const source = fs.readFileSync(watchdog, "utf8");
  assert.doesNotMatch(source, /Path\.cwd\(\)\s*\/\s*"deployment"/, "cwd fallback is back");
  assert.doesNotMatch(source, /for parent in HERE\.parents/, "ancestor probing is back");
  const result = spawnSync(process.env.PYTHON || "python", [watchdog, "--once"], { encoding: "utf8" });
  assertFailedClosed(result, "watchdog accepted a run without an explicit --descriptor");
  assert.match(`${result.stderr}`, /--descriptor/);
});

test("startup entrypoints fail closed when CYBERLINK_ROOT is unset", { skip: !IS_WINDOWS }, () => {
  const env = { ...process.env };
  delete env.CYBERLINK_ROOT;
  for (const [name, script] of Object.entries(entrypoints)) {
    const result = runStartup(script, env);
    assertFailedClosed(result, `${name} started without a pinned CYBERLINK_ROOT`);
    assert.match(`${result.stderr}${result.stdout}`, /CYBERLINK_ROOT is not set/);
  }
});

test("startup entrypoints reject a CYBERLINK_ROOT that is not a workspace root", { skip: !IS_WINDOWS }, () => {
  // realpathSync.native expands the runner's short-form temp spelling; the
  // scripts resolve the root themselves, so either spelling must fail the
  // same way — on the missing-subdirectory check, before anything runs.
  const decoy = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-decoy-root-")));
  fs.mkdirSync(path.join(decoy, "runtime"), { recursive: true });
  const env = { ...process.env, CYBERLINK_ROOT: decoy };
  for (const [name, script] of Object.entries(entrypoints)) {
    const result = runStartup(script, env);
    assertFailedClosed(result, `${name} accepted a root without settings/`);
    assert.match(`${result.stderr}${result.stdout}`, /does not look like the workspace root \(missing 'settings'\)/);
  }
});
