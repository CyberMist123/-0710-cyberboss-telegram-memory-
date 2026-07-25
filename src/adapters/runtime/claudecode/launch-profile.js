"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fsApi = require("node:fs");

const {
  BoundedJsonError,
  assertSafeKey,
  createNullPrototypeObject,
  parseStrictBoolean,
} = require("../../../core/bounded-json");

// Hardened Claude Code launch profiles (v2).
//
// Differences from the v1 prototype, all of them fail-closed:
//   * `effort` is an explicit enum, not a free string.
//   * every string field has a length bound and `agents` has a structural bound.
//   * `agents` is built on a null-prototype object and each entry is fully
//     validated, so an operator key can never reach Object.prototype.
//   * every path must exist, be of the right type, be readable, and is passed
//     to the child as its *realpath* -- a symlink swapped after validation
//     cannot redirect the launch.
//   * the env allowlist is minimal and contains no authentication switch.
//     Selecting Bedrock/Vertex, or letting AWS/GCP credentials reach the child,
//     each require a separate explicit opt-in that a profile alone cannot set.
//   * booleans are strictly parsed; an arbitrary non-empty string is not true.
//   * base MCP servers can be explicitly replaced or cleared instead of always
//     inheriting the shared `.mcp.json`.
//   * `systemPrompt` and `outputStyle` together fail closed.
//   * the profile's *logical identity* (profileId) is separate from the
//     *launch fingerprint* (hash of what is actually executed).

const PROFILE_FIELDS = Object.freeze(new Set([
  "profileId",
  "model",
  "effort",
  "cwd",
  "env",
  "configDir",
  "settings",
  "builtInTools",
  "agents",
  "mcpConfigPaths",
  "mcpConfigMode",
  "strictMcpConfig",
  "systemPrompt",
  "outputStyle",
]));

const EFFORT_VALUES = Object.freeze(["low", "medium", "high", "max"]);
const EFFORT_SET = new Set(EFFORT_VALUES);

const MCP_CONFIG_MODES = Object.freeze(["inherit", "replace", "clear"]);
const MCP_CONFIG_MODE_SET = new Set(MCP_CONFIG_MODES);

const AGENT_PERMISSION_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
const AGENT_PERMISSION_MODE_SET = new Set(AGENT_PERMISSION_MODES);

// Non-secret, non-authenticating environment keys a profile may set.
// Deliberately does NOT include CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX.
const PROFILE_ENV_ALLOWLIST = Object.freeze(new Set([
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "DISABLE_TELEMETRY",
  "NO_COLOR",
  "TERM",
  "CI",
]));

// Only reachable when the caller passes allowAuthBackendOverride:true, which is
// a separate deployment decision and is never derived from profile JSON.
const AUTH_BACKEND_ENV_KEYS = Object.freeze(new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]));

const BOOLEAN_ENV_KEYS = Object.freeze(new Set([
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "DISABLE_AUTOUPDATER",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
  "DISABLE_TELEMETRY",
  "CI",
]));

// Cloud credential material that must not silently reach a profiled child.
const CLOUD_CREDENTIAL_ENV_PREFIXES = Object.freeze([
  "AWS_",
  "AMAZON_",
  "GOOGLE_",
  "GCLOUD_",
  "GCP_",
  "CLOUDSDK_",
]);

const SECRET_KEY_PATTERN = /(?:token|secret|password|credential|api[_-]?key|auth|private[_-]?key|session)/i;

