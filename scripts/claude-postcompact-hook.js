const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require("../src/core/compact-state-store");

async function main() {
  const payload = await readStdinJson();
  const stateDir = process.env.CYBERBOSS_STATE_DIR || "";
  if (!stateDir) {
    return;
  }
  const contextDir = path.join(stateDir, "context");
  const pendingDir = path.join(contextDir, "compact-pending");
  const historyDir = path.join(contextDir, "compact-history");
  fs.mkdirSync(historyDir, { recursive: true });

  const threadId = readFirstString(payload, ["session_id", "sessionId", "thread_id", "threadId"]);
  const pending = readJsonObject(threadId ? path.join(pendingDir, `${threadId}.json`) : "");
  const compactSummary = readCompactSummary(payload);
  const timestamp = new Date().toISOString();
  const compactSequence = normalizeNumber(pending.compactSequence) || normalizeNumber(payload.compact_sequence) || 0;
  const output = {
    timestamp,
    threadId: threadId || readFirstString(pending, ["threadId"]),
    trigger: readFirstString(pending, ["trigger"]) || readFirstString(payload, ["trigger", "source"]) || "unknown",
    tokenUsageBeforeCompact: pending.tokenUsageBeforeCompact && typeof pending.tokenUsageBeforeCompact === "object"
      ? pending.tokenUsageBeforeCompact
      : null,
    effectiveTurnCountBeforeCompact: normalizeNumber(pending.effectiveTurnCountBeforeCompact),
    compactSummary,
    compactSequenceNumber: compactSequence,
  };
  const safeThreadId = sanitizeFilePart(output.threadId || "unknown-thread");
  const filePath = path.join(historyDir, `${timestamp.replace(/[:]/g, "-")}-${safeThreadId}.json`);
  atomicWriteJson(filePath, output);
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString("utf8");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function readCompactSummary(payload) {
  const direct = readFirstString(payload, ["compact_summary", "compactSummary", "summary"]);
  if (direct) {
    return direct;
  }
  if (payload && typeof payload.compact_summary === "object") {
    return JSON.stringify(payload.compact_summary);
  }
  if (payload && typeof payload.compactSummary === "object") {
    return JSON.stringify(payload.compactSummary);
  }
  return "";
}

function readFirstString(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readJsonObject(filePath = "") {
  if (!filePath) return {};
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

function sanitizeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

main().catch(() => {
  process.exitCode = 0;
});
