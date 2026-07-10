const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SleepModeStore } = require("../core/checkin-config-store");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

class SystemMessageService {
  constructor({ config, sessionStore }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.sleepMode = new SleepModeStore({ filePath: config.sleepScheduleFile });
  }

  queueMessage({ text = "", userId = "", workspaceRoot = "" } = {}, context = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      throw new Error("system send requires text");
    }

    const account = resolveChannelAccount(this.config);
    const senderId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    const resolvedWorkspaceRoot = normalizeText(workspaceRoot)
      || normalizeText(context?.workspaceRoot)
      || resolvePreferredWorkspaceRoot({
        config: this.config,
        accountId: account.accountId,
        senderId,
        sessionStore: this.sessionStore,
      });

    if (!senderId || !resolvedWorkspaceRoot) {
      throw new Error("system send requires a sender and workspace");
    }
    if (!path.isAbsolute(resolvedWorkspaceRoot)) {
      throw new Error(`workspace must be an absolute path: ${resolvedWorkspaceRoot}`);
    }

    let workspaceStats = null;
    try {
      workspaceStats = fs.statSync(resolvedWorkspaceRoot);
    } catch {
      throw new Error(`workspace does not exist: ${resolvedWorkspaceRoot}`);
    }
    if (!workspaceStats.isDirectory()) {
      throw new Error(`workspace is not a directory: ${resolvedWorkspaceRoot}`);
    }

    const contextToken = resolveChannelContextToken({
      config: this.config,
      accountId: account.accountId,
      senderId,
    });
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${senderId}. Let this user talk to the bot once first.`);
    }

    return this.queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId,
      workspaceRoot: resolvedWorkspaceRoot,
      text: normalizedText,
      sourceType: "manual",
      createdAt: new Date().toISOString(),
    });
  }

  enableSleepMode({ startedAt = "" } = {}) {
    const result = this.sleepMode.setSleeping({ startedAt });
    console.error(`[cyberboss] sleep mode write source=tool action=enable mode=sleeping startedAt=${result.startedAt || startedAt || ""}`);
    return result;
  }

  disableSleepMode({ resumedAt = "" } = {}) {
    const result = this.sleepMode.setAwake({ resumedAt });
    console.error(`[cyberboss] sleep mode write source=tool action=disable mode=awake resumedAt=${result.resumedAt || resumedAt || ""}`);
    return result;
  }

  getSleepMode() {
    return this.sleepMode.getState();
  }

  enableSleepSchedule(args = {}) {
    return this.enableSleepMode(args);
  }

  disableSleepSchedule(args = {}) {
    return this.disableSleepMode(args);
  }

  getSleepSchedule() {
    return this.getSleepMode();
  }
}

function resolveChannelAccount(config) {
  if (normalizeText(config?.channel) === "telegram") {
    return {
      accountId: normalizeText(config?.accountId) || "telegram",
    };
  }
  return resolveSelectedAccount(config);
}

function resolveChannelContextToken({ config, accountId, senderId }) {
  const normalizedSenderId = normalizeText(senderId);
  if (!normalizedSenderId) {
    return "";
  }
  if (normalizeText(config?.channel) === "telegram") {
    return `telegram:${normalizedSenderId}`;
  }
  const contextTokens = loadPersistedContextTokens(config, accountId);
  return String(contextTokens[normalizedSenderId] || "").trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  SystemMessageService,
  resolveChannelAccount,
  resolveChannelContextToken,
};