const LIMITS = Object.freeze({
  profileId: 64,
  model: 128,
  outputStyle: 64,
  systemPrompt: 8192,
  pathLength: 4096,
  envValue: 256,
  builtInTools: 64,
  builtInToolName: 128,
  settingsPaths: 8,
  mcpConfigPaths: 8,
  agents: 16,
  agentName: 64,
  agentDescription: 512,
  agentPrompt: 8192,
  agentToolList: 64,
  agentToolName: 128,
  agentsSerialized: 32768,
  agentMaxTurns: 100,
});

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class LaunchProfileError extends Error {
  constructor(message, code = "launch_profile_invalid") {
    super(message);
    this.name = "LaunchProfileError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertPlainObject(value, message) {
  if (!isPlainObject(value)) {
    throw new LaunchProfileError(message, "not_an_object");
  }
}

function boundedString(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new LaunchProfileError(`${field} must be a string`, "invalid_type");
  }
  if (value.length > maxLength) {
    throw new LaunchProfileError(`${field} exceeds ${maxLength} characters`, "too_long");
  }
  return value;
}

function nonEmptyBoundedString(value, field, maxLength) {
  const text = boundedString(value, field, maxLength).trim();
  if (!text) {
    throw new LaunchProfileError(`${field} must not be empty`, "empty_value");
  }
  return text;
}

function canonicalProfileId(value, field = "profileId") {
  const text = nonEmptyBoundedString(value, field, LIMITS.profileId);
  if (!PROFILE_ID_PATTERN.test(text)) {
    throw new LaunchProfileError(
      `${field} must match ${PROFILE_ID_PATTERN}`,
      "non_canonical_profile_id",
    );
  }
  assertSafeKey(text, field);
  return text;
}

/**
 * Resolve a configured path to an existing, readable realpath.
 *
 * Symlink / Windows reparse-point policy: the link is followed once, at
 * validation time, and the *resolved target* is what the child receives. A
 * relative path may not escape `baseDir`, and neither may its resolved target,
 * so a symlink inside the base cannot be used to reach outside it.
 */
function resolveExistingPath(value, {
  field,
  baseDir,
  kind,
  fs = fsApi,
} = {}) {
  const text = nonEmptyBoundedString(value, field, LIMITS.pathLength);
  if (text.includes("\u0000")) {
    throw new LaunchProfileError(`${field} contains a null byte`, "invalid_path");
  }
  const normalizedBaseDir = path.resolve(baseDir || process.cwd());
  const wasRelative = !path.isAbsolute(text);
  const candidate = wasRelative ? path.resolve(normalizedBaseDir, text) : path.normalize(text);

  if (wasRelative) {
    const relative = path.relative(normalizedBaseDir, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new LaunchProfileError(`${field} escapes the profile base directory`, "path_escape");
    }
  }

  let linkStat;
  try {
    linkStat = fs.lstatSync(candidate);
  } catch {
    throw new LaunchProfileError(`${field} does not exist`, "path_missing");
  }
  const isSymbolicLink = linkStat.isSymbolicLink();

  let realPath;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    throw new LaunchProfileError(`${field} could not be resolved`, "path_unresolvable");
  }

  if (wasRelative) {
    let realBaseDir = normalizedBaseDir;
    try {
      realBaseDir = fs.realpathSync(normalizedBaseDir);
    } catch {
      // A missing base directory is caught below by the containment check.
    }
    const relativeReal = path.relative(realBaseDir, realPath);
    if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
      throw new LaunchProfileError(
        `${field} resolves outside the profile base directory`,
        "path_escape",
      );
    }
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    throw new LaunchProfileError(`${field} does not exist`, "path_missing");
  }
  if (kind === "dir" && !stat.isDirectory()) {
    throw new LaunchProfileError(`${field} must be a directory`, "path_wrong_type");
  }
  if (kind === "file" && !stat.isFile()) {
    throw new LaunchProfileError(`${field} must be a regular file`, "path_wrong_type");
  }

  try {
    fs.accessSync(realPath, fsApi.constants.R_OK);
  } catch {
    throw new LaunchProfileError(`${field} is not readable`, "path_unreadable");
  }

  return { path: realPath, isSymbolicLink };
}

