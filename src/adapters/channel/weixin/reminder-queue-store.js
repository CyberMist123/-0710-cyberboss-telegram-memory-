const fs = require("fs");
const path = require("path");

class ReminderQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { reminders: [] };
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
      const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
      this.state = {
        reminders: reminders
          .map(normalizeReminder)
          .filter(Boolean)
          .sort((left, right) => left.dueAtMs - right.dueAtMs),
      };
    } catch {
      this.state = { reminders: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(reminder) {
    this.load();
    const normalized = normalizeReminder(reminder);
    if (!normalized) {
      throw new Error("invalid reminder");
    }
    this.state.reminders.push(normalized);
    this.state.reminders.sort((left, right) => left.dueAtMs - right.dueAtMs);
    this.save();
    return normalized;
  }

  updateById(reminderId, patch = {}) {
    this.load();
    const index = this.state.reminders.findIndex((reminder) => reminder.id === reminderId);
    if (index < 0) {
      return null;
    }
    const current = this.state.reminders[index];
    const normalized = normalizeReminder({
      ...current,
      ...patch,
      id: current.id,
      accountId: current.accountId,
      senderId: patch.senderId === undefined ? current.senderId : patch.senderId,
      contextToken: patch.contextToken === undefined ? current.contextToken : patch.contextToken,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    });
    if (!normalized) {
      throw new Error("invalid reminder");
    }
    this.state.reminders[index] = normalized;
    this.state.reminders.sort((left, right) => left.dueAtMs - right.dueAtMs);
    this.save();
    return normalized;
  }

  deleteById(reminderId) {
    this.load();
    const index = this.state.reminders.findIndex((reminder) => reminder.id === reminderId);
    if (index < 0) {
      return null;
    }
    const [removed] = this.state.reminders.splice(index, 1);
    this.save();
    return removed || null;
  }

  listDue(nowMs = Date.now()) {
    this.load();
    const due = [];
    const pending = [];

    for (const reminder of this.state.reminders) {
      if (reminder.dueAtMs <= nowMs) {
        due.push(reminder);
      } else {
        pending.push(reminder);
      }
    }

    if (due.length) {
      this.state.reminders = pending;
      this.save();
    }

    return due;
  }

  peekNextDueAtMs() {
    this.load();
    const first = this.state.reminders[0];
    return Number.isFinite(first?.dueAtMs) ? first.dueAtMs : 0;
  }
}

function normalizeReminder(reminder) {
  if (!reminder || typeof reminder !== "object") {
    return null;
  }
  const id = typeof reminder.id === "string" ? reminder.id.trim() : "";
  const accountId = typeof reminder.accountId === "string" ? reminder.accountId.trim() : "";
  const senderId = typeof reminder.senderId === "string" ? reminder.senderId.trim() : "";
  const contextToken = typeof reminder.contextToken === "string" ? reminder.contextToken.trim() : "";
  const text = typeof reminder.text === "string" ? reminder.text.trim() : "";
  const dueAtMs = Number(reminder.dueAtMs);
  const createdAt = typeof reminder.createdAt === "string" ? reminder.createdAt.trim() : "";
  const updatedAt = typeof reminder.updatedAt === "string" ? reminder.updatedAt.trim() : "";
  if (!id || !accountId || !senderId || !contextToken || !text || !Number.isFinite(dueAtMs) || dueAtMs <= 0) {
    return null;
  }
  return {
    id,
    accountId,
    senderId,
    contextToken,
    text,
    dueAtMs,
    createdAt: createdAt || new Date().toISOString(),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

module.exports = { ReminderQueueStore };
