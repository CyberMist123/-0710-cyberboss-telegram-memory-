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
const {
  DEFAULT_ACCESS,
  canonicalWorkspaceKey,
  normalizeAccessMode,
} = require("../../../core/workspace-lock");
const {
  EFFORT_VALUES,
  assertLaunchArgsSupported,
  resolveCliCapabilities,
} = require("./cli-capabilities");

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
  "configRoot",
  "settings",
  "builtInTools",
  "agents",
  "mcpConfigPaths",
  "mcpConfigMode",
  "strictMcpConfig",
  "systemPrompt",
  "outputStyle",
  "workspaceAccess",
]));

const G3_PROFILE_FIELDS = Object.freeze(new Set([
  "schemaVersion",
  "harnessMode",
  "settingSources",
  "skillsMode",
  "personaSource",
  "residentToolSchemas",
  "mcpServerCeiling",
  "toolsetCeiling",
  "defaultMcpServerSet",
  "defaultToolset",
  "permissionMode",
  "envPolicy",
]));

const G3_PROFILE_SCHEMA_VERSION = 3;
const G3_PROFILE_IDS = Object.freeze(["fable-chat", "work-engineering"]);
const G3_MCP_SERVER_CEILINGS = Object.freeze(["chat-ceiling@1", "work-ceiling@1"]);
const G3_TOOLSET_CEILINGS = Object.freeze(["chat-ceiling@1", "work-ceiling@1"]);
const G3_PERMISSION_MODES = Object.freeze([
  "profile-local-least-privilege",
  "work-engineering-full",
]);
const G3_ENV_POLICIES = Object.freeze(["chat-minimal", "work-engineering"]);
const G3_RESIDENT_TOOL_SCHEMAS = Object.freeze(["cyberboss_system_send", "cyberboss_time"]);

// Sourced from the CLI capability table so the enum cannot drift from what the
// installed Claude CLI actually accepts.
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

/**
 * A base directory must be supplied explicitly. Falling back to the process
 * working directory makes a relative profile path resolve differently depending
 * on where the bridge was started, which is exactly the portability hazard
 * Codex flagged.
 */