function normalizePathList(value, { field, baseDir, kind, maxItems, fs = fsApi }) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) {
    throw new LaunchProfileError(`${field} must be a string or string[]`, "invalid_type");
  }
  if (!values.length) {
    throw new LaunchProfileError(`${field} must not be empty`, "empty_value");
  }
  if (values.length > maxItems) {
    throw new LaunchProfileError(`${field} exceeds ${maxItems} entries`, "too_long");
  }
  const resolved = [];
  const seen = new Set();
  let sawSymlink = false;
  for (const item of values) {
    const entry = resolveExistingPath(item, { field, baseDir, kind, fs });
    sawSymlink = sawSymlink || entry.isSymbolicLink;
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    resolved.push(entry.path);
  }
  return { paths: Object.freeze(resolved), sawSymlink };
}

function normalizeStringList(value, { field, maxItems, maxLength }) {
  if (!Array.isArray(value)) {
    throw new LaunchProfileError(`${field} must be a string[]`, "invalid_type");
  }
  if (value.length > maxItems) {
    throw new LaunchProfileError(`${field} exceeds ${maxItems} entries`, "too_long");
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = nonEmptyBoundedString(item, `${field} entry`, maxLength);
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  if (!out.length) {
    throw new LaunchProfileError(`${field} must not be empty`, "empty_value");
  }
  return Object.freeze(out);
}

function normalizeProfileEnv(value, { allowAuthBackendOverride = false } = {}) {
  assertPlainObject(value, "env must be an object");
  const out = createNullPrototypeObject();
  const keys = Object.keys(value);
  if (keys.length > PROFILE_ENV_ALLOWLIST.size + AUTH_BACKEND_ENV_KEYS.size) {
    throw new LaunchProfileError("env has too many entries", "too_long");
  }
  for (const key of keys) {
    assertSafeKey(key, "env");
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new LaunchProfileError(`env key looks like a secret: ${key}`, "env_not_allowed");
    }
    if (AUTH_BACKEND_ENV_KEYS.has(key)) {
      if (!allowAuthBackendOverride) {
        throw new LaunchProfileError(
          `env key ${key} switches the authentication backend and requires a separate explicit approval`,
          "auth_backend_not_approved",
        );
      }
    } else if (!PROFILE_ENV_ALLOWLIST.has(key)) {
      throw new LaunchProfileError(`env key is not approved: ${key}`, "env_not_allowed");
    }
    const raw = value[key];
    if (typeof raw !== "string" || !raw.length) {
      throw new LaunchProfileError(`env.${key} must be a non-empty string`, "invalid_type");
    }
    if (raw.length > LIMITS.envValue) {
      throw new LaunchProfileError(`env.${key} is too long`, "too_long");
    }
    if (BOOLEAN_ENV_KEYS.has(key)) {
      let parsed;
      try {
        parsed = parseStrictBoolean(raw, { label: `env.${key}` });
      } catch (error) {
        throw new LaunchProfileError(
          error instanceof BoundedJsonError ? error.message : `env.${key} must be 1/0/true/false`,
          "invalid_boolean",
        );
      }
      out[key] = parsed ? "1" : "0";
      continue;
    }
    out[key] = raw;
  }
  return Object.freeze(out);
}

