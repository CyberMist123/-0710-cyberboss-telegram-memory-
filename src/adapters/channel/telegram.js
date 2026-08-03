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
const {
  buildTelegramMediaDescriptors,
  pickLargestTelegramPhoto: pickLargestTelegramPhotoDescriptor,
} = require("../../services/telegram-media-descriptor");
const {
  RouteLaneError,
  canonicalTelegramMessageThreadId,
  normalizeInboundMessageThreadId,
} = require("../../core/route-lane");
const { buildTelegramBotCommands } = require("../../core/command-registry");

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
  let setMyCommandsCalled = false;
  // Publish the Telegram command menu from the command-registry once per process.
  // Default ON (a menu-sync fix, idempotent + fail-open); set
  // CYBERBOSS_TELEGRAM_SET_COMMANDS_DISABLED=1 to turn off.
  const setMyCommandsEnabled = !/^(?:1|true|yes|on)$/i.test(
    String(process.env.CYBERBOSS_TELEGRAM_SET_COMMANDS_DISABLED || "").trim()
  );

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
      // Publish the command menu once, from the same registry that builds /help.
      // Fail-open: a failed setMyCommands never blocks polling.
      if (!setMyCommandsCalled) {
        setMyCommandsCalled = true;
        if (setMyCommandsEnabled) {
          try {
            const commands = buildTelegramBotCommands();
            await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/setMyCommands`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ commands }),
            }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
            writeTelegramLog(config, `setMyCommands ok count=${commands.length}`);
          } catch (error) {
            writeTelegramLog(config, `setMyCommands failed (non-fatal): ${formatTelegramError(error)}`);
          }
        }
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
      // The route lane needs the topic id even though only private chats are
      // accepted today: the nullable-thread semantics must be preserved
      // end-to-end so a future forum/supergroup lane cannot silently reuse the
      // default lane's turn gate, buffers, reply target or Claude session.
      // A message whose topic id is present but non-canonical is dropped rather
      // than routed on a guess.
      let messageThreadId;
      try {
        messageThreadId = normalizeInboundMessageThreadId(message.message_thread_id);
      } catch (error) {
        writeTelegramLog(
          config,
          `drop non-canonical message_thread_id messageId=${messageId} reason=${error instanceof RouteLaneError ? error.code : "invalid"}`,
        );
        return null;
      }
      const dedupeKey = `${normalizeText(message.chat?.id)}:${messageThreadId ?? "-"}:${messageId}`;
      if (state.seenMessageKeys.has(dedupeKey)) {
        writeTelegramLog(config, `drop duplicate messageKey=${dedupeKey}`);
        return null;
      }
      state.seenMessageKeys.add(dedupeKey);
      saveTelegramState(config, state);
      const media = buildTelegramMediaDescriptors(message);
      const text = buildIncomingText(message);
      if (!text) {
        return null;
      }
      return {
        provider: "telegram",
        accountId: account.accountId,
        workspaceId: normalizeText(config?.workspaceId) || "default",
        senderId,
        chatId: normalizeText(message.chat?.id),
        messageThreadId,
        messageId: normalizeText(message.message_id),
        threadKey: buildTelegramThreadKey(message.chat?.id, messageThreadId),
        text,
        attachments: [],
        contextToken: `telegram:${normalizeText(message.chat?.id)}`,
        receivedAt: new Date(((Number(message.date) || Math.floor(Date.now() / 1000)) * 1000)).toISOString(),
        telegram: {
          chatId: normalizeText(message.chat?.id),
          messageThreadId,
          messageId: normalizeText(message.message_id),
          userId: senderId,
          username: normalizeText(message.from?.username),
          firstName: normalizeText(message.from?.first_name),
          lastName: normalizeText(message.from?.last_name),
          caption: normalizeText(message.caption),
          media,
          voice: media.find((item) => item.kind === "voice") || null,
          audio: media.find((item) => item.kind === "audio") || null,
          photo: media.find((item) => item.kind === "photo") || null,
          sticker: media.find((item) => item.kind === "sticker") || null,
        },
      };
    },
    async fetchFileById({ fileId, maxSizeBytes = 0 }) {
      if (!token) throw new Error("telegram bot token missing");
      const normalizedFileId = normalizeText(fileId);
      if (!normalizedFileId) throw new Error("telegram fetchFileById requires fileId");
      const sizeLimitBytes = Number(maxSizeBytes) > 0 ? Number(maxSizeBytes) : 0;
      const meta = await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: normalizedFileId }),
      }, TELEGRAM_REQUEST_TIMEOUT_MS);
      const remotePath = normalizeText(meta?.result?.file_path);
      if (!remotePath) throw new Error("telegram getFile returned no file_path");
      const declaredSizeBytes = Number(meta?.result?.file_size) || 0;
      if (sizeLimitBytes && declaredSizeBytes > sizeLimitBytes) {
        throw new Error(`telegram file exceeds size limit: ${declaredSizeBytes} > ${sizeLimitBytes} bytes`);
      }
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${remotePath}`, {
        signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS * 2),
      });
      if (!response.ok) throw new Error(`telegram file download failed: ${response.status}`);
      const bytes = await readResponseBytesBounded(response, sizeLimitBytes);
      if (!bytes.length) throw new Error("telegram file download returned empty body");
      return {
        bytes,
        remotePath,
        fileName: path.basename(remotePath),
        sizeBytes: bytes.length,
      };
    },
    async sendVoice({ userId, filePath, messageThreadId = null }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedPath = normalizeText(filePath);
      if (!userId || !normalizedPath) {
        throw new Error("telegram sendVoice requires userId and filePath");
      }
      const threadId = resolveOutboundThreadId(messageThreadId);
      const form = new FormData();
      form.append("chat_id", String(userId));
      appendThreadIdToForm(form, threadId);
      form.append("voice", new Blob([fs.readFileSync(normalizedPath)], { type: "audio/ogg" }), path.basename(normalizedPath));
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      }, Math.max(TELEGRAM_REQUEST_TIMEOUT_MS, 20_000), { allowEmptyJson: true });
      writeTelegramLog(config, `sendVoice ok userId=${normalizeText(userId)} thread=${threadId ?? "-"} path=${normalizedPath}`);
    },
    async sendPhoto({ userId, filePath, caption = "", messageThreadId = null }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedPath = normalizeText(filePath);
      if (!userId || !normalizedPath) {
        throw new Error("telegram sendPhoto requires userId and filePath");
      }
      const threadId = resolveOutboundThreadId(messageThreadId);
      const form = new FormData();
      form.append("chat_id", String(userId));
      appendThreadIdToForm(form, threadId);
      const normalizedCaption = normalizeText(caption);
      if (normalizedCaption) {
        form.append("caption", normalizedCaption);
      }
      form.append("photo", new Blob([fs.readFileSync(normalizedPath)]), path.basename(normalizedPath));
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
      }, Math.max(TELEGRAM_REQUEST_TIMEOUT_MS, 20_000), { allowEmptyJson: true });
      writeTelegramLog(config, `sendPhoto ok userId=${normalizeText(userId)} thread=${threadId ?? "-"} path=${normalizedPath}`);
    },
    async sendText({ userId, text, messageThreadId = null }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const threadId = resolveOutboundThreadId(messageThreadId);
      const chunks = chunkReplyTextForTelegram(String(text || ""), minChunkChars);
      for (const chunk of chunks) {
        const payload = applyThreadId({
          chat_id: String(userId),
          text: String(chunk || ""),
        }, threadId);
        try {
          await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true });
          writeTelegramLog(
            config,
            `sendText ok userId=${payload.chat_id} thread=${threadId ?? "-"} text=${truncateForLog(payload.text)}`
          );
        } catch (error) {
          writeTelegramLog(
            config,
            `sendText failed userId=${payload.chat_id} thread=${threadId ?? "-"} error=${formatTelegramError(error)} text=${truncateForLog(payload.text)}`
          );
          throw error;
        }
      }
    },
    async sendTyping({ userId, messageThreadId = null }) {
      if (!token || !userId) {
        return;
      }
      const threadId = resolveOutboundThreadId(messageThreadId);
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applyThreadId({
          chat_id: String(userId),
          action: "typing",
        }, threadId)),
      }, TELEGRAM_REQUEST_TIMEOUT_MS, { allowEmptyJson: true }).catch((error) => {
        writeTelegramLog(
          config,
          `sendTyping failed userId=${normalizeText(userId)} thread=${threadId ?? "-"} error=${formatTelegramError(error)}`
        );
      });
    },
    async sendFile({ userId, filePath, messageThreadId = null }) {
      if (!token) {
        throw new Error("telegram bot token missing");
      }
      const normalizedPath = normalizeText(filePath);
      if (!userId || !normalizedPath) {
        throw new Error("telegram sendFile requires userId and filePath");
      }
      const threadId = resolveOutboundThreadId(messageThreadId);
      const form = new FormData();
      form.append("chat_id", String(userId));
      appendThreadIdToForm(form, threadId);
      form.append("document", new Blob([fs.readFileSync(normalizedPath)]), path.basename(normalizedPath));
      await fetchJsonWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: form,
      }, Math.max(TELEGRAM_REQUEST_TIMEOUT_MS, 20_000), { allowEmptyJson: true });
      writeTelegramLog(config, `sendFile ok userId=${normalizeText(userId)} thread=${threadId ?? "-"} path=${normalizedPath}`);
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

