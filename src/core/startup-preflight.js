const fs = require("fs");
const path = require("path");

function validateStartupPreflight(config = {}) {
  const errors = [];
  requireDirectoryEnv(errors, "CYBERBOSS_STATE_DIR", config.stateDir, { mustExist: false });
  requireDirectoryEnv(errors, "CYBERBOSS_WORKSPACE", config.workspaceRoot, { mustExist: true });
  requireDirectoryEnv(errors, "CYBERBOSS_CONFIG_DIR", config.configDir, { mustExist: true });
  requireFileEnv(errors, "CYBERBOSS_PROMPT_FILE", config.promptFile || config.weixinInstructionsFile);
  requireDirectoryEnv(errors, "CYBERBOSS_CONTINUITY_DIR", config.continuityDir, { mustExist: false });
  validateContinuityBoundary(errors, config);
  validateLegacyMemoryGates(errors, config);

  if (String(config.channel || "").trim().toLowerCase() === "telegram") {
    requireSecretEnv(errors, "CYBERBOSS_TELEGRAM_BOT_TOKEN", config.telegramBotToken);
    requireSecretEnv(errors, "CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS", config.telegramAllowedUserIds);
  }

  if (errors.length) {
    throw new Error([
      "Startup preflight failed.",
      ...errors.map((message) => `- ${message}`),
    ].join("\n"));
  }
}

function validateContinuityBoundary(errors, config = {}) {
  const continuityDir = normalizeText(config.continuityDir);
  if (!continuityDir) return;
  const stateDir = normalizeText(config.stateDir);
  if (stateDir && pathsOverlap(continuityDir, stateDir)) {
    errors.push("CYBERBOSS_CONTINUITY_DIR must be outside CYBERBOSS_STATE_DIR.");
  }
  const memoryDir = normalizeText(config.memoryDir);
  if (!memoryDir) return;
  // 20260712 合并裁定：FRAMEWORK.md 把 workspace 的 memory\ 定为唯一正式
  // continuity 根（episodes/reentry/candidates/decisions 同居一处）。
  // 精确同根且四个 legacy 记忆开关全关时放行；嵌套或部分重叠仍然禁止，
  // legacy 写路径仍可能启用时也仍然禁止。
  const sameRoot = isSameOrWithin(continuityDir, memoryDir) && isSameOrWithin(memoryDir, continuityDir);
  const legacyGatesOff = ![
    config.legacyMemoryRetrieval,
    config.legacyMemoryBackgroundWrite,
    config.legacyMemoryReplyTransform,
    config.includeLegacyMemoryRelays,
  ].some((value) => value === true);
  if (sameRoot && legacyGatesOff) return;
  if (pathsOverlap(continuityDir, memoryDir)) {
    errors.push("CYBERBOSS_CONTINUITY_DIR must be outside CYBERBOSS_MEMORY_DIR unless it equals it with all legacy memory gates off.");
  }
}

function validateLegacyMemoryGates(errors, config = {}) {
  const enabled = [
    ["CYBERBOSS_MEMORY_RETRIEVAL", config.legacyMemoryRetrieval],
    ["CYBERBOSS_MEMORY_BACKGROUND_WRITE", config.legacyMemoryBackgroundWrite],
    ["CYBERBOSS_MEMORY_REPLY_TRANSFORM", config.legacyMemoryReplyTransform],
    ["CYBERBOSS_INCLUDE_LEGACY_MEMORY_RELAYS", config.includeLegacyMemoryRelays],
  ].filter(([, value]) => value === true);
  for (const [name] of enabled) {
    errors.push(`${name} must remain off during Phase 2-5A.`);
  }
}

function isSameOrWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isSameOrWithin(left, right) || isSameOrWithin(right, left);
}

function requireDirectoryEnv(errors, envName, value, { mustExist }) {
  const normalized = normalizeText(value);
  if (!normalized) {
    errors.push(`${envName} is required.`);
    return;
  }
  if (mustExist && !safeIsDirectory(normalized)) {
    errors.push(`${envName} must point to an existing directory.`);
  }
}

function requireFileEnv(errors, envName, value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    errors.push(`${envName} is required.`);
    return;
  }
  if (!safeIsFile(normalized)) {
    errors.push(`${envName} must point to an existing file.`);
  }
}

function requireSecretEnv(errors, envName, value) {
  if (Array.isArray(value)) {
    if (!value.length) {
      errors.push(`${envName} is required.`);
    }
    return;
  }
  if (!normalizeText(value)) {
    errors.push(`${envName} is required.`);
  }
}

function safeIsDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function safeIsFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { validateStartupPreflight };