function normalizeAgents(value) {
  assertPlainObject(value, "agents must be an object");
  const names = Object.keys(value);
  if (names.length > LIMITS.agents) {
    throw new LaunchProfileError(`agents exceeds ${LIMITS.agents} entries`, "too_long");
  }
  if (!names.length) {
    throw new LaunchProfileError("agents must not be empty", "empty_value");
  }
  const normalized = createNullPrototypeObject();
  for (const name of names) {
    assertSafeKey(name, "agents");
    if (!AGENT_NAME_PATTERN.test(name)) {
      throw new LaunchProfileError(`agents key is not a valid name: ${name}`, "invalid_agent_name");
    }
    const agent = value[name];
    assertPlainObject(agent, `agents.${name} must be an object`);
    const entry = createNullPrototypeObject();
    for (const key of Object.keys(agent)) {
      assertSafeKey(key, `agents.${name}`);
      switch (key) {
        case "description":
          entry.description = nonEmptyBoundedString(
            agent.description, `agents.${name}.description`, LIMITS.agentDescription,
          );
          break;
        case "prompt":
          entry.prompt = nonEmptyBoundedString(
            agent.prompt, `agents.${name}.prompt`, LIMITS.agentPrompt,
          );
          break;
        case "model":
          entry.model = nonEmptyBoundedString(agent.model, `agents.${name}.model`, LIMITS.model);
          break;
        case "permissionMode": {
          const mode = nonEmptyBoundedString(
            agent.permissionMode, `agents.${name}.permissionMode`, 32,
          );
          if (!AGENT_PERMISSION_MODE_SET.has(mode)) {
            throw new LaunchProfileError(
              `agents.${name}.permissionMode must be one of ${AGENT_PERMISSION_MODES.join("|")}`,
              "invalid_enum",
            );
          }
          entry.permissionMode = mode;
          break;
        }
        case "maxTurns": {
          const turns = agent.maxTurns;
          if (!Number.isSafeInteger(turns) || turns < 1 || turns > LIMITS.agentMaxTurns) {
            throw new LaunchProfileError(
              `agents.${name}.maxTurns must be an integer between 1 and ${LIMITS.agentMaxTurns}`,
              "invalid_range",
            );
          }
          entry.maxTurns = turns;
          break;
        }
        case "tools":
        case "disallowedTools":
        case "skills":
          entry[key] = normalizeStringList(agent[key], {
            field: `agents.${name}.${key}`,
            maxItems: LIMITS.agentToolList,
            maxLength: LIMITS.agentToolName,
          });
          break;
        default:
          throw new LaunchProfileError(
            `agents.${name} contains an unknown field: ${key}`,
            "unknown_field",
          );
      }
    }
    if (!entry.description || !entry.prompt) {
      throw new LaunchProfileError(
        `agents.${name} requires both description and prompt`,
        "missing_field",
      );
    }
    normalized[name] = Object.freeze(entry);
  }
  const serialized = serializeAgents(normalized);
  if (serialized.length > LIMITS.agentsSerialized) {
    throw new LaunchProfileError("agents serialization is too large", "too_long");
  }
  return Object.freeze(normalized);
}

// Serialize a null-prototype agents map without re-introducing a polluted
// prototype: keys are copied explicitly into a fresh plain object in sorted
// order so the output is stable for fingerprinting.
function serializeAgents(agents) {
  const plain = {};
  for (const name of Object.keys(agents).sort()) {
    plain[name] = { ...agents[name] };
  }
  return JSON.stringify(plain);
}

/**
 * Validate an operator-supplied launch profile.
 *
 * @returns {object|null} frozen normalized profile, or null when absent.
 */
