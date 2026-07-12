const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Exact-match pattern for a canary id emitted by createCanaryState.
// The runner mints `canary-${crypto.randomUUID()}`, so the full string is a
// hex UUID prefixed with `canary-`. The regex is anchored so partial hits,
// truncated ids, or ids embedded in other text are rejected.
const CANARY_ID_PATTERN = /^canary-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RECEIPT_FILE_NAME = "canary-receipts.jsonl";

function resolveReceiptFile(stateDir) {
  const normalized = typeof stateDir === "string" ? stateDir.trim() : "";
  if (!normalized) {
    return null;
  }
  return path.join(normalized, RECEIPT_FILE_NAME);
}

function hashThreadKey(threadKey) {
  const value = typeof threadKey === "string" ? threadKey : String(threadKey || "");
  if (!value) {
    return "";
  }
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function looksLikeExactCanaryId(text) {
  if (typeof text !== "string") {
    return false;
  }
  return CANARY_ID_PATTERN.test(text);
}

// Append a single JSONL receipt when, and only when, the inbound text is an
// exact match for the canary id pattern. Never records the message body,
// token, or raw chat id; the canary id itself is a disposable test marker
// per the spec and is stored verbatim.
function recordCanaryReceipt({ stateDir, text, updateId, messageId, threadKey } = {}) {
  if (!looksLikeExactCanaryId(text)) {
    return { recorded: false, reason: "not_canary" };
  }
  const receiptFile = resolveReceiptFile(stateDir);
  if (!receiptFile) {
    return { recorded: false, reason: "no_state_dir" };
  }
  const entry = {
    ts: new Date().toISOString(),
    canary_id: text,
    update_id: updateId === undefined || updateId === null ? null : Number(updateId) || String(updateId),
    message_id: messageId === undefined || messageId === null ? null : String(messageId),
    thread_hash: hashThreadKey(threadKey),
    poller_pid: process.pid,
  };
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
  fs.appendFileSync(receiptFile, `${JSON.stringify(entry)}\n`, "utf8");
  return { recorded: true, receiptFile, canary_id: entry.canary_id };
}

// The canonical local canary source list. Extended here so any caller that
// asks the runner for the official list gets canary-receipts.jsonl included
// without spawning a second poller or issuing any outbound HTTP request.
function defaultLocalCanarySources({ stateDir } = {}) {
  const receiptFile = resolveReceiptFile(stateDir);
  return receiptFile ? [receiptFile] : [];
}

module.exports = {
  CANARY_ID_PATTERN,
  RECEIPT_FILE_NAME,
  recordCanaryReceipt,
  defaultLocalCanarySources,
  looksLikeExactCanaryId,
};
