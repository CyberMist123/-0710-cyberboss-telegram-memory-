"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { canonicalWorkspaceKey } = require("../../../core/workspace-lock");
const { extraArgsContainFlag, isPotentiallySensitive } = require("./process-client");
const { buildProfileLaunch, resolveG3PreflightEnabled } = require("./launch-profile");

const REQUIRED_FLAGS = Object.freeze([
  "--bare", "--disable-slash-commands", "--setting-sources", "--settings",
  "--mcp-config", "--strict-mcp-config", "--tools", "--effort",
]);
const OPTIONAL_FLAGS = Object.freeze(["--config-dir", "--output-style"]);
const FORBIDDEN_RAW_FLAGS = Object.freeze([
  "--settings", "--mcp-config", "--strict-mcp-config", "--tools",
]);
const probeCache = new Map();

class G3PreflightError extends Error {
  constructor(code, details = {}) {
    super(`Claude G3 preflight stopped: ${code}`);
    this.name = "G3PreflightError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function hash(value, length = 64) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, length);
}

function commandCacheIdentity(command) {
  const resolved = resolveBinaryPath(command);
  try {
    const stat = fs.statSync(resolved);
    return `${canonicalWorkspaceKey(resolved)}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return `${String(command || "claude")}|unresolved`;
  }
}

function resolveBinaryPath(command) {
  const text = String(command || "claude");
  if (path.isAbsolute(text)) return canonicalWorkspaceKey(text) || path.resolve(text);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(locator, [text], { encoding: "utf8", windowsHide: true, shell: false });
  const first = String(found.stdout || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return first ? (canonicalWorkspaceKey(first) || path.resolve(first)) : path.resolve(text);
}

function runCliCapabilityProbe({ command = "claude", commandPrefixArgs = [], env = process.env } = {}) {
  const cacheKey = commandCacheIdentity(command);
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  const run = (flag) => spawnSync(command, [...commandPrefixArgs, flag], {
    env, encoding: "utf8", windowsHide: true, shell: false,
  });
  const versionRun = run("--version");
  const helpRun = run("--help");
  if (versionRun.error || helpRun.error || versionRun.status !== 0 || helpRun.status !== 0) {
    throw new G3PreflightError("cli_probe_failed");
  }
  const version = String(versionRun.stdout || versionRun.stderr || "").trim().split(/\r?\n/, 1)[0].slice(0, 128);
  const help = String(helpRun.stdout || helpRun.stderr || "");
  const required_flags = Object.fromEntries(REQUIRED_FLAGS.map((flag) => [flag, help.includes(flag)]));
  const result = Object.freeze({
    cli_version: isPotentiallySensitive(version) ? "redacted" : version,
    help_sha256: hash(help),
    required_flags: Object.freeze(required_flags),
    missing_flags: Object.freeze(REQUIRED_FLAGS.filter((flag) => !required_flags[flag])),
    observed_optional_flags: Object.freeze(OPTIONAL_FLAGS.filter((flag) => help.includes(flag))),
    binary_path_sha256: hash(resolveBinaryPath(command)),
  });
  probeCache.set(cacheKey, result);
  return result;
}

async function runG3LaunchPreflight({
  profile,
  baseEnv,
  baseCwd,
  baseMcpConfigPaths = [],
  extraArgs = [],
  baseDir = "",
  capabilities = null,
  command = "claude",
  commandPrefixArgs = [],
  authProbe = null,
  expectedLockPath = "",
} = {}) {
  if (!resolveG3PreflightEnabled(baseEnv)) return Object.freeze({ enabled: false });
  for (const flag of FORBIDDEN_RAW_FLAGS) {
    if (extraArgsContainFlag(extraArgs, flag)) {
      throw new G3PreflightError("forbidden_raw_extra_args", { flag });
    }
  }
  let launch;
  try {
    launch = buildProfileLaunch({
      profile, baseEnv, baseCwd, baseMcpConfigPaths, extraArgs: [], baseDir, capabilities,
    });
  } catch (error) {
    if (error?.code) throw error;
    throw new G3PreflightError("profile_invalid");
  }
  const cwdKey = canonicalWorkspaceKey(launch.cwd);
  const lockKey = canonicalWorkspaceKey(expectedLockPath || baseCwd);
  if (!cwdKey || cwdKey !== lockKey) {
    throw new G3PreflightError("cwd_lock_mismatch");
  }
  const cli = runCliCapabilityProbe({ command, commandPrefixArgs, env: launch.env });
  if (cli.missing_flags.length) {
    throw new G3PreflightError("cli_required_flags_missing", { missing_flags: cli.missing_flags });
  }
  // An explicitly injected probe (tests, alternate auth backends) wins. When
  // the caller wires none -- the production default -- fall back to an in-file
  // probe that asks the profile-exact CLI whether its own config root is
  // logged in. Without this fallback the whole G3 launch path fail-closes on
  // `auth_probe_unavailable` in production, where nothing assigns authProbe.
  const effectiveAuthProbe = authProbe == null
    ? ({ env, cwd }) => runDefaultAuthProbe({ command, commandPrefixArgs, env, cwd })
    : authProbe;
  if (typeof effectiveAuthProbe !== "function") throw new G3PreflightError("auth_probe_unavailable");
  let authResult;
  try {
    authResult = await effectiveAuthProbe({ env: launch.env, cwd: launch.cwd });
  } catch {
    throw new G3PreflightError("auth_probe_failed");
  }
  if (authResult?.ok !== true) throw new G3PreflightError("auth_probe_failed");
  return Object.freeze({ enabled: true, launch, cli });
}

// Default production auth probe. Asks the profile-exact CLI whether the config
// root named by `env` (CLAUDE_CONFIG_DIR) is signed in. Deliberately minimal:
// a single no-shell child, short timeout, and only the boolean `loggedIn` is
// read. The full status JSON (auth method, account identity, tokens) is never
// parsed beyond that field, never returned and never logged.
function runDefaultAuthProbe({ command = "claude", commandPrefixArgs = [], env, cwd } = {}) {
  const result = spawnSync(command, [...commandPrefixArgs, "auth", "status", "--json"], {
    env,
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) return { ok: false };
  try {
    const status = JSON.parse(String(result.stdout || ""));
    return { ok: status?.loggedIn === true };
  } catch {
    return { ok: false };
  }
}

function clearCliProbeCache() {
  probeCache.clear();
}

module.exports = {
  FORBIDDEN_RAW_FLAGS,
  G3PreflightError,
  OPTIONAL_FLAGS,
  REQUIRED_FLAGS,
  clearCliProbeCache,
  runCliCapabilityProbe,
  runDefaultAuthProbe,
  runG3LaunchPreflight,
};
