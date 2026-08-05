const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelFileService {
  constructor({ config, channelAdapter, sessionStore }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
  }

  // `as` picks the presentation, not the transport: "file" is a plain
  // attachment, "animation" asks the channel to render the GIF inline the way a
  // sticker reads in chat. Adapters that have no inline form (WeChat) simply
  // lack `sendAnimation` and fall back to the attachment.
  async sendToCurrentChat({ filePath = "", userId = "", as = "file" } = {}, context = {}) {
    const account = resolveChannelAccount(this.config);
    const targetUserId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    if (!targetUserId) {
      throw new Error("Cannot determine which chat should receive the file.");
    }

    const contextToken = resolveChannelContextToken({
      config: this.config,
      accountId: account.accountId,
      senderId: targetUserId,
    });
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }

    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }

    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 1,
      contextToken,
    }).catch(() => {});
    const sendInline = as === "animation" && typeof this.channelAdapter.sendAnimation === "function";
    const send = sendInline
      ? this.channelAdapter.sendAnimation.bind(this.channelAdapter)
      : this.channelAdapter.sendFile.bind(this.channelAdapter);
    await send({
      userId: targetUserId,
      filePath: resolvedPath,
      contextToken,
    });
    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 0,
      contextToken,
    }).catch(() => {});
    return { userId: targetUserId, filePath: resolvedPath, sentAs: sendInline ? "animation" : "file" };
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
  ChannelFileService,
  resolveChannelAccount,
  resolveChannelContextToken,
};