function validateLaunchProfile(profile, {
  baseDir = process.cwd(),
  allowAuthBackendOverride = false,
  fs = fsApi,
} = {}) {
  if (profile === undefined || profile === null) {
    return null;
  }
  // Validation is idempotent: an already-validated profile is returned as-is
  // so re-fingerprinting or re-launching it cannot fail on the derived,
  // non-enumerable metadata that validation itself attached.
  if (isValidatedProfile(profile)) {
    return profile;
  }
  assertPlainObject(profile, "launchProfile must be an object");

  const keys = Object.keys(profile);
  for (const key of keys) {
    assertSafeKey(key, "launchProfile");
    if (!PROFILE_FIELDS.has(key)) {
      throw new LaunchProfileError(`launchProfile contains an unknown field: ${key}`, "unknown_field");
    }
  }

  const normalized = {};
  const pathNotes = { symlinks: [] };

  if (profile.profileId !== undefined) {
    normalized.profileId = canonicalProfileId(profile.profileId);
  }
  if (profile.model !== undefined) {
    normalized.model = nonEmptyBoundedString(profile.model, "model", LIMITS.model);
  }
  if (profile.effort !== undefined) {
    const effort = nonEmptyBoundedString(profile.effort, "effort", 16);
    if (!EFFORT_SET.has(effort)) {
      throw new LaunchProfileError(
        `effort must be one of ${EFFORT_VALUES.join("|")}`,
        "invalid_enum",
      );
    }
    normalized.effort = effort;
  }
  if (profile.systemPrompt !== undefined) {
    normalized.systemPrompt = nonEmptyBoundedString(
      profile.systemPrompt, "systemPrompt", LIMITS.systemPrompt,
    );
  }
  if (profile.outputStyle !== undefined) {
    normalized.outputStyle = nonEmptyBoundedString(
      profile.outputStyle, "outputStyle", LIMITS.outputStyle,
    );
  }
  if (normalized.systemPrompt && normalized.outputStyle) {
    // Both replace the operating instructions. Applying one silently over the
    // other would make the effective instruction set unpredictable.
    throw new LaunchProfileError(
      "systemPrompt and outputStyle cannot both be set",
      "conflicting_instructions",
    );
  }

  if (profile.cwd !== undefined) {
    const resolved = resolveExistingPath(profile.cwd, { field: "cwd", baseDir, kind: "dir", fs });
    normalized.cwd = resolved.path;
    if (resolved.isSymbolicLink) pathNotes.symlinks.push("cwd");
  }
  if (profile.configDir !== undefined) {
    const resolved = resolveExistingPath(profile.configDir, {
      field: "configDir", baseDir, kind: "dir", fs,
    });
    normalized.configDir = resolved.path;
    if (resolved.isSymbolicLink) pathNotes.symlinks.push("configDir");
  }
  if (profile.settings !== undefined) {
    const resolved = normalizePathList(profile.settings, {
      field: "settings", baseDir, kind: "file", maxItems: LIMITS.settingsPaths, fs,
    });
    normalized.settings = resolved.paths;
    if (resolved.sawSymlink) pathNotes.symlinks.push("settings");
  }
  if (profile.mcpConfigPaths !== undefined) {
    const resolved = normalizePathList(profile.mcpConfigPaths, {
      field: "mcpConfigPaths", baseDir, kind: "file", maxItems: LIMITS.mcpConfigPaths, fs,
    });
    normalized.mcpConfigPaths = resolved.paths;
    if (resolved.sawSymlink) pathNotes.symlinks.push("mcpConfigPaths");
  }
  if (profile.builtInTools !== undefined) {
    normalized.builtInTools = normalizeStringList(profile.builtInTools, {
      field: "builtInTools",
      maxItems: LIMITS.builtInTools,
      maxLength: LIMITS.builtInToolName,
    });
  }
  if (profile.agents !== undefined) {
    normalized.agents = normalizeAgents(profile.agents);
  }
  if (profile.env !== undefined) {
    normalized.env = normalizeProfileEnv(profile.env, { allowAuthBackendOverride });
  }
  if (profile.strictMcpConfig !== undefined) {
    if (typeof profile.strictMcpConfig !== "boolean") {
      throw new LaunchProfileError(
        "strictMcpConfig must be a real boolean, not a truthy string",
        "invalid_boolean",
      );
    }
    normalized.strictMcpConfig = profile.strictMcpConfig;
  }

  let mcpConfigMode = "inherit";
  if (profile.mcpConfigMode !== undefined) {
    mcpConfigMode = nonEmptyBoundedString(profile.mcpConfigMode, "mcpConfigMode", 16);
    if (!MCP_CONFIG_MODE_SET.has(mcpConfigMode)) {
      throw new LaunchProfileError(
        `mcpConfigMode must be one of ${MCP_CONFIG_MODES.join("|")}`,
        "invalid_enum",
      );
    }
  }
  if (mcpConfigMode === "clear" && normalized.mcpConfigPaths) {
    throw new LaunchProfileError(
      "mcpConfigMode=clear cannot be combined with mcpConfigPaths",
      "conflicting_mcp_config",
    );
  }
  if (mcpConfigMode === "replace" && !normalized.mcpConfigPaths) {
    throw new LaunchProfileError(
      "mcpConfigMode=replace requires mcpConfigPaths; use clear to remove every server",
      "conflicting_mcp_config",
    );
  }
  normalized.mcpConfigMode = mcpConfigMode;
  if (mcpConfigMode === "clear") {
    // Clearing the inherited servers only means something if the child is also
    // told not to fall back to its own discovered configuration.
    normalized.strictMcpConfig = true;
  }

  // Derived metadata, kept non-enumerable so it never reaches the identity
  // fingerprint, a JSON round-trip, or the unknown-field check above.
  Object.defineProperty(normalized, "symlinkFields", {
    value: Object.freeze([...pathNotes.symlinks]),
    enumerable: false,
  });
  Object.defineProperty(normalized, "__validated", { value: true, enumerable: false });
  return Object.freeze(normalized);
}

