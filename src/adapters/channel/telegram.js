const fs = require("fs");
const path = require("path");
const dns = require("dns");
const {
  TelegramRateLimitError,
  fetchJsonWithRetry,
  fetchJsonWithTimeout,
  sleep,
} = require("./telegram-utils");
const {
  DEFAULT_MIN_WEIXIN_CHUNK,
  normalizeMinChunkChars,
} = require("./weixin/config-store");
const {
  chunkReplyTextForWeixin,
  normalizeWeixinReplyText,
} = require("./weixin/index");

try {
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
} catch {}

const TELEGRAM_GET_UPDATES_TIMEOUT_MS = 20_000;
const TELEGRAM_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_TELEGRAM_CHUNK = DEFAULT_MIN_WEIXIN_CHUNK;

function createTelegramChannelAdapter(config) {
  const token = normalizeText(config?.telegramBotToken);
  const allowedUserIds = new Set((Array.isArray(config?.telegramAllowedUserIds) ? config.telegramAllowedUserIds : []).map(normalizeText).filter(Boolean));
  const state = loadTelegramState(config);
  let minChunkChars = state.minChunkChars;
  const account = {
    accountId: normalizeText(config?.accountId) || "telegram",
    baseUrl: "https://api.telegram.org",
    tokenState: token ? "configured" : "missing",
  };

  let deleteWebhookCalled = false;

  return {
    describe() {
      return {
        id: "telegram",
        kind: "channel",
        state: token ? "enabled" : "disabled",
      };
    },
    async login() {},
    printAccounts() {
      console.log("Telegram account:");
      console.log(`- accountId: ${account.accountId}`);
      console.log(`  botToken: ${account.tokenState}`);
      console.log(`  allowedUserIds: ${allowedUserIds.size ? Array.from(allowedUserIds).join(", ") : "(all private users)"}`);
    },
    resolveAccount() {
      return { ...account };
    },
    loadSyncBuffer() {
      return "";
    },
    saveSyncBuffer() {},
    async getUpdates({ timeoutMs = 30_000 } = {}) {
      if (!token) {
        return { ok: false, result: [] };
      }
      // Disconnect any lingering long-poll connections from prior process lifetime,
      // preventing 409 Conflict on getUpdates.
      if (!deleteWebhookCalled) {
        deleteWebhookCalled = true;
        try {
          await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
        } catch {}
      }
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set("timeout", String(Math.max(0, Math.floor(timeoutMs / 1000))));
      if (state.offset > 0) {
        url.searchParams.set("offset", String(state.offset));
      }
      const requestTimeoutMs = Math.max(TELEGRAM_GET_UPDATES_TIMEOUT_MS, timeoutMs + 5_000);
      const json = await fetchJsonWithRetry(url, { method: "GET" }, requestTimeoutMs);
      const updates = Array.isArray(json?.result) ? json.result : [];
      if (updates.length) {
        writeTelegramLog(config, `getUpdates count=${updates.length} offset=${state.offset} firstUpdateId=${updates[0]?.update_id ?? ""}`);
      }
      const maxUpdateId = updates.reduce((max, item) => Math.max(max, Number(item?.update_id) || 0), 0);
      const nextOffset = maxUpdateId > 0 ? maxUpdateId + 1 : state.offset;
      if (nextOffset > state.offset) {
        state.offset = nextOffset;
        saveTelegramState(config, state);
      }
      return json;
    },
    normalizeIncomingMessage(update) {
      const message = update?.message || update?.edited_message || null;
      if (!message || String(message.chat?.type || "") !== "private") {
        return null;
      }
      if (message.from?.is_bot) {
        return null;
      }
      const senderId = normalizeText(message.from?.id);
      if (!senderId || (allowedUserIds.size && !allowedUserIds.has(senderId))) {
        return null;
      }
      const messageId = normalizeText(message.message_id);
      if (!messageId) {
        return null;
      }
      const dedupeKey = `${normalizeText(message.chat?.id)}:${messageId}`;
      if (state.seenMessageKeys.has(dedupeKey)) {
        writeTelegramLog(config, `drop duplicate messageKey=${dedupeKey}`);
        return null;
      }
      state.seenMessageKeys.add(dedupeKey);
      saveTelegramState(config, state);
      const text = normalizeText(message.text) || getNonTextDescription(message);
      if (!text) {
        return null;
      }
      return {
        provider: "telegram",
        accountId: account.accountId,
        workspaceId: normalizeText(config?.workspaceId) || "default",
        senderId,
        chatId: normalizeText(message.chat?.id),
        messageId: normalizeText(message.message_id),
        threadKey: normalizeText(message.chat?.id),
        text,
        attachments: [],
        contextToken: `telegram:${normalizeText(message.chat?.id)}`,
        receivedAt: new Date(((Number(message.date) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
        telegram: {
          chatId: normalizeText(message.chat?.id),
          messageId: normalizeText(message.message_id),
          userId: senderId,
          username: normalizeText(message.from?.username),
          firstName: normalizeText(message.from?.first_name),
          lastName: normalizeText(message.from?.last_name),
          voice: message.voice
            ? {
                fileId: normalizeText(message.voice.file_id),
                durationSec: Number(message.voice.duration) || 0,
                mimeType: normalizeText(message.voice.mime_type) || "audio/ogg",
                sizeBytes: Number(message.voice.file_size) || 0,
              }
            : null,
        },
      };
    },
    async downloadFileById({ fileId, targetDir }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedFileId = normalizeText(fileId);
      const normalizedTargetDir = normalizeText(targetDir);
      if (!normalizedFileId || !normalizedTargetDir) {
        throw new Error("telegram downloadFileById requires fileId and targetDir");
      }
      const meta = await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: normalizedFileId }),
      }, TELEGRAM_REQUEST_TIMEOUT_MS);
      const remotePath = normalizeText(meta?.result?.file_path);
      if (!remotePath) {
        throw new Error("telegram getFile returned no file_path");
      }
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${remotePath}`, {
        signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS * 2),
      });
      if (!response.ok) {
        throw new Error(`telegram file download failed: ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        throw new Error("telegram file download returned empty body");
      }
      const extension = path.extname(remotePath) || ".bin";
      const fileName = `tg-${Date.now()}-${normalizedFileId.slice(-8)}${extension}`;
      fs.mkdirSync(normalizedTargetDir, { recursive: true });
      const absolutePath = path.join(normalizedTargetDir, fileName);
      fs.writeFileSync(absolutePath, bytes);
      writeTelegramLog(config, `downloadFileById ok fileId=${normalizedFileId} path=${absolutePath} sizeBytes=${bytes.length}`);
      return { absolutePath, fileName, sizeBytes: bytes.length };
    },
    async sendVoice({ userId, filePath }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedPath = normalizeText(filePath);
      if (!userId || !normalizedPath) {
        throw new Error("telegram sendVoice requires userId and filePath");
      }
      const form = new FormData();
      form.append("chat_id", String(userId));
      form.append("voice", new Blob([fs.readFileSync(normalizedPath)], { type: "audio/ogg" }), path.basename(normalizedPath));
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      }, Math.max(TELEGRAM_REQUEST_TIMEOUT_MS, 20_000), { allowEmptyJson: true });
      writeTelegramLog(config, `sendVoice ok userId=${normalizeText(userId)} path=${normalizedPath}`);
    },
    async sendText({ userId, text }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const chunks = chunkReplyTextForTelegram(String(text || ""), minChunkChars);
      for (const chunk of chunks) {
        const payload = {
          chat_id: String(userId),
          text: String(chunk || ""),
        };
        try {
          await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
          writeTelegramLog(
            config,
            `sendText ok userId=${payload.chat_id} text=${truncateForLog(payload.text)}`
          );
        } catch (error) {
          writeTelegramLog(
            config,
            `sendText failed userId=${payload.chat_id} error=${formatTelegramError(error)} text=${truncateForLog(payload.text)}`
          );
          throw error;
        }
      }
    },
    async sendTyping({ userId }) {
      if (!token || !userId) {
        return;
      }
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(userId),
          action: "typing",
        }),
      }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true }).catch((error) => {
        writeTelegramLog(
          config,
          `sendTyping failed userId=${normalizeText(userId)} error=${formatTelegramError(error)}`
        );
      });
    },
    async sendFile({ userId, filePath }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedPath = normalizeText(filePath);
      if (!userId || !normalizedPath) {
        throw new Error("telegram sendFile requires userId and filePath");
      }
      const form = new FormData();
      form.append("chat_id", String(userId));
      form.append("document", new Blob([fs.readFileSync(normalizedPath)]), path.basename(normalizedPath));
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: form,
      }, Math.max(TELEGRAM_REQUEST_TIMEOUT_MS, 20_000), { allowEmptyJson: true });
    },
    setMinChunkChars(value) {
      minChunkChars = normalizeMinChunkChars(value, DEFAULT_MIN_TELEGRAM_CHUNK);
      state.minChunkChars = minChunkChars;
      saveTelegramState(config, state);
      return minChunkChars;
    },
    getMinChunkChars() {
      return minChunkChars;
    },
    getKnownContextTokens() {
      return {};
    },
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function truncateForLog(text, maxLength = 120) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function formatTelegramError(error) {
  if (!error) {
    return "unknown";
  }
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function chunkReplyTextForTelegram(text, minChunk = DEFAULT_MIN_TELEGRAM_CHUNK) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) {
    return [];
  }
  return chunkReplyTextForWeixin(normalized, minChunk);
}

