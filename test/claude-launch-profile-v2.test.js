"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EFFORT_VALUES,
  LaunchProfileError,
  PROFILE_ENV_ALLOWLIST,
  buildProfileLaunch,
  fingerprintLaunchProfile,
  profileLogicalIdentity,
  validateLaunchProfile,
} = require("../src/adapters/runtime/claudecode/launch-profile");
const { resolveCliCapabilities } = require("../src/adapters/runtime/claudecode/cli-capabilities");

function makeBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lp-"));
  const realDir = fs.realpathSync(dir);
  fs.mkdirSync(path.join(realDir, "work"), { recursive: true });
  fs.mkdirSync(path.join(realDir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(realDir, "settings.json"), "{}");
  fs.writeFileSync(path.join(realDir, "mcp.json"), "{}");
  return realDir;
}

function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof LaunchProfileError, `expected LaunchProfileError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

test("effort is an explicit enum", () => {
  const baseDir = makeBase();
  for (const effort of EFFORT_VALUES) {
    assert.equal(validateLaunchProfile({ effort }, { baseDir }).effort, effort);
  }
  for (const effort of ["ultra", "LOW", "", "1", "none", 3, true]) {
    assert.throws(() => validateLaunchProfile({ effort }, { baseDir }), LaunchProfileError);
  }
});

test("string fields are length-bounded", () => {
  const baseDir = makeBase();
  rejects(() => validateLaunchProfile({ profileId: "p".repeat(200) }, { baseDir }), "too_long");
  rejects(() => validateLaunchProfile({ model: "m".repeat(500) }, { baseDir }), "too_long");
  rejects(() => validateLaunchProfile({ systemPrompt: "s".repeat(20_000) }, { baseDir }), "too_long");
  rejects(() => validateLaunchProfile({ outputStyle: "o".repeat(200) }, { baseDir }), "too_long");
});

test("profile ids must be canonical", () => {
  const baseDir = makeBase();
  assert.equal(validateLaunchProfile({ profileId: "safe-1.a_b" }, { baseDir }).profileId, "safe-1.a_b");
  for (const profileId of ["-leading", "with space", "with/slash", "", "__proto__"]) {
    assert.throws(() => validateLaunchProfile({ profileId }, { baseDir }), Error);
  }
});

test("unknown fields fail closed", () => {
  const baseDir = makeBase();
  rejects(() => validateLaunchProfile({ persona: "fable" }, { baseDir }), "unknown_field");
  rejects(() => validateLaunchProfile({ dangerouslySkipPermissions: true }, { baseDir }), "unknown_field");
});

test("systemPrompt and outputStyle together fail closed", () => {
  const baseDir = makeBase();
  const declared = resolveCliCapabilities({ declaredJson: '["--output-style"]' });
  rejects(
    () => validateLaunchProfile({ systemPrompt: "a", outputStyle: "b" }, { baseDir, capabilities: declared }),
    "conflicting_instructions",
  );
  assert.ok(validateLaunchProfile({ systemPrompt: "a" }, { baseDir }));
  assert.ok(validateLaunchProfile({ outputStyle: "b" }, { baseDir, capabilities: declared }));
});

test("agents are validated structurally on a null-prototype object", () => {
  const baseDir = makeBase();
  const profile = validateLaunchProfile({
    agents: {
      helper: {
        description: "d", prompt: "p", tools: ["Read"], permissionMode: "plan", maxTurns: 3,
      },
    },
  }, { baseDir });
  assert.equal(Object.getPrototypeOf(profile.agents), null);
  assert.equal(profile.agents.helper.maxTurns, 3);

  rejects(() => validateLaunchProfile({ agents: { helper: { description: "d" } } }, { baseDir }), "missing_field");
  rejects(() => validateLaunchProfile({ agents: { helper: { description: "d", prompt: "p", nope: 1 } } }, { baseDir }), "unknown_field");
  rejects(() => validateLaunchProfile({ agents: { "bad name": { description: "d", prompt: "p" } } }, { baseDir }), "invalid_agent_name");
  rejects(() => validateLaunchProfile({ agents: { a: { description: "d", prompt: "p", permissionMode: "yolo" } } }, { baseDir }), "invalid_enum");
  rejects(() => validateLaunchProfile({ agents: { a: { description: "d", prompt: "p", maxTurns: 0 } } }, { baseDir }), "invalid_range");
  rejects(() => validateLaunchProfile({ agents: {} }, { baseDir }), "empty_value");
  rejects(
    () => validateLaunchProfile({
      agents: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`a${i}`, { description: "d", prompt: "p" }])),
    }, { baseDir }),
    "too_long",
  );
});

test("an agent named __proto__ cannot reach Object.prototype", () => {
  const baseDir = makeBase();
  const hostile = JSON.parse('{"agents":{"__proto__":{"description":"d","prompt":"p"}}}');
  assert.throws(() => validateLaunchProfile(hostile, { baseDir }), Error);
  assert.equal({}.description, undefined);
  assert.equal(Object.prototype.prompt, undefined);
});

test("paths must exist, be the right type, and be readable", () => {
  const baseDir = makeBase();
  assert.equal(
    validateLaunchProfile({ cwd: "work" }, { baseDir }).cwd,
    path.join(baseDir, "work"),
  );
  assert.deepEqual(
    validateLaunchProfile({ settings: "settings.json" }, { baseDir }).settings,
    [path.join(baseDir, "settings.json")],
  );

  rejects(() => validateLaunchProfile({ cwd: "missing" }, { baseDir }), "path_missing");
  rejects(() => validateLaunchProfile({ cwd: "settings.json" }, { baseDir }), "path_wrong_type");
  rejects(() => validateLaunchProfile({ settings: "work" }, { baseDir }), "path_wrong_type");
  rejects(() => validateLaunchProfile({ cwd: "../escape" }, { baseDir }), "path_escape");
  rejects(() => validateLaunchProfile({ cwd: "" }, { baseDir }), "empty_value");
});

test("a symlink is resolved once and cannot escape the base directory", { skip: process.platform === "win32" ? "posix symlink semantics" : false }, () => {
  const baseDir = makeBase();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cb-lp-outside-"));
  const realOutside = fs.realpathSync(outside);

  // A symlink pointing outside the base is rejected for a relative path.
  fs.symlinkSync(realOutside, path.join(baseDir, "escape-link"), "dir");
  rejects(() => validateLaunchProfile({ cwd: "escape-link" }, { baseDir }), "path_escape");

  // A symlink staying inside the base is accepted and resolved to its target,
  // so the child is launched against the realpath rather than the link.
  fs.symlinkSync(path.join(baseDir, "work"), path.join(baseDir, "inner-link"), "dir");
  const profile = validateLaunchProfile({ cwd: "inner-link" }, { baseDir });
  assert.equal(profile.cwd, path.join(baseDir, "work"));
  assert.deepEqual([...profile.symlinkFields], ["cwd"]);
});

test("the environment allowlist is minimal and rejects secrets", () => {
  const baseDir = makeBase();
  assert.equal(PROFILE_ENV_ALLOWLIST.has("CLAUDE_CODE_USE_BEDROCK"), false);
  assert.equal(PROFILE_ENV_ALLOWLIST.has("CLAUDE_CODE_USE_VERTEX"), false);
  assert.equal(PROFILE_ENV_ALLOWLIST.has("ANTHROPIC_API_KEY"), false);

  assert.deepEqual(
    { ...validateLaunchProfile({ env: { NO_COLOR: "1" } }, { baseDir }).env },
    { NO_COLOR: "1" },
  );
  rejects(() => validateLaunchProfile({ env: { PATH: "/tmp" } }, { baseDir }), "env_not_allowed");
  rejects(() => validateLaunchProfile({ env: { ANTHROPIC_API_KEY: "x" } }, { baseDir }), "env_not_allowed");
  rejects(() => validateLaunchProfile({ env: { NO_COLOR: "" } }, { baseDir }), "invalid_type");
});

test("switching the authentication backend requires a separate explicit approval", () => {
  const baseDir = makeBase();
  rejects(
    () => validateLaunchProfile({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { baseDir }),
    "auth_backend_not_approved",
  );
  rejects(
    () => validateLaunchProfile({ env: { CLAUDE_CODE_USE_VERTEX: "1" } }, { baseDir }),
    "auth_backend_not_approved",
  );
  const approved = validateLaunchProfile(
    { env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
    { baseDir, allowAuthBackendOverride: true },
  );
  assert.equal(approved.env.CLAUDE_CODE_USE_BEDROCK, "1");
});

test("boolean environment values are strictly parsed", () => {
  const baseDir = makeBase();
  assert.equal(validateLaunchProfile({ env: { DISABLE_TELEMETRY: "true" } }, { baseDir }).env.DISABLE_TELEMETRY, "1");
  assert.equal(validateLaunchProfile({ env: { DISABLE_TELEMETRY: "0" } }, { baseDir }).env.DISABLE_TELEMETRY, "0");
  rejects(() => validateLaunchProfile({ env: { DISABLE_TELEMETRY: "yes" } }, { baseDir }), "invalid_boolean");
  rejects(() => validateLaunchProfile({ env: { DISABLE_TELEMETRY: "please" } }, { baseDir }), "invalid_boolean");
});

test("strictMcpConfig must be a real boolean, not a truthy string", () => {
  const baseDir = makeBase();
  assert.equal(validateLaunchProfile({ strictMcpConfig: true }, { baseDir }).strictMcpConfig, true);
  rejects(() => validateLaunchProfile({ strictMcpConfig: "true" }, { baseDir }), "invalid_boolean");
  rejects(() => validateLaunchProfile({ strictMcpConfig: 1 }, { baseDir }), "invalid_boolean");
});

test("cloud credentials do not reach a profiled child unless explicitly approved", () => {
  const baseDir = makeBase();
  const baseEnv = {
    PATH: "/usr/bin",
    AWS_ACCESS_KEY_ID: "AKIA-secret",
    AWS_SESSION_TOKEN: "tok",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
    ANTHROPIC_API_KEY: "sk-normal",
  };
  const stripped = buildProfileLaunch({
    profile: { profileId: "safe", effort: "low" }, baseEnv, baseCwd: baseDir, baseDir,
  });
  assert.equal(stripped.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(stripped.env.AWS_SESSION_TOKEN, undefined);
  assert.equal(stripped.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  // The ordinary Anthropic credential is not a cloud-backend credential.
  assert.equal(stripped.env.ANTHROPIC_API_KEY, "sk-normal");
  assert.equal(stripped.env.PATH, "/usr/bin");

  const inherited = buildProfileLaunch({
    profile: { profileId: "safe" }, baseEnv, baseCwd: baseDir, baseDir,
    allowCloudCredentialInheritance: true,
  });
  assert.equal(inherited.env.AWS_ACCESS_KEY_ID, "AKIA-secret");

  // A legacy (profile-free) launch is untouched.
  const legacy = buildProfileLaunch({ profile: null, baseEnv, baseCwd: baseDir, baseDir });
  assert.equal(legacy.env.AWS_ACCESS_KEY_ID, "AKIA-secret");
});

test("MCP config can be inherited, replaced, or cleared", () => {
  const baseDir = makeBase();
  const baseMcp = [path.join(baseDir, "shared.json")];
  fs.writeFileSync(baseMcp[0], "{}");

  const inherit = buildProfileLaunch({
    profile: { profileId: "a", mcpConfigPaths: ["mcp.json"] },
    baseMcpConfigPaths: baseMcp, baseCwd: baseDir, baseDir,
  });
  assert.deepEqual([...inherit.mcpConfigPaths], [baseMcp[0], path.join(baseDir, "mcp.json")]);
  assert.equal(inherit.mcpConfigMode, "inherit");

  const replace = buildProfileLaunch({
    profile: { profileId: "a", mcpConfigMode: "replace", mcpConfigPaths: ["mcp.json"] },
    baseMcpConfigPaths: baseMcp, baseCwd: baseDir, baseDir,
  });
  assert.deepEqual([...replace.mcpConfigPaths], [path.join(baseDir, "mcp.json")]);
  assert.equal(replace.args.includes(baseMcp[0]), false);

  const clear = buildProfileLaunch({
    profile: { profileId: "a", mcpConfigMode: "clear" },
    baseMcpConfigPaths: baseMcp, baseCwd: baseDir, baseDir,
  });
  assert.deepEqual([...clear.mcpConfigPaths], []);
  assert.equal(clear.args.includes("--mcp-config"), false);
  // Clearing implies strict mode, otherwise the child would rediscover servers.
  assert.equal(clear.args.includes("--strict-mcp-config"), true);

  rejects(
    () => validateLaunchProfile({ mcpConfigMode: "clear", mcpConfigPaths: ["mcp.json"] }, { baseDir }),
    "conflicting_mcp_config",
  );
  rejects(
    () => validateLaunchProfile({ mcpConfigMode: "replace" }, { baseDir }),
    "conflicting_mcp_config",
  );
});

test("a profile cannot be combined with raw extraArgs", () => {
  const baseDir = makeBase();
  rejects(
    () => buildProfileLaunch({
      profile: { profileId: "a" }, extraArgs: ["--dangerously-skip-permissions"], baseCwd: baseDir, baseDir,
    }),
    "conflicting_args",
  );
});

test("logical identity is separate from the launch fingerprint", () => {
  const baseDir = makeBase();
  const low = { profileId: "safe", effort: "low" };
  const high = { profileId: "safe", effort: "high" };

  // Same logical name...
  assert.equal(profileLogicalIdentity(validateLaunchProfile(low, { baseDir })), "safe");
  assert.equal(profileLogicalIdentity(validateLaunchProfile(high, { baseDir })), "safe");
  // ...different effective launch.
  assert.notEqual(
    fingerprintLaunchProfile(low, { baseDir }),
    fingerprintLaunchProfile(high, { baseDir }),
  );
  assert.equal(fingerprintLaunchProfile(null), "legacy");
  assert.equal(fingerprintLaunchProfile(undefined), "legacy");

  const launchLow = buildProfileLaunch({ profile: low, baseCwd: baseDir, baseDir });
  const launchHigh = buildProfileLaunch({ profile: high, baseCwd: baseDir, baseDir });
  assert.notEqual(launchLow.launchFingerprint, launchHigh.launchFingerprint);
  assert.equal(buildProfileLaunch({ profile: null, baseCwd: baseDir, baseDir }).launchFingerprint, "legacy");
});

test("validation is idempotent so a validated profile can be re-fingerprinted", () => {
  const baseDir = makeBase();
  const once = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir });
  const twice = validateLaunchProfile(once, { baseDir });
  assert.equal(twice, once);
  assert.equal(fingerprintLaunchProfile(once, { baseDir }), fingerprintLaunchProfile(twice, { baseDir }));
});

test("launch telemetry carries shapes and counts, never paths, prompts or env values", () => {
  const baseDir = makeBase();
  const launch = buildProfileLaunch({
    profile: {
      profileId: "safe",
      effort: "low",
      cwd: "work",
      configDir: "cfg",
      settings: ["settings.json"],
      systemPrompt: "SECRET-PROMPT-TEXT",
      env: { NO_COLOR: "1" },
    },
    baseEnv: {}, baseCwd: baseDir, baseDir,
    capabilities: resolveCliCapabilities({ declaredJson: '["--config-dir"]' }),
  });
  const serialized = JSON.stringify(launch.telemetry);
  for (const forbidden of ["SECRET-PROMPT-TEXT", baseDir, "settings.json", "NO_COLOR", "safe"]) {
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  }
  assert.equal(launch.telemetry.instructionSource, "system_prompt");
  assert.equal(launch.telemetry.settingsCount, 1);
  assert.equal(launch.telemetry.configDirSource, "profile");
});
