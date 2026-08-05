const fs = require("fs");
const path = require("path");
const { resolveExternalMcpServerConfigs } = require("../../../tools/external-mcp-config");
const { envFlagEnabled, isEnabledFlagValue } = require("../../../core/env-flag");

/**
 * Per-route MCP configuration.
 *
 * The shared `.mcp.json` is a workspace singleton, so every lane's Claude child
 * used to spawn a tool server that could only identify itself by workspace.
 * With two topics running at once, whichever turn wrote the active context last
 * owned every outbound tool send.
 *
 * When a routeToken is supplied we additionally write a per-slot config whose
 * `cyberboss_tools` entry carries `--route-token`, and launch the child against
 * that file. The tool server then knows exactly which lane it belongs to.
 */
function ensureRouteScopedMcpConfig({
  workspaceRoot,
  cyberbossHome = "",
  routeToken = "",
  configDir = "",
  launchProfile = null,
  mutableOverride = null,
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const normalizedToken = normalizeText(routeToken);
  const normalizedConfigDir = normalizeText(configDir);
  if (!normalizedWorkspaceRoot || !normalizedToken || !normalizedConfigDir) {
    return null;
  }
  if (!/^[0-9a-f]{16,128}$/.test(normalizedToken)) {
    throw new Error("route token must be an opaque lowercase hex identifier");
  }

  fs.mkdirSync(normalizedConfigDir, { recursive: true });
  const configPath = path.join(normalizedConfigDir, `route-${normalizedToken.slice(0, 16)}.json`);
  const next = {
    mcpServers: {
      cyberboss_tools: buildClaudeProjectMcpServerConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        cyberbossHome,
        routeToken: normalizedToken,
        launchProfile,
        mutableOverride,
      }),
      ...Object.fromEntries(resolveAllowedExternalMcpServerConfigs(launchProfile, mutableOverride).map((config) => [config.name, config])),
    },
  };
  if (!jsonEquals(readJsonObject(configPath), next)) {
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return { configPath, serverName: "cyberboss_tools", routeToken: normalizedToken, config: next };
}

function ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Claude project tools.");
  }

  const configPath = path.join(normalizedWorkspaceRoot, ".mcp.json");
  const current = readJsonObject(configPath);
  const externalMcpServerConfigs = resolveClaudeExternalMcpServerConfigs();
  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
      cyberboss_tools: buildClaudeProjectMcpServerConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        cyberbossHome,
      }),
      ...Object.fromEntries(externalMcpServerConfigs.map((config) => [config.name, config])),
    },
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath,
    serverName: "cyberboss_tools",
    config: next,
  };
}

