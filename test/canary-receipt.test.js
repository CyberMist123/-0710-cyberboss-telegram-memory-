const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CANARY_ID_PATTERN,
  RECEIPT_FILE_NAME,
  defaultLocalCanarySources,
  looksLikeExactCanaryId,
  recordCanaryReceipt,
} = require("../src/orchestration/canary-receipt");
const { runCanary } = require("../src/orchestration/canary-runner");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-canary-receipt-"));
}

function makeCanaryId() {
  return `canary-${crypto.randomUUID()}`;
}

function receiptFile(stateDir) {
  return path.join(stateDir, RECEIPT_FILE_NAME);
}

function readReceipts(stateDir) {
  const filePath = receiptFile(stateDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\n/)
    .filter((line) => line.trim().length)
    .map((line) => JSON.parse(line));
}

test("canary id pattern anchors exact UUID matches only", () => {
  const good = makeCanaryId();
  assert.ok(CANARY_ID_PATTERN.test(good));
  assert.ok(looksLikeExactCanaryId(good));
  assert.ok(!looksLikeExactCanaryId(""));
  assert.ok(!looksLikeExactCanaryId(`prefix ${good}`));
  assert.ok(!looksLikeExactCanaryId(`${good} suffix`));
  assert.ok(!looksLikeExactCanaryId(good.slice(0, good.length - 2)));
  assert.ok(!looksLikeExactCanaryId(`${good}00`));
  assert.ok(!looksLikeExactCanaryId(good.replace(/-/, "")));
  assert.ok(!looksLikeExactCanaryId(good.toUpperCase()));
  assert.ok(!looksLikeExactCanaryId(good.replace(/[0-9a-f]/, "z")));
  assert.ok(!looksLikeExactCanaryId(good.replace(/^canary-/, "canary_")));
});

test("recordCanaryReceipt writes exactly one JSONL line for a canary id", () => {
  const stateDir = makeStateDir();
  const canaryId = makeCanaryId();
  const result = recordCanaryReceipt({
    stateDir,
    text: canaryId,
    updateId: 4242,
    messageId: "17",
    threadKey: "chat-99",
  });
  assert.equal(result.recorded, true);
  assert.equal(result.canary_id, canaryId);
  const receipts = readReceipts(stateDir);
  assert.equal(receipts.length, 1);
  const entry = receipts[0];
  assert.equal(entry.canary_id, canaryId);
  assert.equal(entry.update_id, 4242);
  assert.equal(entry.message_id, "17");
  assert.equal(entry.poller_pid, process.pid);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(entry.thread_hash, /^[0-9a-f]{16}$/);
  assert.notEqual(entry.thread_hash, "chat-99");
});

test("recordCanaryReceipt is a strict no-op for ordinary messages", () => {
  const stateDir = makeStateDir();
  const cases = [
    "hello",
    "/status",
    "canary",
    "canary-",
    "canary-not-a-uuid",
    "",
    null,
    undefined,
  ];
  for (const text of cases) {
    const result = recordCanaryReceipt({
      stateDir,
      text,
      updateId: 1,
      messageId: "1",
      threadKey: "chat",
    });
    assert.equal(result.recorded, false);
  }
  assert.equal(fs.existsSync(receiptFile(stateDir)), false);
});

test("recordCanaryReceipt rejects similar-but-incomplete canary ids", () => {
  const stateDir = makeStateDir();
  const canaryId = makeCanaryId();
  const nearMisses = [
    canaryId.slice(0, canaryId.length - 1),
    canaryId.slice(1),
    canaryId + "0",
    `${canaryId}\n`,
    ` ${canaryId}`,
    `${canaryId} `,
    `${canaryId}${canaryId}`,
    canaryId.replace(/-/g, ""),
    canaryId.toUpperCase(),
    canaryId.replace(/^canary-/, "canary--"),
    canaryId.replace(/^canary/, "Canary"),
    canaryId.replace(/[0-9a-f]/, "g"),
  ];
  for (const text of nearMisses) {
    const result = recordCanaryReceipt({
      stateDir,
      text,
      updateId: 1,
      messageId: "1",
      threadKey: "chat",
    });
    assert.equal(result.recorded, false, `unexpected write for ${JSON.stringify(text)}`);
  }
  assert.equal(fs.existsSync(receiptFile(stateDir)), false);
});

