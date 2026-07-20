const crypto = require("crypto");
const fs = require("fs");

function appendDesireTelemetry({ enabled = false, filePath = "", eventId = "", model = "", reusedSession = false, usage = {}, durationMs = null, outcome = "success" } = {}) {
  if (!enabled || !filePath) return false;
  const row = {
    timestamp: new Date().toISOString(),
    event_type: "desire_checkin",
    event_id_hash: hashEventId(eventId),
    model: textOrNull(model),
    reused_session: Boolean(reusedSession),
    input_tokens: numberOrNull(usage.inputTokens),
    cached_input_tokens: numberOrNull(usage.cacheReadInputTokens),
    cache_creation_tokens: numberOrNull(usage.cacheCreationInputTokens),
    output_tokens: numberOrNull(usage.outputTokens),
    reasoning_tokens: numberOrNull(usage.reasoningTokens),
    duration_ms: numberOrNull(durationMs),
    outcome: normalizeOutcome(outcome),
  };
  try {
    fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function hashEventId(value) {
  const id = String(value || "").trim();
  return id ? crypto.createHash("sha256").update(id, "utf8").digest("hex") : null;
}
function numberOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function textOrNull(value) { const text = String(value || "").trim(); return text || null; }
function normalizeOutcome(value) { return ["success", "timeout", "error"].includes(value) ? value : "error"; }

module.exports = { appendDesireTelemetry, hashEventId };
