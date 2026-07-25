const fs = require("fs");
const path = require("path");

class RuntimeContextStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { contextsByWorkspaceRoot: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.contextsByWorkspaceRoot) {
        this.state = {
          contextsByWorkspaceRoot: parsed.contextsByWorkspaceRoot,
        };
      }
    } catch {
      this.state = { contextsByWorkspaceRoot: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  setActiveContext({
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    bindingKey = "",
    accountId = "",
    senderId = "",
    provider = "",
    // Route lane of the turn that is currently active. Model-initiated sends
    // read it back so a reply lands in the topic that asked, not the chat's
    // default lane.
    chatId = "",
    messageThreadId = null,
  } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    const normalizedProvider = normalizeText(provider);
    const current = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot] || {};
    const next = {
      workspaceRoot: normalizedWorkspaceRoot,
      runtimeId: normalizeText(runtimeId),
      threadId: normalizeText(threadId),
      bindingKey: normalizeText(bindingKey),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      provider: normalizedProvider,
      telegramSenderId: normalizedProvider === "telegram"
        ? normalizeText(senderId)
        : normalizeText(current.telegramSenderId),
      telegramChatId: normalizedProvider === "telegram"
        ? normalizeText(chatId)
        : normalizeText(current.telegramChatId),
      telegramMessageThreadId: normalizedProvider === "telegram"
        ? normalizeNullableThreadId(messageThreadId)
        : (current.telegramMessageThreadId ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.state.contextsByWorkspaceRoot = {
      ...(this.state.contextsByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: next,
    };
    this.save();
    return next;
  }

  resolveActiveContext({ workspaceRoot = "", runtimeId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (normalizedWorkspaceRoot) {
      const exact = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot];
      if (exact) {
        return exact;
      }
    }

    const entries = Object.values(this.state.contextsByWorkspaceRoot || {})
      .filter((entry) => entry && typeof entry === "object");
    const normalizedRuntimeId = normalizeText(runtimeId);
    const scoped = normalizedRuntimeId
      ? entries.filter((entry) => normalizeText(entry.runtimeId) === normalizedRuntimeId)
      : entries;
    const sorted = scoped.sort((left, right) => {
      const leftMs = Date.parse(left.updatedAt || "") || 0;
      const rightMs = Date.parse(right.updatedAt || "") || 0;
      return rightMs - leftMs;
    });
    return sorted[0] || null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableThreadId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value).trim();
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

module.exports = { RuntimeContextStore };