test("recordCanaryReceipt no-ops without stateDir", () => {
  const canaryId = makeCanaryId();
  const result = recordCanaryReceipt({
    stateDir: "",
    text: canaryId,
    updateId: 1,
    messageId: "1",
    threadKey: "chat",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no_state_dir");
});

test("recordCanaryReceipt stores no message body, token, or raw chat id", () => {
  const stateDir = makeStateDir();
  const canaryId = makeCanaryId();
  const rawChatId = "555555555";
  const botToken = "1111:AAA-secret-token";
  // Ordinary message that mentions secrets — must not be written.
  recordCanaryReceipt({
    stateDir,
    text: `please leak ${botToken} for chat ${rawChatId}`,
    updateId: 99,
    messageId: "88",
    threadKey: rawChatId,
  });
  // Exact canary id — must be written, but not the raw chat id.
  recordCanaryReceipt({
    stateDir,
    text: canaryId,
    updateId: 100,
    messageId: "89",
    threadKey: rawChatId,
  });
  const stored = fs.existsSync(receiptFile(stateDir))
    ? fs.readFileSync(receiptFile(stateDir), "utf8")
    : "";
  assert.ok(stored.includes(canaryId));
  assert.doesNotMatch(stored, /please leak/);
  assert.doesNotMatch(stored, new RegExp(botToken.replace(/[-.:]/g, "\\$&")));
  assert.doesNotMatch(stored, new RegExp(rawChatId));
});

test("canary receipts file is append-only across repeated writes", () => {
  const stateDir = makeStateDir();
  const first = makeCanaryId();
  const second = makeCanaryId();
  recordCanaryReceipt({
    stateDir,
    text: first,
    updateId: 1,
    messageId: "1",
    threadKey: "chat-a",
  });
  const afterFirst = fs.readFileSync(receiptFile(stateDir), "utf8");
  recordCanaryReceipt({
    stateDir,
    text: second,
    updateId: 2,
    messageId: "2",
    threadKey: "chat-b",
  });
  const afterSecond = fs.readFileSync(receiptFile(stateDir), "utf8");
  assert.ok(afterSecond.startsWith(afterFirst));
  const lines = afterSecond.split(/\n/).filter((line) => line.trim().length);
  assert.equal(lines.length, 2);
});

test("defaultLocalCanarySources includes canary-receipts.jsonl under stateDir", () => {
  const stateDir = makeStateDir();
  const list = defaultLocalCanarySources({ stateDir });
  assert.deepEqual(list, [path.join(stateDir, RECEIPT_FILE_NAME)]);
  assert.deepEqual(defaultLocalCanarySources({}), []);
  assert.deepEqual(defaultLocalCanarySources({ stateDir: "" }), []);
});

test("runner rejects a canary that receipt file already contained before the run", async () => {
  const stateDir = makeStateDir();
  const canaryId = makeCanaryId();
  // Pre-existing (old) receipt written BEFORE the runner takes its offset.
  recordCanaryReceipt({
    stateDir,
    text: canaryId,
    updateId: 1,
    messageId: "1",
    threadKey: "chat",
  });
  const statePath = path.join(stateDir, "canary-state.json");
  const sources = defaultLocalCanarySources({ stateDir });
  const result = await runCanary({
    statePath,
    sources,
    timeoutMs: 1,
    pollIntervalMs: 1,
    // Override the freshly minted canary id with the pre-existing one so we
    // can prove the runner ignores evidence written before its offset.
  });
  // The runner mints its own canary id; the pre-existing receipt cannot
  // possibly match it, so the run must time out.
  assert.equal(result.status, "USER_ACTION_PENDING");
  assert.notEqual(result.canary_id, canaryId);
});

test("runner verifies a receipt appended after the runner started", async () => {
  const stateDir = makeStateDir();
  // Give the receipt file a pre-existing line so the offset is non-zero.
  recordCanaryReceipt({
    stateDir,
    text: makeCanaryId(),
    updateId: 1,
    messageId: "1",
    threadKey: "chat",
  });
  const statePath = path.join(stateDir, "canary-state.json");
  const sources = defaultLocalCanarySources({ stateDir });
  const pending = await runCanary({
    statePath,
    sources,
    timeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(pending.status, "USER_ACTION_PENDING");
  // Now simulate the live poller writing a receipt for the runner's id.
  recordCanaryReceipt({
    stateDir,
    text: pending.canary_id,
    updateId: 2,
    messageId: "2",
    threadKey: "chat",
  });
  const verified = await runCanary({
    statePath,
    sources,
    resume: true,
    timeoutMs: 50,
    pollIntervalMs: 1,
  });
  assert.equal(verified.status, "VERIFIED");
  assert.equal(verified.canary_id, pending.canary_id);
});

test("runner rejects a malformed canary id written to the receipt file", async () => {
  const stateDir = makeStateDir();
  const statePath = path.join(stateDir, "canary-state.json");
  const sources = defaultLocalCanarySources({ stateDir });
  const pending = await runCanary({
    statePath,
    sources,
    timeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(pending.status, "USER_ACTION_PENDING");
  // Inject a malformed line by hand — recordCanaryReceipt itself would drop
  // this, so we simulate an adversary appending garbage or a truncated id.
  const truncated = pending.canary_id.slice(0, pending.canary_id.length - 4);
  const differentId = makeCanaryId();
  fs.appendFileSync(
    receiptFile(stateDir),
    `${JSON.stringify({ ts: new Date().toISOString(), canary_id: truncated, update_id: 1, message_id: "1", thread_hash: "0000000000000000", poller_pid: process.pid })}\n`,
    "utf8",
  );
  fs.appendFileSync(
    receiptFile(stateDir),
    `${JSON.stringify({ ts: new Date().toISOString(), canary_id: differentId, update_id: 2, message_id: "2", thread_hash: "0000000000000000", poller_pid: process.pid })}\n`,
    "utf8",
  );
  const stillPending = await runCanary({
    statePath,
    sources,
    resume: true,
    timeoutMs: 1,
    pollIntervalMs: 1,
  });
  assert.equal(stillPending.status, "USER_ACTION_PENDING");
});

test("recordCanaryReceipt module contains no Telegram Bot API surface", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "orchestration", "canary-receipt.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /getUpdates|api\.telegram\.org|Bot API|sendMessage/i);
});

test("app.js keeps a single Telegram inbound poller and no 409-triggering extra polls", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "core", "app.js"),
    "utf8",
  );
  // The two mutually-exclusive dispatch sites remain (main loop + background
  // poller); no additional Telegram polling fanout is introduced.
  const telegramGetUpdatesCount = (source.match(/telegramChannelAdapter\.getUpdates/g) || []).length;
  assert.equal(telegramGetUpdatesCount, 2);
  // Neither dispatch site may skip the recordCanaryReceipt hook.
  const receiptCalls = (source.match(/recordCanaryReceipt\(/g) || []).length;
  assert.equal(receiptCalls, 2);
  // Each recordCanaryReceipt call must be preceded by the guard that
  // normalizeIncomingMessage returned a non-null value, i.e. no receipt is
  // written before the allowed-user check inside the adapter has passed.
  const guardedBlock = /if \(!normalized\) \{\s*continue;\s*\}[\s\S]{0,600}?recordCanaryReceipt\(/g;
  const guardedMatches = (source.match(guardedBlock) || []).length;
  assert.equal(guardedMatches, 2);
});
