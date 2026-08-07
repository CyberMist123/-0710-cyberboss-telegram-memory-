const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ConversationRecorder } = require("../src/services/conversation-recorder");
const { CyberbossApp, buildSubjectSourceRef } = require("../src/core/app");
const { createTelegramChannelAdapter } = require("../src/adapters/channel/telegram");
const { buildInboundDraft } = require("../src/core/inbound-turn");
const { locateSourceRef } = require("../src/continuity/continuity-pipeline");
const { SubjectSigningBroker } = require("../src/continuity/subject-signing-ipc");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { registeredProjectTools } = require("../src/tools/tool-host");

const THREAD_ID = "thread-provenance";
const TURN_ID = "turn-provenance";
const ROUTE_TOKEN = "route-provenance";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function recordInbound(dirPath, text = "今天下午在江边走了很久") {
  const recorder = new ConversationRecorder({ dirPath });
  return recorder.record({
    type: "user",
    text,
    threadId: THREAD_ID,
    turnId: TURN_ID,
  });
}

test("the recorder reports the file it wrote and a digest over the exact bytes", () => {
  const dirPath = tempDir("cyberboss-recorder-evidence-");
  const recorded = recordInbound(dirPath);

  assert.ok(recorded.sourceFile, "recorder must report which day file it appended to");
  assert.equal(path.dirname(recorded.sourceFile), path.resolve(dirPath));
  assert.match(recorded.sourceLineSha256, /^[0-9a-f]{64}$/u);

  // Review recomputes the digest from the raw file line, so the recorder's
  // digest has to be over that same line, not over a re-serialization.
  const line = fs.readFileSync(recorded.sourceFile, "utf8").split(/\r?\n/u)[0];
  const crypto = require("crypto");
  assert.equal(
    recorded.sourceLineSha256,
    crypto.createHash("sha256").update(line, "utf8").digest("hex"),
  );

  // Evidence must not leak into the recorded row itself.
  assert.equal(Object.keys(recorded).includes("sourceFile"), false);
  assert.equal(JSON.parse(line).sourceLineSha256, undefined);

  fs.rmSync(dirPath, { recursive: true, force: true });
});

test("a live subject source_ref built from recorder evidence is locatable by Review", () => {
  const dirPath = tempDir("cyberboss-provenance-locate-");
  const recorded = recordInbound(dirPath);

  const sourceRef = buildSubjectSourceRef({
    sourceEntryId: recorded.id,
    evidence: { file: recorded.sourceFile, sha256: recorded.sourceLineSha256 },
  });

  assert.deepEqual(sourceRef.source_entry_ids, [recorded.id]);
  assert.deepEqual(sourceRef.source_entry_hashes, [
    { entry_id: recorded.id, sha256: recorded.sourceLineSha256 },
  ]);
  assert.equal(sourceRef.content_sha256, recorded.sourceLineSha256);

  // The bug this replaces: without server-side source_entry_hashes the tool
  // schema could not carry them, so every live candidate failed this gate and
  // Review deferred it with source_ref_missing, forever.
  assert.equal(locateSourceRef(sourceRef), true);

  fs.rmSync(dirPath, { recursive: true, force: true });
});

test("source_ref construction fails closed when the recorder gave no evidence", () => {
  assert.equal(buildSubjectSourceRef({ sourceEntryId: "entry-1", evidence: null }), null);
  assert.equal(buildSubjectSourceRef({ sourceEntryId: "", evidence: { file: "f", sha256: "a".repeat(64) } }), null);
  assert.equal(
    buildSubjectSourceRef({ sourceEntryId: "entry-1", evidence: { file: "f", sha256: "not-a-digest" } }),
    null,
  );
});

const COORDINATES = Object.freeze({
  runtimeId: "claudecode",
  // Opaque identity string, only ever compared for equality -- never resolved.
  workspaceRoot: "workspace/fable",
  routeToken: ROUTE_TOKEN,
  laneKey: "lane:-100:7",
  threadId: THREAD_ID,
  bindingKey: "binding-fable",
  turnId: TURN_ID,
  accountId: "telegram",
  senderId: "42",
  provider: "telegram",
});

