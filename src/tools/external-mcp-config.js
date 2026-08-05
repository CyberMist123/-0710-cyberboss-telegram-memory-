const fs = require("fs");
const path = require("path");

function resolveExternalMcpServerConfig({
  nameEnv,
  commandEnv,
  argsEnv,
  defaultName,
} = {}) {
  const command = normalizeText(process.env[commandEnv]);
  if (!command) {
    return null;
  }
  const name = normalizeText(process.env[nameEnv]) || defaultName;
  const args = parseArgsEnv(process.env[argsEnv]);
  return {
    name,
    command,
    args,
  };
}

function resolveExternalMcpServerConfigs({
  legacy = [],
  extraJsonEnv = "CYBERBOSS_EXTRA_MCP_SERVERS",
  extraDirEnv = "CYBERBOSS_EXTRA_MCP_SERVERS_DIR",
} = {}) {
  const configs = [];
  for (const item of Array.isArray(legacy) ? legacy : []) {
    const resolved = resolveExternalMcpServerConfig(item);
    if (resolved) {
      configs.push(resolved);
    }
  }
  for (const extra of parseExtraServerConfigs(process.env[extraJsonEnv])) {
    configs.push(extra);
  }
  // Folder registry entries append last, so the existing first-wins dedupe
  // keeps legacy and CYBERBOSS_EXTRA_MCP_SERVERS entries authoritative on
  // name collisions. Unset env / missing directory = empty set (default off).
  for (const extra of loadServerConfigsFromDir(process.env[extraDirEnv])) {
    configs.push(extra);
  }
  return dedupeServerConfigs(configs);
}

function loadServerConfigsFromDir(value) {
  const dir = normalizeText(value);
  if (!dir) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Directory missing or unreadable = empty set; the registry is opt-in
    // and must never take the runtime down (fail-open).
    return [];
  }
  const configs = [];
  for (const entry of entries.filter((item) => item.toLowerCase().endsWith(".json")).sort()) {
    const filePath = path.join(dir, entry);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      console.warn(`[external-mcp-config] skipping ${filePath}: unreadable or invalid JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[external-mcp-config] skipping ${filePath}: expected a JSON object`);
      continue;
    }
    if (parsed.enabled !== true) {
      continue;
    }
    const name = normalizeText(parsed.name);
    const command = normalizeText(parsed.command);
    if (!name || !command) {
      console.warn(`[external-mcp-config] skipping ${filePath}: missing name or command`);
      continue;
    }
    const args = Array.isArray(parsed.args)
      ? parsed.args.map((item) => normalizeText(item)).filter(Boolean)
      : parseArgsEnv(parsed.args);
    const env = normalizeEnvObject(parsed.env);
    configs.push({
      name,
      command,
      args,
      ...(env ? { env } : {}),
    });
  }
  return configs;
}

function parseExtraServerConfigs(value) {
  const text = normalizeText(value);
  if (!text) {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const configs = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const name = normalizeText(entry.name);
    const command = normalizeText(entry.command);
    if (!name || !command) {
      continue;
    }
    const args = Array.isArray(entry.args)
      ? entry.args.map((item) => normalizeText(item)).filter(Boolean)
      : parseArgsEnv(entry.args);
    const env = normalizeEnvObject(entry.env);
    configs.push({
      name,
      command,
      args,
      ...(env ? { env } : {}),
    });
  }
  return configs;
}

function normalizeEnvObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const env = {};
  for (const [key, entry] of Object.entries(value)) {
    const envKey = normalizeText(key);
    const envValue = normalizeText(entry);
    if (!envKey || !envValue) {
      continue;
    }
    env[envKey] = envValue;
  }
  return Object.keys(env).length ? env : null;
}

function dedupeServerConfigs(configs) {
  const seen = new Set();
  const result = [];
  for (const config of configs) {
    const name = normalizeText(config && config.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push(config);
  }
  return result;
}

function parseArgsEnv(value) {
  const text = normalizeText(value);
  if (!text) {
    return [];
  }
  return text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  resolveExternalMcpServerConfig,
  resolveExternalMcpServerConfigs,
};