// Every outbound Telegram call funnels through these two helpers, so adding a
// new send verb without a `message_thread_id` is a visible omission rather than
// a silent cross-topic delivery.
function resolveOutboundThreadId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return canonicalTelegramMessageThreadId(value);
}

function applyThreadId(payload, threadId) {
  if (threadId === null || threadId === undefined) {
    return payload;
  }
  return { ...payload, message_thread_id: Number(threadId) };
}

function appendThreadIdToForm(form, threadId) {
  if (threadId === null || threadId === undefined) {
    return form;
  }
  form.append("message_thread_id", String(threadId));
  return form;
}

// Lane-shaped thread key: a chat's default lane and one of its topics must not
// collapse to the same key.
function buildTelegramThreadKey(chatId, messageThreadId) {
  const normalizedChatId = normalizeText(chatId);
  if (!normalizedChatId) {
    return "";
  }
  return messageThreadId === null || messageThreadId === undefined
    ? normalizedChatId
    : `${normalizedChatId}:${messageThreadId}`;
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

function buildIncomingText(message) {
  const text = normalizeText(message.text);
  if (text) {
    return text;
  }
  const description = getNonTextDescription(message);
  const caption = normalizeText(message.caption);
  if (description && caption) {
    return `${description} ${caption}`;
  }
  return description || caption;
}

function sanitizeMediaFileName(value) {
  const normalized = normalizeText(value).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/^\.+/, "");
  return normalized.slice(0, 120);
}

function resolveUniqueTargetPath(targetDir, fileName) {
  const parsed = path.parse(fileName);
  const baseName = parsed.name || "tg-file";
  const extension = parsed.ext || "";
  let candidate = path.join(targetDir, `${baseName}${extension}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetDir, `${baseName}-${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
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

async function readResponseBytesBounded(response, maxSizeBytes) {
  if (!response.body?.getReader) {
    throw new Error("telegram file download requires bounded streaming response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (maxSizeBytes && total > maxSizeBytes) {
        await reader.cancel();
        throw new Error("telegram file exceeds size limit during download");
      }
      chunks.push(chunk);
    }
    completed = true;
  } catch (error) {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

module.exports = {
  applyThreadId,
  appendThreadIdToForm,
  buildTelegramThreadKey,
  chunkReplyTextForTelegram,
  createTelegramChannelAdapter,
  readResponseBytesBounded,
  resolveOutboundThreadId,
};
