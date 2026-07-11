const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadEnv } = require("../src/index");
const { runHourlyDesirePoller } = require("../src/app/hourly-desire-poller");

const ENV_KEYS = [
  "CYBERBOSS_ENV_FILE",
  "CYBERBOSS_CONFIG_DIR",
  "CYBERBOSS_STATE_DIR",
  "CYBERBOSS_MEMORY_RETRIEVAL",
];

test("runtime env loading ignores STATE_DIR/.env", () => {
  withEnvSnapshot(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-env-source-"));
    const configDir = path.join(root, "config");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".env"), "CYBERBOSS_MEMORY_RETRIEVAL=0\n", "utf8");
    fs.writeFileSync(path.join(stateDir, ".env"), "CYBERBOSS_MEMORY_RETRIEVAL=1\n", "utf8");

    delete process.env.CYBERBOSS_ENV_FILE;
    process.env.CYBERBOSS_CONFIG_DIR = configDir;
    process.env.CYBERBOSS_STATE_DIR = stateDir;
    delete process.env.CYBERBOSS_MEMORY_RETRIEVAL;

    const loadedPath = loadEnv();

    assert.equal(loadedPath, path.join(configDir, ".env"));
    assert.equal(process.env.CYBERBOSS_MEMORY_RETRIEVAL, "0");
  });
});

test("explicit CYBERBOSS_ENV_FILE is the sole env source when configured", () => {
  withEnvSnapshot(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-explicit-env-"));
    const configDir = path.join(root, "config");
    const explicitEnvFile = path.join(root, "phase1.env");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".env"), "CYBERBOSS_MEMORY_RETRIEVAL=1\n", "utf8");
    fs.writeFileSync(explicitEnvFile, "CYBERBOSS_MEMORY_RETRIEVAL=0\n", "utf8");

    process.env.CYBERBOSS_ENV_FILE = explicitEnvFile;
    process.env.CYBERBOSS_CONFIG_DIR = configDir;
    delete process.env.CYBERBOSS_STATE_DIR;
    delete process.env.CYBERBOSS_MEMORY_RETRIEVAL;

    const loadedPath = loadEnv();

    assert.equal(loadedPath, explicitEnvFile);
    assert.equal(process.env.CYBERBOSS_MEMORY_RETRIEVAL, "0");
  });
});

test("hourly Desire poller exits before opening state when desireDriven is false", async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await Promise.race([
      runHourlyDesirePoller({
        desireDriven: false,
        sessionsFile: path.join(os.tmpdir(), "must-not-be-opened-sessions.json"),
        systemMessageQueueFile: path.join(os.tmpdir(), "must-not-be-opened-queue.json"),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("disabled Desire poller did not return")), 500)),
    ]);
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((line) => /hourly poller disabled/i.test(line)));
});

function withEnvSnapshot(fn) {
  const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    fn();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