function isValidatedProfile(profile) {
  return Boolean(profile) && typeof profile === "object" && profile.__validated === true;
}

/**
 * The profile's logical identity: what an operator named it. Stable across
 * launches even if the resolved paths change.
 */
function profileLogicalIdentity(profile) {
  if (!profile) {
    return "legacy";
  }
  return profile.profileId || "anonymous";
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Build the effective launch for a profile.
 *
 * @returns {{profile: object|null, cwd: string, env: object, args: string[],
 *            mcpConfigPaths: string[], mcpConfigMode: string,
 *            launchFingerprint: string, telemetry: object|null}}
 */
function buildProfileLaunch({
  profile,
  baseEnv = {},
  baseCwd = "",
  baseMcpConfigPaths = [],
  extraArgs = [],
  baseDir = process.cwd(),
  allowAuthBackendOverride = false,
  allowCloudCredentialInheritance = false,
  fs = fsApi,
} = {}) {
  const normalized = validateLaunchProfile(profile, { baseDir, allowAuthBackendOverride, fs });

  if (!normalized) {
    return Object.freeze({
      profile: null,
      cwd: baseCwd,
      env: { ...baseEnv },
      args: Object.freeze([]),
      mcpConfigPaths: Object.freeze([...(baseMcpConfigPaths || [])]),
      mcpConfigMode: "inherit",
      launchFingerprint: "legacy",
      telemetry: null,
    });
  }

  if (!Array.isArray(extraArgs) || extraArgs.length) {
    // Raw extraArgs would let an unvalidated flag override a validated one.
    throw new LaunchProfileError(
      "launchProfile cannot be combined with raw extraArgs",
      "conflicting_args",
    );
  }

  const args = [];
  if (normalized.model) args.push("--model", normalized.model);
  if (normalized.effort) args.push("--effort", normalized.effort);
  if (normalized.configDir) args.push("--config-dir", normalized.configDir);
  for (const settingsPath of normalized.settings || []) {
    args.push("--settings", settingsPath);
  }
  if (normalized.builtInTools) args.push("--tools", normalized.builtInTools.join(","));
  if (normalized.agents) args.push("--agents", serializeAgents(normalized.agents));
  if (normalized.systemPrompt) args.push("--system-prompt", normalized.systemPrompt);
  if (normalized.outputStyle) args.push("--output-style", normalized.outputStyle);

  const mcpConfigMode = normalized.mcpConfigMode || "inherit";
  let mcpConfigPaths;
  if (mcpConfigMode === "clear") {
    mcpConfigPaths = [];
  } else if (mcpConfigMode === "replace") {
    mcpConfigPaths = [...(normalized.mcpConfigPaths || [])];
  } else {
    mcpConfigPaths = [...new Set([
      ...(baseMcpConfigPaths || []),
      ...(normalized.mcpConfigPaths || []),
    ])];
  }
  for (const mcpPath of mcpConfigPaths) {
    args.push("--mcp-config", mcpPath);
  }
  if (normalized.strictMcpConfig === true) {
    args.push("--strict-mcp-config");
  }

  const env = buildProfileEnv(baseEnv, normalized.env, { allowCloudCredentialInheritance });
  const cwd = normalized.cwd || baseCwd;

  const launchFingerprint = crypto
    .createHash("sha256")
    .update(stableStringify({
      args,
      cwd,
      mcpConfigMode,
      envOverlay: normalized.env ? { ...normalized.env } : null,
      cloudCredentialInheritance: Boolean(allowCloudCredentialInheritance),
      authBackendOverride: Boolean(allowAuthBackendOverride),
    }), "utf8")
    .digest("hex");

  return Object.freeze({
    profile: normalized,
    cwd,
    env,
    args: Object.freeze(args),
    mcpConfigPaths: Object.freeze(mcpConfigPaths),
    mcpConfigMode,
    launchFingerprint,
    telemetry: buildLaunchTelemetry(normalized, { mcpConfigPaths, mcpConfigMode }),
  });
}

function buildProfileEnv(baseEnv, overlay, { allowCloudCredentialInheritance = false } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (!allowCloudCredentialInheritance && isCloudCredentialEnvKey(key)) {
      // A profile must not be able to hand a differently-scoped child the
      // ambient AWS/GCP identity of the host process.
      continue;
    }
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overlay || {})) {
    env[key] = value;
  }
  return env;
}

