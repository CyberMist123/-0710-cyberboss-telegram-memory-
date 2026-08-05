const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
} = require("../src/core/inbound-turn");

const ENTRY_ID = "entry-subject-1";
const EVIDENCE = Object.freeze({ file: "C-conversations-2026-08-06.jsonl", sha256: "a".repeat(64) });

// The app attaches provenance exactly this way -- non-enumerable, so it never
// shows up in the message's own serialization.
function inboundWithProvenance(overrides = {}) {
  const normalized = {
    provider: "telegram",
    workspaceId: "workspace-fable",
    accountId: "telegram",
    senderId: "42",
    chatId: "-100",
    messageThreadId: "7",
    messageId: "m-1",
    contextToken: "telegram:42",
    text: "今晚的江水很吵",
    receivedAt: "2026-08-06T01:00:00.000Z",
    ...overrides,
  };
  Object.defineProperty(normalized, "subjectSourceEntryId", { value: ENTRY_ID, enumerable: false });
  Object.defineProperty(normalized, "subjectSourceEvidence", { value: EVIDENCE, enumerable: false });
  return normalized;
}

function assertProvenanceCarried(rebuilt, label) {
  assert.equal(rebuilt.subjectSourceEntryId, ENTRY_ID, `${label} must carry the source entry id`);
  assert.deepEqual(rebuilt.subjectSourceEvidence, EVIDENCE, `${label} must carry the recorder evidence`);
  // Still invisible to serialization -- carrying it must not turn it into a
  // field of the message.
  assert.equal(Object.keys(rebuilt).includes("subjectSourceEntryId"), false, `${label} must keep it non-enumerable`);
  assert.equal(JSON.parse(JSON.stringify(rebuilt)).subjectSourceEntryId, undefined, `${label} must not serialize it`);
}

test("buildInboundDraft carries subject provenance across the spread", () => {
  // The defect: `{...normalized}` copies own *enumerable* properties only, so
  // the provenance vanished here. No source entry id means no capability is
  // ever issued for the turn, and the child's submit dies far away at
  // `subject_signing_turn_unknown`.
  assertProvenanceCarried(buildInboundDraft(inboundWithProvenance()), "buildInboundDraft");
});

test("buildInboundDraft carries provenance when attachments are attached too", () => {
  const rebuilt = buildInboundDraft(inboundWithProvenance(), {
    attachments: [{ kind: "image", path: "a.png" }],
    attachmentFailures: [],
  });
  assert.equal(rebuilt.attachments.length, 1);
  assertProvenanceCarried(rebuilt, "buildInboundDraft with attachments");
});

test("clonePreparedInboundMessage carries subject provenance", () => {
  const prepared = buildInboundDraft(inboundWithProvenance());
  assertProvenanceCarried(clonePreparedInboundMessage(prepared), "clonePreparedInboundMessage");
});

test("a merged image batch carries the newest message's provenance", () => {
  const older = buildInboundDraft(inboundWithProvenance({ messageId: "m-0", text: "第一条" }));
  const latest = buildInboundDraft(inboundWithProvenance({ messageId: "m-1", text: "第二条" }));
  const merged = buildMergedInboundPrepared({
    bindingKey: "binding-fable",
    workspaceRoot: "workspace/fable",
    messages: [older],
    trailingPrepared: latest,
  });
  assertProvenanceCarried(merged, "buildMergedInboundPrepared");
});

test("rebuilds without provenance stay clean rather than inventing keys", () => {
  const plain = { provider: "telegram", text: "无取证的消息" };
  const rebuilt = buildInboundDraft(plain);
  assert.equal(rebuilt.subjectSourceEntryId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(rebuilt, "subjectSourceEntryId"), false);
});
