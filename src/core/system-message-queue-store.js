const fs = require("fs");
const path = require("path");

class SystemMessageQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { messages: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      this.state = {
        messages: messages
          .map(normalizeSystemMessage)
          .filter(Boolean)
          .sort(compareSystemMessages),
      };
    } catch {
      this.state = { messages: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(message) {
    this.load();
    const normalized = normalizeSystemMessage(message);
    if (!normalized) {
      throw new Error("invalid system message");
    }
    this.state.messages.push(normalized);
    this.state.messages.sort(compareSystemMessages);
    this.save();
    return normalized;
  }

  drainForAccount(accountId, { shouldDrain = null } = {}) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const drained = [];
    const pending = [];

    for (const message of this.state.messages) {
      if (
        message.accountId === normalizedAccountId
        && (typeof shouldDrain !== "function" || shouldDrain(message))
      ) {
        drained.push(message);
      } else {
        pending.push(message);
      }
    }

    if (drained.length) {
      this.state.messages = pending;
      this.save();
    }

    return drained;
  }

  hasPendingForAccount(accountId, { shouldInclude = null } = {}) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) =>
      message.accountId === normalizedAccountId
      && (typeof shouldInclude !== "function" || shouldInclude(message))
    );
  }
}

function normalizeSystemMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const id = normalizeText(message.id);
  const accountId = normalizeText(message.accountId);
  const senderId = normalizeText(message.senderId);
  const workspaceRoot = normalizeText(message.workspaceRoot);
  const text = normalizeText(message.text);
  const createdAt = normalizeIsoTime(message.createdAt);
  const sourceType = normalizeText(message.sourceType) || "system";

  if (!id || !accountId || !senderId || !workspaceRoot || !text) {
    return null;
  }

  return {
    id,
    accountId,
    senderId,
    workspaceRoot,
    text,
    sourceType,
    createdAt: createdAt || new Date().toISOString(),
    ...(Number.isInteger(Number(message.deliveryAttempts)) && Number(message.deliveryAttempts) >= 0
      ? { deliveryAttempts: Number(message.deliveryAttempts) }
      : {}),
    ...(Number.isInteger(Number(message.maxDeliveryAttempts)) && Number(message.maxDeliveryAttempts) > 0
      ? { maxDeliveryAttempts: Number(message.maxDeliveryAttempts) }
      : {}),
    ...(normalizeText(message.lastDeliveryError) ? { lastDeliveryError: normalizeText(message.lastDeliveryError).slice(0, 500) } : {}),
    ...(normalizeText(message.alertKind) ? { alertKind: normalizeText(message.alertKind) } : {}),
    ...(normalizeText(message.alertKey) ? { alertKey: normalizeText(message.alertKey) } : {}),
    ...(normalizeText(message.fingerprint) ? { fingerprint: normalizeText(message.fingerprint) } : {}),
    ...(message.desireState && typeof message.desireState === "object" ? { desireState: message.desireState } : {}),
  };
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function compareSystemMessages(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageQueueStore };
