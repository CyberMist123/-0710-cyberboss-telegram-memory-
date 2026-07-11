const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const switchScript = path.join(repoRoot, "scripts", "windows", "phase1-switch.ps1");

test("phase1 switch refuses when the legacy PID is alive", () => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.legacyPidFile, "4242\n", "utf8");

  const result = runSwitch(fixture, {
    CYBERBOSS_LEGACY_PID_FILE: fixture.legacyPidFile,
    CYBERBOSS_SWITCH_MOCK_ALIVE_PIDS: "4242",
    CYBERBOSS_SWITCH_MOCK_PROCESS_LIST: fixture.emptyProcessList,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /still alive|refusing to start a second poller/i);
});

test("phase1 switch continues process scan when the legacy PID is stale", () => {
  const fixture = createFixture();
  fs.writeFileSync(fixture.legacyPidFile, "4242\n", "utf8");

  const result = runSwitch(fixture, {
    CYBERBOSS_LEGACY_PID_FILE: fixture.legacyPidFile,
    CYBERBOSS_SWITCH_MOCK_ALIVE_PIDS: "0",
    CYBERBOSS_SWITCH_MOCK_PROCESS_LIST: fixture.emptyProcessList,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /stale/i);
  assert.match(result.stdout, /preflight passed/i);
});

test("phase1 switch refuses a poller from a different repo path", () => {
  const fixture = createFixture();
  const otherRepoProcessList = path.join(fixture.root, "other-repo-processes.json");
  fs.writeFileSync(otherRepoProcessList, JSON.stringify([
    {
      ProcessId: 9911,
      CommandLine: "node D:\\other\\repo\\bin\\cyberboss.js start", // PORTABILITY_FIXTURE
    },
  ]), "utf8");

  const result = runSwitch(fixture, {
    CYBERBOSS_SWITCH_MOCK_ALIVE_PIDS: "0",
    CYBERBOSS_SWITCH_MOCK_PROCESS_LIST: otherRepoProcessList,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Detected running cyberboss\.js start process/i);
  assert.match(result.stderr + result.stdout, /D:\\other\\repo/i);
});

test("phase1 switch reaches the configured start script boundary when no poller is present", () => {
  const fixture = createFixture();
  const result = runSwitch(fixture, {
    CYBERBOSS_SWITCH_MOCK_ALIVE_PIDS: "0",
    CYBERBOSS_SWITCH_MOCK_PROCESS_LIST: fixture.emptyProcessList,
    CYBERBOSS_SWITCH_START_SCRIPT: fixture.startScript,
  }, ["-ConfirmSwitch"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MOCK_START_BOUNDARY/);
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-switch-"));
  const configDir = path.join(root, "config");
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const promptFile = path.join(root, "prompt.md");
  fs.writeFileSync(promptFile, "fixture prompt\n", "utf8");
  const emptyProcessList = path.join(root, "processes.json");
  fs.writeFileSync(emptyProcessList, "[]", "utf8");
  const startScript = path.join(root, "mock-start.ps1");
  fs.writeFileSync(startScript, "Write-Host 'MOCK_START_BOUNDARY'\n", "utf8");
  return {
    root,
    configDir,
    stateDir,
    workspace,
    promptFile,
    emptyProcessList,
    legacyPidFile: path.join(root, "legacy.pid"),
    startScript,
  };
}

function runSwitch(fixture, extraEnv = {}, args = []) {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const baseEnv = {
    PATH: process.env.PATH || "",
    Path: process.env.Path || "",
    SystemRoot: process.env.SystemRoot || "",
    WINDIR: process.env.WINDIR || process.env.SystemRoot || "",
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    ComSpec: process.env.ComSpec || "",
    CYBERBOSS_CONFIG_DIR: fixture.configDir,
    CYBERBOSS_STATE_DIR: fixture.stateDir,
    CYBERBOSS_WORKSPACE: fixture.workspace,
    CYBERBOSS_PROMPT_FILE: fixture.promptFile,
    CYBERBOSS_TELEGRAM_BOT_TOKEN: "FAKE_PHASE1_SWITCH_TOKEN",
    CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS: "12345",
  };
  return spawnSync(shell, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    switchScript,
    ...args,
  ], {
    cwd: repoRoot,
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
  });
}
