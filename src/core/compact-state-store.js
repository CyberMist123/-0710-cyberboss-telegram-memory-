const fs = require("fs");
const path = require("path");

class CompactStateStore {
  constructor({ stateFile = "", historyDir = "", pendingDir = "", transcriptRoot = "" } = {}) {
    this.stateFile = stateFile;
    this.historyDir = historyDir;
    this.pendingDir = pendingDir;
    this.transcriptRoot = transcriptRoot;
  }

  ensureDirectories() {
    ensureParent(this.stateFile);
    ensureDir(this.historyDir);
    ensureDir(this.pendingDir);
  }

  getThreadState(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    const state = this.readState();
    const entry = normalizedThreadId && state.threads[normalizedThreadId]
      ? state.threads[normalizedThreadId]
      : null;
    return normalizeThreadState(normalizedThreadId, entry);
  }

  saveThreadState(threadId = "", patch = {}) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return normalizeThreadState("", null);
    }
    const state = this.readState();
    const current = normalizeThreadState(normalizedThreadId, state.threads[normalizedThreadId]);
    const next = normalizeThreadState(normalizedThreadId, {
      ...current,
      ...(patch && typeof patch === "object" ? patch : {}),
    });
    state.threads[normalizedThreadId] = next;
    state.threadId = next.threadId;
    state.compactCount = next.compactCount;
    state.lastCompactAt = next.lastCompactAt;
    state.lastCompactTokens = next.lastCompactTokens;
    state.lastCompactTurnCount = next.lastCompactTurnCount;
    state.rolloverRecommended = next.rolloverRecommended;
    state.lastError = next.lastError;
    atomicWriteJson(this.stateFile, state);
    return next;
  }

  readPendingCompact(threadId = "") {
    const filePath = this.getPendingPath(threadId);
    return readJsonObject(filePath);
  }

  writePendingCompact(threadId = "", payload = {}) {
    const filePath = this.getPendingPath(threadId);
    if (!filePath) {
      return "";
    }
    atomicWriteJson(filePath, payload && typeof payload === "object" ? payload : {});
    return filePath;
  }

  clearPendingCompact(threadId = "") {
    const filePath = this.getPendingPath(threadId);
    if (!filePath) {
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  getPendingPath(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !this.pendingDir) {
      return "";
    }
    return path.join(this.pendingDir, `${normalizedThreadId}.json`);
  }

  countEffectiveTurns({ threadId = "" } = {}) {
    const transcriptPath = this.findTranscriptPath(threadId);
    if (!transcriptPath) {
      return 0;
    }
    let count = 0;
    try {
      const raw = fs.readFileSync(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = JSON.parse(trimmed);
        if (isEffectiveTelegramTurnEntry(entry, threadId)) {
          count += 1;
        }
      }
    } catch {
      return 0;
    }
    return count;
  }

  findTranscriptPath(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId || !this.transcriptRoot || !fs.existsSync(this.transcriptRoot)) {
      return "";
    }
    const queue = [this.transcriptRoot];
    while (queue.length) {
      const current = queue.shift();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name === `${normalizedThreadId}.jsonl`) {
          return fullPath;
        }
      }
    }
    return "";
  }

  readState() {
    const raw = readJsonObject(this.stateFile);
    return {
      threadId: normalizeText(raw.threadId),
      compactCount: normalizeNonNegativeInt(raw.compactCount),
      lastCompactAt: normalizeText(raw.lastCompactAt),
      lastCompactTokens: normalizeNullableNumber(raw.lastCompactTokens),
      lastCompactTurnCount: normalizeNonNegativeInt(raw.lastCompactTurnCount),
      rolloverRecommended: Boolean(raw.rolloverRecommended),
      lastError: normalizeText(raw.lastError),
      threads: normalizeThreadsMap(raw.threads),
    };
  }
}

function isEffectiveTelegramTurnEntry(entry, threadId = "") {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (normalizeText(entry.sessionId || entry.threadId) !== normalizeText(threadId)) {
    return false;
  }
  if (normalizeText(entry.type) !== "user") {
    return false;
  }
  if (normalizeText(entry.userType) && normalizeText(entry.userType) !== "external") {
    return false;
  }
  const content = extractUserContent(entry);
  if (!content || !content.includes("<channel source=\"telegram\"")) {
    return false;
  }
  return true;
}

function extractUserContent(entry = {}) {
  const direct = normalizeText(entry?.message?.content);
  if (direct) {
    return direct;
  }
  return "";
}

function normalizeThreadsMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [threadId, raw] of Object.entries(value)) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) continue;
    out[normalizedThreadId] = normalizeThreadState(normalizedThreadId, raw);
  }
  return out;
}

function normalizeThreadState(threadId = "", value = null) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    threadId: normalizeText(threadId) || normalizeText(raw.threadId),
    compactCount: normalizeNonNegativeInt(raw.compactCount),
    lastCompactAt: normalizeText(raw.lastCompactAt),
    lastCompactTokens: normalizeNullableNumber(raw.lastCompactTokens),
    lastCompactTurnCount: normalizeNonNegativeInt(raw.lastCompactTurnCount),
    rolloverRecommended: Boolean(raw.rolloverRecommended),
    lastError: normalizeText(raw.lastError),
  };
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function normalizeNullableNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureDir(dirPath = "") {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureParent(filePath = "") {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonObject(filePath = "") {
  if (!filePath) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function atomicWriteJson(filePath, value) {
  ensureParent(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  CompactStateStore,
  atomicWriteJson,
};