function isCloudCredentialEnvKey(key) {
  return CLOUD_CREDENTIAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Launch telemetry: identity, shapes and counts only. Never a path, an
 * environment value, a model-facing prompt or a chat/topic id.
 */
function buildLaunchTelemetry(profile, { mcpConfigPaths = [], mcpConfigMode = "inherit" } = {}) {
  return Object.freeze({
    hasProfile: true,
    hasModel: Boolean(profile.model),
    effort: profile.effort || "",
    cwdSource: profile.cwd ? "profile" : "runtime",
    configDirSource: profile.configDir ? "profile" : "none",
    settingsCount: profile.settings?.length || 0,
    builtInToolCount: profile.builtInTools?.length || 0,
    agentCount: profile.agents ? Object.keys(profile.agents).length : 0,
    mcpConfigCount: mcpConfigPaths.length,
    mcpConfigMode,
    strictMcpConfig: profile.strictMcpConfig === true,
    instructionSource: profile.systemPrompt
      ? "system_prompt"
      : (profile.outputStyle ? "output_style" : "none"),
    symlinkFieldCount: profile.symlinkFields?.length || 0,
  });
}

/**
 * Fingerprint used for session-slot and process identity. `legacy` when no
 * profile is applied, so the unmapped path keeps its pre-v2 identity.
 */
function fingerprintLaunchProfile(profile, {
  baseDir = process.cwd(),
  allowAuthBackendOverride = false,
  fs = fsApi,
} = {}) {
  if (profile === undefined || profile === null) {
    return "legacy";
  }
  const normalized = validateLaunchProfile(profile, { baseDir, allowAuthBackendOverride, fs });
  if (!normalized) {
    return "legacy";
  }
  return crypto
    .createHash("sha256")
    .update(stableStringify({
      ...normalized,
      agents: normalized.agents ? JSON.parse(serializeAgents(normalized.agents)) : undefined,
      env: normalized.env ? { ...normalized.env } : undefined,
    }), "utf8")
    .digest("hex");
}

module.exports = {
  AGENT_PERMISSION_MODES,
  AUTH_BACKEND_ENV_KEYS,
  CLOUD_CREDENTIAL_ENV_PREFIXES,
  EFFORT_VALUES,
  LIMITS,
  LaunchProfileError,
  MCP_CONFIG_MODES,
  PROFILE_ENV_ALLOWLIST,
  PROFILE_FIELDS,
  buildLaunchTelemetry,
  buildProfileLaunch,
  canonicalProfileId,
  fingerprintLaunchProfile,
  profileLogicalIdentity,
  resolveExistingPath,
  stableStringify,
  validateLaunchProfile,
};
