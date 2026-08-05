const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveExternalMcpServerConfigs } = require("../src/tools/external-mcp-config");

// Every case below runs with the legacy music-MCP env vars cleared so the only
// inputs are the ones the case sets. The folder registry is opt-in: with
// CYBERBOSS_EXTRA_MCP_SERVERS_DIR unset there must be no behavior change.
const ENV_KEYS = [
  "CYBERBOSS_MUSIC_MCP_NAME",
  "CYBERBOSS_MUSIC_MCP_COMMAND",
  "CYBERBOSS_MUSIC_MCP_ARGS",
  "CYBERBOSS_EXTRA_MCP_SERVERS",
  "CYBERBOSS_EXTRA_MCP_SERVERS_DIR",
];

function withEnv(values, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withRegistryDir(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mcp-registry-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content, "utf8");
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withCapturedWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...parts) => { warnings.push(parts.join(" ")); };
  try { return { result: run(), warnings }; } finally {
    console.warn = original;
  }
}

test("folder registry loads enabled declarations with args and env", () => {
  withRegistryDir({
    "alpha.json": JSON.stringify({
      name: "registry_alpha",
      command: "alpha-command",
      args: ["--alpha", " --loud "],
      env: { ALPHA_TOKEN_PATH: "C:/somewhere/alpha" },
      enabled: true,
    }),
  }, (dir) => withEnv({ CYBERBOSS_EXTRA_MCP_SERVERS_DIR: dir }, () => {
    const configs = resolveExternalMcpServerConfigs();
    assert.deepEqual(configs, [{
      name: "registry_alpha",
      command: "alpha-command",
      args: ["--alpha", "--loud"],
      env: { ALPHA_TOKEN_PATH: "C:/somewhere/alpha" },
    }]);
  }));
});

test("folder registry only loads enabled === true; false or absent stays off", () => {
  withRegistryDir({
    "disabled.json": JSON.stringify({ name: "registry_disabled", command: "disabled-command", enabled: false }),
    "unmarked.json": JSON.stringify({ name: "registry_unmarked", command: "unmarked-command" }),
    "truthy-but-not-true.json": JSON.stringify({ name: "registry_truthy", command: "truthy-command", enabled: 1 }),
    "on.json": JSON.stringify({ name: "registry_on", command: "on-command", enabled: true }),
  }, (dir) => withEnv({ CYBERBOSS_EXTRA_MCP_SERVERS_DIR: dir }, () => {
    const configs = resolveExternalMcpServerConfigs();
    assert.deepEqual(configs.map((config) => config.name), ["registry_on"]);
  }));
});

test("one broken file is skipped with a warning and does not take down the rest", () => {
  withRegistryDir({
    "01-broken.json": "{ this is not json",
    "02-array.json": JSON.stringify(["not", "an", "object"]),
    "03-missing-command.json": JSON.stringify({ name: "registry_incomplete", enabled: true }),
    "04-good.json": JSON.stringify({ name: "registry_good", command: "good-command", enabled: true }),
  }, (dir) => withEnv({ CYBERBOSS_EXTRA_MCP_SERVERS_DIR: dir }, () => {
    const { result, warnings } = withCapturedWarnings(() => resolveExternalMcpServerConfigs());
    assert.deepEqual(result.map((config) => config.name), ["registry_good"]);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /01-broken\.json.*invalid JSON/);
    assert.match(warnings[1], /02-array\.json.*expected a JSON object/);
    assert.match(warnings[2], /03-missing-command\.json.*missing name or command/);
  }));
});

test("CYBERBOSS_EXTRA_MCP_SERVERS wins name collisions against the folder registry (first-come dedupe)", () => {
  withRegistryDir({
    "shadowed.json": JSON.stringify({ name: "fixture_alpha", command: "registry-command", enabled: true }),
    "unique.json": JSON.stringify({ name: "registry_unique", command: "unique-command", enabled: true }),
  }, (dir) => withEnv({
    CYBERBOSS_EXTRA_MCP_SERVERS: JSON.stringify([
      { name: "fixture_alpha", command: "env-command", args: ["--from-env"] },
    ]),
    CYBERBOSS_EXTRA_MCP_SERVERS_DIR: dir,
  }, () => {
    const configs = resolveExternalMcpServerConfigs();
    assert.deepEqual(configs.map((config) => config.name), ["fixture_alpha", "registry_unique"]);
    assert.equal(configs[0].command, "env-command");
  }));
});

test("unset dir env or a missing directory resolves to the empty set", () => {
  withEnv({}, () => {
    assert.deepEqual(resolveExternalMcpServerConfigs(), []);
  });
  withEnv({
    CYBERBOSS_EXTRA_MCP_SERVERS_DIR: path.join(os.tmpdir(), "cyberboss-mcp-registry-does-not-exist"),
  }, () => {
    const { result, warnings } = withCapturedWarnings(() => resolveExternalMcpServerConfigs());
    assert.deepEqual(result, []);
    assert.deepEqual(warnings, []);
  });
});