function getNonTextDescription(message) {
  if (message.photo) return "[图片]";
  if (message.sticker) return "[贴纸]";
  if (message.video) return "[视频]";
  const docName = normalizeText(message.document?.file_name || message.document?.file_name || "");
  if (message.document) return `[文件: ${docName}]`.replace(": ]", "]");
  if (message.voice) return "[语音]";
  if (message.audio) return "[音频]";
  if (message.location) return "[位置]";
  if (message.contact) return "[联系人]";
  return "";
}

function writeTelegramLog(config, message) {
  if (!config?.telegramStateFile) {
    throw new Error("CYBERBOSS_STATE_DIR is required before writing telegram poller logs.");
  }
  const baseDir = path.dirname(config.telegramStateFile);
  const filePath = path.join(baseDir, "telegram-poller.log");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function loadTelegramState(config) {
  const filePath = normalizeText(config?.telegramStateFile);
  if (!filePath) {
    return { offset: 0, seenMessageKeys: new Set(), minChunkChars: DEFAULT_MIN_TELEGRAM_CHUNK };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      offset: Number(parsed?.offset) || 0,
      seenMessageKeys: new Set(Array.isArray(parsed?.seenMessageKeys) ? parsed.seenMessageKeys.map(normalizeText).filter(Boolean) : []),
      minChunkChars: normalizeMinChunkChars(parsed?.minChunkChars, DEFAULT_MIN_TELEGRAM_CHUNK),
    };
  } catch {
    return { offset: 0, seenMessageKeys: new Set(), minChunkChars: DEFAULT_MIN_TELEGRAM_CHUNK };
  }
}

function saveTelegramState(config, state) {
  const filePath = normalizeText(config?.telegramStateFile);
  if (!filePath) {
    return;
  }
  const payload = {
    offset: Number(state?.offset) || 0,
    seenMessageKeys: Array.from(state?.seenMessageKeys || []),
    minChunkChars: normalizeMinChunkChars(state?.minChunkChars, DEFAULT_MIN_TELEGRAM_CHUNK),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

module.exports = { createTelegramChannelAdapter, chunkReplyTextForTelegram };
