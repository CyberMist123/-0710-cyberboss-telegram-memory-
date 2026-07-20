const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { appendDesireTelemetry, hashEventId } = require("../src/core/desire-telemetry");

test("desire telemetry is independently gated and excludes private payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-desire-telemetry-"));
  const filePath = path.join(root, "usage.jsonl");
  try {
    assert.equal(appendDesireTelemetry({ enabled: false, filePath, eventId: "secret-id" }), false);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(appendDesireTelemetry({ enabled: true, filePath, eventId: "event-1", model: "claude", reusedSession: true, usage: { inputTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, outputTokens: 6 }, durationMs: 7, outcome: "success" }), true);
    const row = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(row.event_id_hash, hashEventId("event-1"));
    assert.equal(JSON.stringify(row).includes("event-1"), false);
    assert.deepEqual(Object.keys(row).sort(), ["cache_creation_tokens", "cached_input_tokens", "duration_ms", "event_id_hash", "event_type", "input_tokens", "model", "outcome", "output_tokens", "reasoning_tokens", "reused_session", "timestamp"].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
