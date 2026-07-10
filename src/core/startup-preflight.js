const fs = require("fs");

function validateStartupPreflight(config = {}) {
  const errors = [];
  requireDirectoryEnv(errors, "CYBERBOSS_STATE_DIR", config.stateDir, { mustExist: false });
  requireDirectoryEnv(errors, "CYBERBOSS_WORKSPACE", config.workspaceRoot, { mustExist: true });
  requireDirectoryEnv(errors, "CYBERBOSS_CONFIG_DIR", config.configDir, { mustExist: true });
  requireFileEnv(errors, "CYBERBOSS_PROMPT_FILE", config.promptFile || config.weixinInstructionsFile);

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