function subjectRouteFor(sourceEntryId) {
  return createSubjectRoute({
    provider: "telegram",
    continuity_binding: {
      workspace_id: "workspace-fable",
      account_id: COORDINATES.accountId,
      sender_id: COORDINATES.senderId,
      binding_key: COORDINATES.bindingKey,
    },
    route_lane: { lane_key: COORDINATES.laneKey, chat_id: "-100", message_thread_id: "7" },
    session: {
      runtime_id: COORDINATES.runtimeId,
      session_slot_key: ROUTE_TOKEN,
      runtime_thread_id: THREAD_ID,
      profile_id: "fable-chat",
      profile_fingerprint: "fable-profile-fingerprint",
      window_id: THREAD_ID,
    },
    author_turn_id: TURN_ID,
    source_entry_ids: [sourceEntryId],
  });
}

test("the broker discards a caller-supplied source_ref and uses the turn's own", () => {
  const dirPath = tempDir("cyberboss-provenance-broker-");
  const recorded = recordInbound(dirPath);
  const authoritative = buildSubjectSourceRef({
    sourceEntryId: recorded.id,
    evidence: { file: recorded.sourceFile, sha256: recorded.sourceLineSha256 },
  });

  const seen = [];
  const broker = new SubjectSigningBroker({
    enabled: true,
    subjectCandidateService: {
      createSubjectCandidate(input) {
        seen.push(input);
        return { status: "created", candidate: { candidate_id: "cand-1" } };
      },
    },
    subjectCapabilityByRunKey: new Map([[`${THREAD_ID}:${TURN_ID}`, {
      capability: { capability_id: "cap-1", subject_turn_id: TURN_ID },
      subject_route: subjectRouteFor(recorded.id),
      source_ref: authoritative,
    }]]),
    runtimeContextStore: {
      resolveActiveContext: () => ({ turnActive: true, ...COORDINATES }),
    },
  });

  const forged = {
    file: path.join(dirPath, "attacker.jsonl"),
    source_entry_ids: ["entry-forged"],
    source_entry_hashes: [{ entry_id: "entry-forged", sha256: "b".repeat(64) }],
    content_sha256: "c".repeat(64),
  };

  broker.submit({
    requestId: "req-1",
    args: { type: "episode", body: "身体记得那段路。", origin: "live_subject", source_ref: forged },
    coordinates: { ...COORDINATES },
  });

  assert.equal(seen.length, 1, "the submit must actually reach the candidate service");
  assert.equal(seen[0].source_ref.file, authoritative.file);
  assert.equal(seen[0].source_ref.content_sha256, recorded.sourceLineSha256);
  assert.deepEqual(seen[0].source_ref.source_entry_ids, [recorded.id]);
  assert.notEqual(seen[0].source_ref.content_sha256, forged.content_sha256);
  assert.equal(
    JSON.stringify(seen[0].source_ref).includes("entry-forged"),
    false,
    "nothing the caller supplied may survive into the candidate",
  );

  fs.rmSync(dirPath, { recursive: true, force: true });
});

test("the broker fails closed when the turn carries no provenance", () => {
  const broker = new SubjectSigningBroker({
    enabled: true,
    subjectCandidateService: {
      createSubjectCandidate() {
        throw new Error("must not be reached without provenance");
      },
    },
    subjectCapabilityByRunKey: new Map([[`${THREAD_ID}:${TURN_ID}`, {
      capability: { capability_id: "cap-1", subject_turn_id: TURN_ID },
      subject_route: subjectRouteFor("entry-1"),
      source_ref: null,
    }]]),
    runtimeContextStore: {
      resolveActiveContext: () => ({ turnActive: true, ...COORDINATES }),
    },
  });

  assert.throws(
    () => broker.submit({
      requestId: "req-2",
      args: { type: "episode", body: "无来源。", origin: "live_subject" },
      coordinates: { ...COORDINATES },
    }),
    /subject_signing_source_evidence_missing/u,
  );
});

test("memory_candidate_submit no longer asks the model for provenance", () => {
  const tool = registeredProjectTools({ CYBERBOSS_SUBJECT_SIGNING_ENABLED: "1" })
    .find((item) => item.name === "memory_candidate_submit");
  assert.ok(tool, "memory_candidate_submit should register when signing is enabled");

  assert.deepEqual(tool.inputSchema.required, ["type", "body", "origin"]);
  assert.equal(tool.inputSchema.properties.source_ref, undefined);
  // additionalProperties:false is what turns a stray source_ref into a schema
  // rejection instead of a silently ignored field.
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(JSON.stringify(tool.inputSchema).includes("sha256"), false);
});

