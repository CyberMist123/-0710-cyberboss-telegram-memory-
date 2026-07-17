const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { readConfig } = require("../src/core/config");
const { validateStartupPreflight } = require("../src/core/startup-preflight");
const { loadWechatInstructions } = require("../src/adapters/runtime/shared-instructions");
const { runMemoryPostResponsePipeline } = require("../src/core/memory-background-pipeline");

const ENV_KEYS = [
  "CYBERBOSS_CONFIG_DIR",
  "CYBERBOSS_STATE_DIR",
  "CYBERBOSS_WORKSPACE",
  "CYBERBOSS_WORKSPACE_ROOT",
  "CYBERBOSS_PROMPT_FILE",
  "CYBERBOSS_CHANNEL",
  "CYBERBOSS_RUNTIME",
  "CYBERBOSS_TELEGRAM_BOT_TOKEN",
  "CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS",
  "CYBERBOSS_MEMORY_RETRIEVAL",
  "CYBERBOSS_MEMORY_BACKGROUND_WRITE",
  "CYBERBOSS_MEMORY_REPLY_TRANSFORM",
  "CYBERBOSS_INCLUDE_OPERATIONS_PROMPT",
  "CYBERBOSS_INCLUDE_LEGACY_MEMORY_RELAYS",
  "CYBERBOSS_CONTINUITY_DIR",
];

test("phase 1 config requires explicit fixture paths and keeps legacy memory gates off", () => {
  withCleanEnv(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase1-config-"));
    const stateDir = path.join(root, "state");
    const configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    const promptFile = path.join(root, "prompt.md");
    const continuityDir = path.join(root, "continuity");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(configDir);
    fs.mkdirSync(workspace);
    fs.writeFileSync(promptFile, "persona={{userName}}\n", "utf8");

    process.env.CYBERBOSS_CONFIG_DIR = configDir;
    process.env.CYBERBOSS_STATE_DIR = stateDir;
    process.env.CYBERBOSS_WORKSPACE = workspace;
    process.env.CYBERBOSS_PROMPT_FILE = promptFile;
    process.env.CYBERBOSS_CONTINUITY_DIR = continuityDir;
    process.env.CYBERBOSS_CHANNEL = "telegram";
    process.env.CYBERBOSS_RUNTIME = "claudecode";
    process.env.CYBERBOSS_TELEGRAM_BOT_TOKEN = "FAKE_OFFLINE_TOKEN";
    process.env.CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS = "12345";
    process.argv = ["node", "cyberboss", "start"];

    const config = readConfig();
    assert.equal(config.stateDir, stateDir);
    assert.equal(config.configDir, configDir);
    assert.equal(config.workspaceRoot, workspace);
    assert.equal(config.promptFile, promptFile);
    assert.equal(config.continuityDir, continuityDir);
    assert.equal(config.weixinInstructionsFile, promptFile);
    assert.equal(config.legacyMemoryRetrieval, false);
    assert.equal(config.legacyMemoryBackgroundWrite, false);
    assert.equal(config.legacyMemoryReplyTransform, false);
    assert.doesNotThrow(() => validateStartupPreflight(config));
  });
});

test("startup preflight reports missing keys without exposing configured secret values", () => {
  let error = null;
  try {
    validateStartupPreflight({
      channel: "telegram",
      stateDir: "",
      workspaceRoot: "",
      configDir: "",
      promptFile: "",
      telegramBotToken: "FAKE_OFFLINE_TOKEN",
      telegramAllowedUserIds: [],
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /CYBERBOSS_STATE_DIR/);
  assert.match(error.message, /CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS/);
  assert.doesNotMatch(error.message, /FAKE_OFFLINE_TOKEN/);
});

test("prompt source defaults to one explicit file without operations or legacy memory relays", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase1-prompt-"));
  const promptFile = path.join(root, "prompt.md");
  const operationsFile = path.join(root, "operations.md");
  const stateFile = path.join(root, "state.md");
  const promisesFile = path.join(root, "pending-promises.md");
  fs.writeFileSync(promptFile, "PROMPT {{USER_NAME}}\n", "utf8");
  fs.writeFileSync(operationsFile, "OPERATIONS\n", "utf8");
  fs.writeFileSync(stateFile, "STATE\n", "utf8");
  fs.writeFileSync(promisesFile, "- [ ] follow up\n", "utf8");

  const base = {
    userName: "Fixture",
    weixinInstructionsFile: promptFile,
    weixinOperationsFile: operationsFile,
    memoryStateFile: stateFile,
    memoryPendingPromisesFile: promisesFile,
  };

  const defaultText = loadWechatInstructions(base);
  assert.equal(defaultText, "PROMPT Fixture");

  const expandedText = loadWechatInstructions({
    ...base,
    includeOperationsPrompt: true,
    includeLegacyMemoryRelays: true,
  });
  assert.match(expandedText, /PROMPT Fixture/);
  assert.match(expandedText, /OPERATIONS/);
  assert.match(expandedText, /STATE RELAY/);
  assert.match(expandedText, /PENDING PROMISES/);
});

test("legacy background memory pipeline is off unless explicitly enabled", async () => {
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  delete process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  const pending = [];
  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
      },
    },
    normalized: {
      text: "记住: fixture only",
      role: "user",
      receivedAt: "2026-07-11T00:00:00.000Z",
    },
    bgState: {},
  });
  restoreEnvValue("CYBERBOSS_MEMORY_BACKGROUND_WRITE", previous);
  assert.deepEqual(pending, []);
});

test("portability static check passes for repo and newly added files", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "portability-check.js")], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Portability check passed/);
});

test("Windows startup process checks do not bind PowerShell's read-only PID variable", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "windows", "cyberlink-start.ps1"),
    "utf8",
  );
  assert.doesNotMatch(script, /\[int\]\$Pid\b/i);
  assert.match(script, /\[int\]\$ProcessId\b/);
  assert.doesNotMatch(script, /Test-ProcessMatches\s+-Pid\b/i);
  assert.match(script, /Test-ProcessMatches\s+-ProcessId\b/);
});

function withCleanEnv(fn) {
  const previousArgv = process.argv;
  const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    process.argv = previousArgv;
    for (const [key, value] of snapshot.entries()) {
      restoreEnvValue(key, value);
    }
  }
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