function requireBaseDir(baseDir, field) {
  const text = typeof baseDir === "string" ? baseDir.trim() : "";
  if (!text) {
    throw new LaunchProfileError(
      `${field} needs an explicit profile base directory; none was configured`,
      "missing_base_dir",
    );
  }
  return text;
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
  const normalizedBaseDir = path.resolve(requireBaseDir(baseDir, field));
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
  baseDir = "",
  allowAuthBackendOverride = false,
  capabilities = null,
  fs = fsApi,
  g3Enabled = resolveG3PreflightEnabled() || resolveG3ProfileContractEnabled(),
  g3ProfileContractEnabled = resolveG3ProfileContractEnabled(),
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
  const profileContractEnabled = g3ProfileContractEnabled;
  if (profileContractEnabled && !resolveG3PreflightEnabled()) {
    throw new LaunchProfileError("G3 profile contract requires G3 preflight", "g3_preflight_required");
  }
  if (g3Enabled && profile.configRoot !== undefined && profile.configDir !== undefined) {
    throw new LaunchProfileError(
      "configRoot and configDir cannot both be set",
      "config_root_conflict",
    );
  }

  const keys = Object.keys(profile);
  for (const key of keys) {
    assertSafeKey(key, "launchProfile");
    if (!PROFILE_FIELDS.has(key) && !(profileContractEnabled && G3_PROFILE_FIELDS.has(key))) {
      throw new LaunchProfileError(`launchProfile contains an unknown field: ${key}`, "unknown_field");
    }
  }

  const normalized = {};
  const pathNotes = { symlinks: [] };

  if (profile.profileId !== undefined) {
    normalized.profileId = canonicalProfileId(profile.profileId);
  }
  if (profileContractEnabled) {
    validateG3ProfileContract(profile, normalized, { baseDir, fs });
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

  const caps = capabilities || resolveCliCapabilities();
  for (const field of ["configDir", "outputStyle"]) {
    if (profile[field] !== undefined && !caps.supportsField(field)) {
      // Fail closed *before* launch. Passing an undeclared flag would either
      // abort the child or, worse, be ignored -- silently dropping the
      // restriction the operator asked for.
      throw new LaunchProfileError(
        `${field} maps to ${caps.flagForField(field)}, which the verified Claude CLI `
        + `(${caps.verifiedVersion}) does not declare; declare it in `
        + "CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON if your CLI supports it",
        "cli_flag_unsupported",
      );
    }
  }

  if (profile.cwd !== undefined) {
    const resolved = resolveExistingPath(profile.cwd, { field: "cwd", baseDir, kind: "dir", fs });
    normalized.cwd = resolved.path;
    if (resolved.isSymbolicLink) pathNotes.symlinks.push("cwd");
  }
  if (g3Enabled && profile.configRoot !== undefined) {
    const resolved = resolveExistingPath(profile.configRoot, {
      field: "configRoot", baseDir, kind: "dir", fs,
    });
    normalized.configRoot = canonicalWorkspaceKey(resolved.path, { fs });
    if (resolved.isSymbolicLink) pathNotes.symlinks.push("configRoot");
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
    if (g3Enabled && Object.prototype.hasOwnProperty.call(profile.env, "CLAUDE_CONFIG_DIR")) {
      throw new LaunchProfileError(
        "CLAUDE_CONFIG_DIR is owned by configRoot and cannot be overridden",
        "config_root_env_conflict",
      );
    }
    normalized.env = normalizeProfileEnv(profile.env, { allowAuthBackendOverride });
  }
  if (profile.workspaceAccess !== undefined) {
    // Scheduling attribute, not a CLI flag: it decides whether this profile's
    // turns may run beside another lane's turn in the same working directory.
    normalized.workspaceAccess = normalizeAccessMode(profile.workspaceAccess);
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
  mutableOverride = null,
  baseEnv = {},
  baseCwd = "",
  baseMcpConfigPaths = [],
  extraArgs = [],
  baseDir = "",
  allowAuthBackendOverride = false,
  allowCloudCredentialInheritance = false,
  capabilities = null,
  fs = fsApi,
} = {}) {
  const g3Enabled = resolveG3PreflightEnabled(baseEnv)
    || resolveG3ProfileContractEnabled(baseEnv)
    || resolveG3ProfileContractEnabled();
  const caps = capabilities || resolveCliCapabilities();
  const normalized = validateLaunchProfile(profile, {
    baseDir, allowAuthBackendOverride, capabilities: caps, fs, g3Enabled,
    g3ProfileContractEnabled: resolveG3ProfileContractEnabled(baseEnv) || resolveG3ProfileContractEnabled(),
  });

  if (!normalized) {
    return Object.freeze({
      profile: null,
      cwd: baseCwd,
      env: { ...baseEnv },
      args: Object.freeze([]),
      mcpConfigPaths: Object.freeze([...(baseMcpConfigPaths || [])]),
      mcpConfigMode: "inherit",
      workspaceAccess: DEFAULT_ACCESS,
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
  // NOTE: workspaceAccess is deliberately absent here. It schedules turns; it is
  // not a CLI flag and must never be passed to the child.
  const effectiveModel = mutableOverride?.model || normalized.model || "";
  const effectiveEffort = mutableOverride?.effort || normalized.effort || "";
  if (effectiveModel) args.push("--model", effectiveModel);
  if (effectiveEffort) args.push("--effort", effectiveEffort);
  if (profileContractEnabledFor(normalized)) {
    if (normalized.harnessMode === "bare") args.push("--bare");
    if (normalized.skillsMode === "disabled") args.push("--disable-slash-commands");
    args.push("--setting-sources", normalized.settingSources.join(","));
  }
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

  const env = buildProfileEnv(baseEnv, normalized.env, {
    allowCloudCredentialInheritance,
    g3Enabled,
    configRoot: normalized.configRoot || "",
  });
  const cwd = g3Enabled
    ? canonicalWorkspaceKey(normalized.cwd || baseCwd, { fs })
    : (normalized.cwd || baseCwd);

  // Belt: nothing unsupported reaches the child even if a future field forgets
  // its capability check.
  assertLaunchArgsSupported(args, caps);

  const launchFingerprint = crypto
    .createHash("sha256")
    .update(stableStringify({
      args,
      cwd,
      mcpConfigMode,
      envOverlay: normalized.env ? { ...normalized.env } : null,
      cloudCredentialInheritance: Boolean(allowCloudCredentialInheritance),
      authBackendOverride: Boolean(allowAuthBackendOverride),
      ...(g3Enabled ? { configRoot: normalized.configRoot || "" } : {}),
    }), "utf8")
    .digest("hex");

  return Object.freeze({
    profile: normalized,
    cwd,
    env,
    args: Object.freeze(args),
    mcpConfigPaths: Object.freeze(mcpConfigPaths),
    mcpConfigMode,
    workspaceAccess: normalized.workspaceAccess || DEFAULT_ACCESS,
    permissionMode: resolveProfileCliPermissionMode(normalized),
    launchFingerprint,
    telemetry: buildLaunchTelemetry(normalized, {
      mcpConfigPaths,
      mcpConfigMode,
      g3Enabled,
      mutableOverride,
    }),
  });
}

const G3_HOST_ENV_ALLOWLIST = Object.freeze(new Set([
  // Executable discovery for the Claude child and its helpers.
  "PATH", "Path",
  // Windows process creation and standard OS command discovery.
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR",
  // Per-launch scratch storage; no credential-bearing home directories.
  "TEMP", "TMP", "TMPDIR",
  // Locale/encoding needed for stable stream-json transport.
  "LANG", "LC_ALL", "PYTHONUTF8",
  // Terminal capability only; contains no identity or credential.
  "TERM", "NO_COLOR", "CI",
]));

function buildProfileEnv(baseEnv, overlay, {
  allowCloudCredentialInheritance = false,
  g3Enabled = false,
  configRoot = "",
} = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (!allowCloudCredentialInheritance && isCloudCredentialEnvKey(key)) {
      // A profile must not be able to hand a differently-scoped child the
      // ambient AWS/GCP identity of the host process.
      continue;
    }
    if (g3Enabled && !G3_HOST_ENV_ALLOWLIST.has(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overlay || {})) {
    if (g3Enabled && key === "CLAUDE_CONFIG_DIR") {
      throw new LaunchProfileError(
        "CLAUDE_CONFIG_DIR is owned by configRoot and cannot be overridden",
        "config_root_env_conflict",
      );
    }
    env[key] = value;
  }
  if (g3Enabled) {
    if (!configRoot) {
      throw new LaunchProfileError("configRoot is required when G3 preflight is enabled", "config_root_required");
    }
    env.CLAUDE_CONFIG_DIR = configRoot;
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
function buildLaunchTelemetry(profile, {
  mcpConfigPaths = [], mcpConfigMode = "inherit", g3Enabled = false, mutableOverride = null,
} = {}) {
  if (g3Enabled) {
    const telemetry = {
      profile_token: hashToken(profileLogicalIdentity(profile)),
      profile_schema_version: profile.schemaVersion || 3,
      config_root_token: hashToken(profile.configRoot || ""),
      cwd_source: profile.cwd ? "profile" : "runtime",
      env_policy: "allowlist",
      strict_mcp: profile.strictMcpConfig === true,
      cli_version: "",
      cli_help_hash: "",
      session_slot_token: "",
      native_session_present: false,
    };
    if (profileContractEnabledFor(profile)) {
      Object.assign(telemetry, {
        harness_mode: profile.harnessMode,
        setting_sources_shape: profile.settingSources.join("+"),
        skills_mode: profile.skillsMode,
        settings_count: profile.settings?.length || 0,
        mcp_server_set_id: hashToken(profile.defaultMcpServerSet),
        toolset_ceiling_id: hashToken(profile.toolsetCeiling),
        effective_mcp_set_id: mutableOverride
          ? mutableOverride.trace.entries.find((item) => item.kind === "effective_mcp_set")?.effective_token || ""
          : hashToken(profile.defaultMcpServerSet),
        effective_toolset_id: mutableOverride
          ? mutableOverride.trace.entries.find((item) => item.kind === "effective_toolset")?.effective_token || ""
          : hashToken(profile.defaultToolset),
        model_source: mutableOverride
          ? mutableOverride.trace.entries.find((item) => item.kind === "model")?.source || "runtime"
          : (profile.model ? "profile_default" : "runtime"),
        effort_source: mutableOverride
          ? mutableOverride.trace.entries.find((item) => item.kind === "effort")?.source || "runtime"
          : (profile.effort ? "profile_default" : "runtime"),
        harness_overlay_tokens: mutableOverride
          ? mutableOverride.trace.entries
            .filter((item) => item.kind === "harness_overlay")
            .map((item) => item.effective_token)
          : [],
        permission_mode: profile.permissionMode,
      });
    }
    return Object.freeze(telemetry);
  }
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
    workspaceAccess: profile.workspaceAccess || DEFAULT_ACCESS,
    instructionSource: profile.systemPrompt
      ? "system_prompt"
      : (profile.outputStyle ? "output_style" : "none"),
    symlinkFieldCount: profile.symlinkFields?.length || 0,
  });
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

function resolveG3PreflightEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED || "").trim());
}

function resolveG3ProfileContractEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED || "").trim());
}

