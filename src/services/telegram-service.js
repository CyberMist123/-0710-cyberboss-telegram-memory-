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

const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

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
          body: JSON.stringify(withThreadId({
            chat_id: chatId,
            text: chunk,
          }, target.messageThreadId)),
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
      appendThreadId(payload, target.messageThreadId);
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
    async sendVoice({ filePath = "", userId = "" } = {}, context = {}) {
      const requestedPath = normalizeText(filePath);
      if (!requestedPath) {
        throw new Error("telegram send voice requires filePath");
      }
      const resolvedPath = path.resolve(requestedPath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`telegram voice file does not exist: ${resolvedPath}`);
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
      appendThreadId(payload, target.messageThreadId);
      payload.append("voice", new Blob([fs.readFileSync(resolvedPath)], { type: "audio/ogg" }), path.basename(resolvedPath));

      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: payload,
      }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
      return { userId: target.chatId, filePath: resolvedPath };
    },
  };
}

function resolveTelegramTarget(active, context = {}, userId = "") {
  // The topic comes from the turn that is currently active. An explicitly
  // addressed userId or a context hint keeps its own topic (or none), so a
  // model-initiated send can never be silently retargeted into a topic the
  // caller did not name.
  const activeThreadId = normalizeThreadId(active?.telegramMessageThreadId);

  const explicitUserId = normalizeText(userId);
  if (explicitUserId) {
    const sameChat = explicitUserId === normalizeText(active?.senderId)
      || explicitUserId === normalizeText(active?.telegramSenderId)
      || explicitUserId === normalizeText(active?.telegramChatId);
    return { chatId: explicitUserId, messageThreadId: sameChat ? activeThreadId : normalizeThreadId(context?.messageThreadId) };
  }

  const activeSenderId = normalizeText(active?.senderId);
  const activeProvider = normalizeText(active?.provider);
  if (activeProvider === "telegram" && activeSenderId) {
    return { chatId: activeSenderId, messageThreadId: activeThreadId };
  }

  const hintedChatId = normalizeText(context?.chatId);
  if (hintedChatId) {
    return { chatId: hintedChatId, messageThreadId: normalizeThreadId(context?.messageThreadId) };
  }

  const storedTelegramTarget = normalizeText(active?.telegramSenderId || active?.telegramUserId || active?.telegramChatId);
  if (storedTelegramTarget) {
    return { chatId: storedTelegramTarget, messageThreadId: activeThreadId };
  }

  return { chatId: "", messageThreadId: null };
}

function normalizeThreadId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value).trim();
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

function withThreadId(payload, messageThreadId) {
  const threadId = normalizeThreadId(messageThreadId);
  return threadId === null ? payload : { ...payload, message_thread_id: Number(threadId) };
}

function appendThreadId(form, messageThreadId) {
  const threadId = normalizeThreadId(messageThreadId);
  if (threadId !== null) {
    form.append("message_thread_id", threadId);
  }
  return form;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = { createTelegramSendService };