function buildClaudeProjectMcpServerConfig({
  workspaceRoot, cyberbossHome = "", routeToken = "", launchProfile = null, mutableOverride = null,
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const home = normalizeText(cyberbossHome) || process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cyberboss MCP entrypoint not found: ${scriptPath}`);
  }
  const args = [scriptPath, "tool-mcp-server", "--runtime-id", "claudecode", "--workspace-root", normalizedWorkspaceRoot];
  const normalizedToken = normalizeText(routeToken);
  if (normalizedToken) {
    args.push("--route-token", normalizedToken);
  }
  const authorizationCeiling = resolveToolAuthorizationCeiling(launchProfile);
  if (authorizationCeiling) args.push("--authorization-ceiling", authorizationCeiling);
  const entry = { command: process.execPath, args };
  // The tool server is our own process, not the isolated one -- what G3 strips
  // is the *Claude* child's environment, and this server is started by that
  // child. With the host allowlist applied it inherits no CYBERBOSS_* key at
  // all, so `loadEnv()` finds nothing and the process exits in startup
  // preflight before it can register a single tool. Forwarding the env file
  // (not CYBERBOSS_CONFIG_DIR: production points that at a directory with no
  // `.env` in it) restores the whole deployment env for this child only.
  const envFile = normalizeText(process.env.CYBERBOSS_ENV_FILE);
  if (envFile) {
    entry.env = { ...(entry.env || {}), CYBERBOSS_ENV_FILE: envFile };
  }
  if (normalizedToken) {
    // Passed twice on purpose: the argument is what the server reads, the
    // environment variable is a belt-and-braces signal for a launcher that
    // rewrites argv.
    entry.env = { ...(entry.env || {}), CYBERBOSS_ROUTE_TOKEN: normalizedToken };
  }
  if (launchProfile?.schemaVersion === 3 && launchProfile.profileId === "fable-chat") {
    entry.env = { ...(entry.env || {}), CYBERBOSS_TOOL_CATALOG_ENABLED: "true" };
  }
  const toolset = mutableOverride?.effectiveToolset && mutableOverride.effectiveToolset !== "full"
    ? mutableOverride.effectiveToolset
    : (typeof process.env.CYBERBOSS_TOOL_CATALOG_TOOLSET === "string" ? process.env.CYBERBOSS_TOOL_CATALOG_TOOLSET.trim() : "");
  const catalogEnabled = isEnabledFlagValue(entry.env?.CYBERBOSS_TOOL_CATALOG_ENABLED)
    || envFlagEnabled("CYBERBOSS_TOOL_CATALOG_ENABLED");
  if (catalogEnabled && toolset) args.push("--toolset", toolset);
  if (mutableOverride && launchProfile?.profileId === "fable-chat") {
    args.push("--chat-self-escalation");
    entry.env = { ...(entry.env || {}), CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED: "true" };
  }
  if (mutableOverride?.capabilityLease && route2GateEnabled()) {
    args.push("--route2-lease", Buffer.from(JSON.stringify(mutableOverride.capabilityLease), "utf8").toString("base64url"));
    entry.env = { ...(entry.env || {}), CYBERBOSS_ROUTE2_GATE_ENABLED: "true" };
  }
  // The tool-mcp-server child runs with an isolated env (only what we forward
  // here). memory_candidate_submit registers when the child sees signing on
  // (tool-host `registeredProjectTools` -> subjectSigningEnabled(child env)),
  // so the flag must be forwarded explicitly or the subject tool never
  // registers even with the bridge-side switch on. Scoped to the fable-chat
  // subject profile so work-engineering's child never registers it (G3).
  if (subjectSigningEnabled() && launchProfile?.schemaVersion === 3 && launchProfile.profileId === "fable-chat") {
    entry.env = { ...(entry.env || {}), CYBERBOSS_SUBJECT_SIGNING_ENABLED: "true" };
  }
  return entry;
}

function route2GateEnabled(env = process.env) {
  return envFlagEnabled("CYBERBOSS_ROUTE2_GATE_ENABLED", env);
}

function subjectSigningEnabled(env = process.env) {
  return envFlagEnabled("CYBERBOSS_SUBJECT_SIGNING_ENABLED", env);
}

function resolveAllowedExternalMcpServerConfigs(launchProfile, mutableOverride = null) {
  const available = resolveClaudeExternalMcpServerConfigs();
  const allowed = available;
  if (!Array.isArray(mutableOverride?.effectiveMcpSet)) return allowed;
  const requested = new Set(mutableOverride.effectiveMcpSet.filter((name) => name !== "cyberboss_tools"));
  const known = new Set(allowed.map((config) => config.name));
  for (const name of requested) {
    if (!known.has(name)) {
      const error = new Error("window_override_mcp_outside_ceiling");
      error.code = "window_override_mcp_outside_ceiling";
      throw error;
    }
  }
  return allowed.filter((config) => requested.has(config.name));
}

function resolveToolAuthorizationCeiling(launchProfile) {
  if (launchProfile?.schemaVersion !== 3) return "";
  if (launchProfile.profileId === "fable-chat") return "";
  if (launchProfile.profileId === "work-engineering") return "work-memory-readonly@1";
  const error = new Error("g3_tool_authorization_identity_unknown");
  error.code = "g3_tool_authorization_identity_unknown";
  throw error;
}

function resolveClaudeExternalMcpServerConfigs() {
  return resolveExternalMcpServerConfigs({
    legacy: [{
      nameEnv: "CYBERBOSS_MUSIC_MCP_NAME",
      commandEnv: "CYBERBOSS_MUSIC_MCP_COMMAND",
      argsEnv: "CYBERBOSS_MUSIC_MCP_ARGS",
      defaultName: "netease_music_mcp",
    }],
  });
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureClaudeProjectMcpConfig,
  ensureRouteScopedMcpConfig,
  buildClaudeProjectMcpServerConfig,
  resolveClaudeExternalMcpServerConfigs,
  resolveAllowedExternalMcpServerConfigs,
  resolveToolAuthorizationCeiling,
};
