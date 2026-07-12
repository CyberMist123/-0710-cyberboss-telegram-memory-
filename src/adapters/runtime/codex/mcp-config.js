const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");
const { resolveExternalMcpServerConfigs } = require("../../../tools/external-mcp-config");

function resolveCodexProjectToolMcpServerConfig({ cyberbossHome = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
    env: buildCodexToolServerEnv(),
  };
}

function buildCodexToolServerEnv() {
  const env = {};
  for (const key of [
    "CYBERBOSS_TELEGRAM_BOT_TOKEN",
    "CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS",
    "CYBERBOSS_CONTINUITY_DIR",
    "CYBERBOSS_STATE_DIR",
    "CYBERBOSS_CHANNEL",
    "CYBERBOSS_ACCOUNT_ID",
  ]) {
    if (typeof process.env[key] === "string" && process.env[key].trim()) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function resolveCodexExternalMcpServerConfigs() {
  return resolveExternalMcpServerConfigs({
    legacy: [{
      nameEnv: "CYBERBOSS_MUSIC_MCP_NAME",
      commandEnv: "CYBERBOSS_MUSIC_MCP_COMMAND",
      argsEnv: "CYBERBOSS_MUSIC_MCP_ARGS",
      defaultName: "netease_music_mcp",
    }],
  });
}

function buildCodexMcpConfigArgs(mcpServerConfig, extraServerConfigs = []) {
  const configs = [];
  if (mcpServerConfig && typeof mcpServerConfig === "object") {
    configs.push(mcpServerConfig);
  }
  for (const externalConfig of resolveCodexExternalMcpServerConfigs()) {
    configs.push(externalConfig);
  }
  if (Array.isArray(extraServerConfigs)) {
    for (const extra of extraServerConfigs) {
      if (extra && typeof extra === "object") {
        configs.push(extra);
      }
    }
  }
  if (!configs.length) {
    return [];
  }
  const configArgs = [];
  for (const mcpServerConfig of configs) {
    const name = normalizeNonEmptyString(mcpServerConfig.name) || "cyberboss_tools";
    const command = normalizeNonEmptyString(mcpServerConfig.command);
    const args = Array.isArray(mcpServerConfig.args)
      ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
      : [];
    if (!command) {
      continue;
    }
    configArgs.push(
      "-c",
      `mcp_servers.${name}.command=${quoteTomlString(command)}`,
      "-c",
      `mcp_servers.${name}.args=${formatTomlArray(args)}`,
    );
    const env = mcpServerConfig.env && typeof mcpServerConfig.env === "object"
      ? mcpServerConfig.env
      : null;
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (!normalizeNonEmptyString(key) || !normalizeNonEmptyString(value)) {
          continue;
        }
        configArgs.push(
          "-c",
          `mcp_servers.${name}.env.${key}=${quoteTomlString(value)}`,
        );
      }
    }
    for (const toolName of listProjectToolNames()) {
      configArgs.push(
        "-c",
        `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
      );
    }
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
  resolveCodexExternalMcpServerConfigs,
};