// The four previous wiring debts on this chain all shared one shape: the fix
// landed somewhere a hand-built fixture could reach, while the path production
// actually runs went untested. This one was the same -- provenance was taken in
// `handleIncomingMessage` (weixin) and Telegram, the only live channel, entered
// through `handleTelegramMessage` and never touched it. These two tests drive
// the real entry point so that gap cannot reopen silently.
function telegramInboundApp({ dirPath, subjectSigningEnabled }) {
  const adapter = createTelegramChannelAdapter({
    telegramBotToken: "fake",
    telegramStateFile: path.join(dirPath, "telegram-state.json"),
  });
  const normalized = adapter.normalizeIncomingMessage({
    update_id: 1,
    message: {
      message_id: 7,
      date: 1,
      chat: { id: 5, type: "private" },
      from: { id: 5 },
      text: "今天下午在江边走了很久",
    },
  });
  assert.ok(normalized, "the adapter must accept this update");

  const prepared = [];
  const app = {
    config: { channel: "telegram", stateDir: dirPath, subjectSigningEnabled },
    conversationRecorder: new ConversationRecorder({ dirPath }),
    runtimeAdapter: {
      getSessionStore: () => ({
        buildBindingKey: () => "binding-provenance",
        getThreadIdForWorkspace: () => THREAD_ID,
      }),
    },
    resolveWorkspaceRoot: () => dirPath,
    logTelegramDebug() {},
    recordInboundMessage: CyberbossApp.prototype.recordInboundMessage,
    async handlePreparedMessage(message) { prepared.push(message); },
  };
  return { app, normalized, prepared };
}

test("the Telegram entry point takes provenance for the turn it just recorded", async () => {
  const dirPath = tempDir("cyberboss-provenance-telegram-");
  const { app, normalized, prepared } = telegramInboundApp({
    dirPath,
    subjectSigningEnabled: true,
  });

  await CyberbossApp.prototype.handleTelegramMessage.call(app, normalized);

  // Without this the capability is never issued and every subject turn dies at
  // `subject_source_entry_id_missing` -- which is exactly what production was
  // logging on every message.
  assert.match(normalized.subjectSourceEntryId, /\S/u, "Telegram inbound must carry a source entry id");
  assert.ok(normalized.subjectSourceEvidence, "Telegram inbound must carry recorder evidence");

  // The evidence has to be good enough for Review to locate the row, not just present.
  const sourceRef = buildSubjectSourceRef({
    sourceEntryId: normalized.subjectSourceEntryId,
    evidence: normalized.subjectSourceEvidence,
  });
  assert.ok(sourceRef, "recorder evidence must build a source_ref");
  assert.equal(locateSourceRef(sourceRef), true);

  // Non-enumerable, and it must survive the rebuild `handlePreparedMessage` does.
  assert.equal(Object.keys(normalized).includes("subjectSourceEntryId"), false);
  assert.equal(JSON.parse(JSON.stringify(normalized)).subjectSourceEntryId, undefined);
  assert.equal(prepared.length, 1);
  assert.equal(
    buildInboundDraft(prepared[0]).subjectSourceEntryId,
    normalized.subjectSourceEntryId,
  );

  fs.rmSync(dirPath, { recursive: true, force: true });
});

test("the Telegram entry point takes no provenance while signing is disabled", async () => {
  const dirPath = tempDir("cyberboss-provenance-telegram-off-");
  const { app, normalized } = telegramInboundApp({
    dirPath,
    subjectSigningEnabled: false,
  });

  await CyberbossApp.prototype.handleTelegramMessage.call(app, normalized);

  assert.equal(normalized.subjectSourceEntryId, undefined);
  assert.equal(normalized.subjectSourceEvidence, undefined);
  // Recording itself is not gated by the signing switch -- only the evidence is.
  assert.equal(fs.readdirSync(dirPath).some((name) => name.endsWith(".jsonl")), true);

  fs.rmSync(dirPath, { recursive: true, force: true });
});
