const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { chunkReplyTextForTelegram } = require("../adapters/channel/telegram");
const {
  TelegramRateLimitError,
  fetchJsonWithRetry,
  fetchJsonWithTimeout,
  sleep,
} = require("../adapters/channel/telegram-utils");

try {
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
} catch {}

const TELEGRAM_REQUEST_TIMEOUT_MS = 20_000;

function createTelegramSendService({ config, runtimeContextStore }) {
  return {
    async sendText({ text = "", userId = "" } = {}, context = {}) {
      const normalizedText = normalizeText(text);
      if (!normalizedText) {
        throw new Error("telegram send requires text");
      }

      const active = runtimeContextStore?.resolveActiveContext?.({
        workspaceRoot: normalizeText(context?.workspaceRoot),
        runtimeId: normalizeText(context?.runtimeId),
      }) || {};
      const target = resolveTelegramTarget(active, context, userId);
      if (!target.chatId) {
        throw new Error("telegram reply target missing");
      }

      const token = normalizeText(config?.telegramBotToken);
      if (!token) {
        throw new Error("telegram bot token missing");
      }

      const chatId = target.chatId;

      const chunks = chunkReplyTextForTelegram(normalizedText);
      if (!chunks.length) {
        return { userId: chatId, text: normalizedText };
      }
      for (const chunk of chunks) {
        await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
          }),
        }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
      }
      return { userId: chatId, text: normalizedText };
    },
    async sendFile({ filePath = "", caption = "", userId = "" } = {}, context = {}) {
      const requestedPath = normalizeText(filePath);
      if (!requestedPath) {
        throw new Error("telegram send file requires filePath");
      }
      const resolvedPath = path.resolve(requestedPath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`telegram file does not exist: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        throw new Error(`telegram send file expects a file, got: ${resolvedPath}`);
      }

      const active = runtimeContextStore?.resolveActiveContext?.({
        workspaceRoot: normalizeText(context?.workspaceRoot),
        runtimeId: normalizeText(context?.runtimeId),
      }) || {};
      const target = resolveTelegramTarget(active, context, userId);
      if (!target.chatId) {
        throw new Error("telegram reply target missing");
      }

      const token = normalizeText(config?.telegramBotToken);
      if (!token) {
        throw new Error("telegram bot token missing");
      }

      const payload = new FormData();
      payload.append("chat_id", target.chatId);
      if (normalizeText(caption)) {
        payload.append("caption", normalizeText(caption));
      }
      payload.append("document", new Blob([fs.readFileSync(resolvedPath)]), path.basename(resolvedPath));

      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: payload,
      }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
      return { userId: target.chatId, filePath: resolvedPath, caption: normalizeText(caption) };
    },
  };
}

function resolveTelegramTarget(active, context = {}, userId = "") {
  const explicitUserId = normalizeText(userId);
  if (explicitUserId) {
    return { chatId: explicitUserId };
  }

  const activeSenderId = normalizeText(active?.senderId);
  const activeProvider = normalizeText(active?.provider);
  if (activeProvider === "telegram" && activeSenderId) {
    return { chatId: activeSenderId };
  }

  const hintedChatId = normalizeText(context?.chatId);
  if (hintedChatId) {
    return { chatId: hintedChatId };
  }

  const storedTelegramTarget = normalizeText(active?.telegramSenderId || active?.telegramUserId || active?.telegramChatId);
  if (storedTelegramTarget) {
    return { chatId: storedTelegramTarget };
  }

  return { chatId: "" };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = { createTelegramSendService };