function profileContractEnabledFor(profile) {
  return Boolean(profile?.schemaVersion === G3_PROFILE_SCHEMA_VERSION && G3_PROFILE_IDS.includes(profile.profileId));
}

/**
 * Fingerprint used for session-slot and process identity. `legacy` when no
 * profile is applied, so the unmapped path keeps its pre-v2 identity.
 */
function fingerprintLaunchProfile(profile, {
  baseDir = "",
  allowAuthBackendOverride = false,
  capabilities = null,
  fs = fsApi,
} = {}) {
  if (profile === undefined || profile === null) {
    return "legacy";
  }
  const normalized = validateLaunchProfile(profile, {
    baseDir, allowAuthBackendOverride, capabilities, fs,
  });
  if (!normalized) {
    return "legacy";
  }
  if (profileContractEnabledFor(normalized)) {
    return fingerprintG3ProfileIdentity(normalized, { fs });
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

function validateG3ProfileContract(profile, normalized, { baseDir, fs = fsApi } = {}) {
  if (profile.schemaVersion !== G3_PROFILE_SCHEMA_VERSION) {
    throw new LaunchProfileError("schemaVersion must be 3", "g3_profile_schema_version_invalid");
  }
  if (!G3_PROFILE_IDS.includes(normalized.profileId)) {
    throw new LaunchProfileError("profileId is not a managed G3 identity", "g3_profile_identity_unknown");
  }
  for (const field of ["cwd", "configRoot", "settings", "personaSource"]) {
    if (profile[field] === undefined) {
      throw new LaunchProfileError(`${field} is required by the managed profile contract`, "g3_profile_field_required");
    }
  }
  if (profile.strictMcpConfig !== true) {
    throw new LaunchProfileError("strictMcpConfig must be true for managed profiles", "g3_profile_contract_mismatch");
  }
  normalized.schemaVersion = G3_PROFILE_SCHEMA_VERSION;
  normalized.harnessMode = enumField(profile.harnessMode, "harnessMode", ["bare", "engineering"]);
  normalized.skillsMode = enumField(profile.skillsMode, "skillsMode", ["disabled", "enabled"]);
  normalized.settingSources = normalizeStringList(profile.settingSources, {
    field: "settingSources", maxItems: 3, maxLength: 16,
  });
  for (const source of normalized.settingSources) {
    if (!["user", "project", "local"].includes(source)) {
      throw new LaunchProfileError("settingSources contains an unsupported source", "g3_setting_source_invalid");
    }
  }
  normalized.residentToolSchemas = normalizeStringList(profile.residentToolSchemas, {
    field: "residentToolSchemas", maxItems: 8, maxLength: LIMITS.builtInToolName,
  });
  normalized.mcpServerCeiling = enumField(profile.mcpServerCeiling, "mcpServerCeiling", G3_MCP_SERVER_CEILINGS);
  normalized.toolsetCeiling = enumField(profile.toolsetCeiling, "toolsetCeiling", G3_TOOLSET_CEILINGS);
  normalized.defaultMcpServerSet = nonEmptyBoundedString(profile.defaultMcpServerSet, "defaultMcpServerSet", 64);
  normalized.defaultToolset = nonEmptyBoundedString(profile.defaultToolset, "defaultToolset", 64);
  normalized.permissionMode = enumField(profile.permissionMode, "permissionMode", G3_PERMISSION_MODES);
  normalized.envPolicy = enumField(profile.envPolicy, "envPolicy", G3_ENV_POLICIES);
  const persona = resolveExistingPath(profile.personaSource, {
    field: "personaSource", baseDir, kind: "file", fs,
  });
  normalized.personaSource = persona.path;

  const fable = normalized.profileId === "fable-chat";
  const expected = fable ? {
    harnessMode: "bare", skillsMode: "disabled", settingSources: ["user"],
    residentToolSchemas: G3_RESIDENT_TOOL_SCHEMAS, mcpServerCeiling: "chat-ceiling@1",
    toolsetCeiling: "chat-ceiling@1", permissionMode: "profile-local-least-privilege",
    envPolicy: "chat-minimal",
  } : {
    harnessMode: "engineering", skillsMode: "enabled", settingSources: ["user", "project", "local"],
    mcpServerCeiling: "work-ceiling@1",
    toolsetCeiling: "work-ceiling@1", permissionMode: "work-engineering-full",
    envPolicy: "work-engineering",
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = normalized[field];
    const matches = Array.isArray(value)
      ? stableStringify(actual) === stableStringify(value)
      : actual === value;
    if (!matches) throw new LaunchProfileError(`${field} violates the managed profile contract`, "g3_profile_contract_mismatch");
  }
}

function enumField(value, field, allowed) {
  const text = nonEmptyBoundedString(value, field, 64);
  if (!allowed.includes(text)) throw new LaunchProfileError(`${field} is not supported`, "invalid_enum");
  return text;
}

function fileDigest(filePath, fs = fsApi) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fingerprintG3ProfileIdentity(profile, { fs = fsApi } = {}) {
  const identity = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    cwd: profile.cwd,
    configRoot: profile.configRoot,
    harnessMode: profile.harnessMode,
    settingSources: profile.settingSources,
    skillsMode: profile.skillsMode,
    settings: (profile.settings || []).map((filePath) => fileDigest(filePath, fs)),
    persona: fileDigest(profile.personaSource, fs),
    mcpServerCeiling: profile.mcpServerCeiling,
    toolsetCeiling: profile.toolsetCeiling,
    permissionMode: profile.permissionMode,
    envPolicy: profile.envPolicy,
  };
  return crypto.createHash("sha256").update(stableStringify(identity), "utf8").digest("hex");
}

function resolveProfileCliPermissionMode(profile) {
  if (!profileContractEnabledFor(profile)) return "";
  return profile.permissionMode === "profile-local-least-privilege" ? "default" : "inherit";
}

module.exports = {
  AGENT_PERMISSION_MODES,
  EFFORT_VALUES,
  AUTH_BACKEND_ENV_KEYS,
  CLOUD_CREDENTIAL_ENV_PREFIXES,
  LIMITS,
  LaunchProfileError,
  MCP_CONFIG_MODES,
  PROFILE_ENV_ALLOWLIST,
  PROFILE_FIELDS,
  G3_HOST_ENV_ALLOWLIST,
  buildLaunchTelemetry,
  buildProfileLaunch,
  canonicalProfileId,
  fingerprintLaunchProfile,
  fingerprintG3ProfileIdentity,
  profileLogicalIdentity,
  resolveG3PreflightEnabled,
  resolveG3ProfileContractEnabled,
  resolveExistingPath,
  stableStringify,
  validateLaunchProfile,
};
