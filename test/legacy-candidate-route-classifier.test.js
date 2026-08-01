"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const { sha256 } = require("../src/continuity/continuity-store");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const {
  EXACTLY_RECOVERABLE,
  LEGACY_DEFERRED,
  REASON,
  classifyLegacyCandidates,
} = require("../src/continuity/legacy-candidate-classifier");

const CANARY = "planted-nondisclosure-canary-0000";

test("EXACTLY_RECOVERABLE is a four-part conjunction with stable negative reasons", () => {
  const fixture = classifierFixture();
  assert.equal(classify(fixture).classification, EXACTLY_RECOVERABLE);

  const outside = clone(fixture);
  outside.candidates[0].source_ref.file = path.join(os.tmpdir(), "outside.jsonl");
  assertDeferred(classify(outside), REASON.SOURCE_NOT_ALLOWED);

  const unlocatable = clone(fixture);
  unlocatable.candidates[0].source_ref.source_entry_ids = ["missing-entry"];
  unlocatable.candidates[0].source_ref.source_entry_hashes = [{
    entry_id: "missing-entry",
    sha256: unlocatable.candidates[0].source_ref.source_entry_hashes[0].sha256,
  }];
  assertDeferred(classify(unlocatable), REASON.SOURCE_NOT_LOCATABLE);

  const differentBinding = clone(fixture);
  differentBinding.conversationEntries[1] = replaceRoute(differentBinding.conversationEntries[1], {
    continuity_binding: { ...routeInput().continuity_binding, binding_key: "binding-other" },
  });
  refreshEvidence(differentBinding);
  assertDeferred(classify(differentBinding), REASON.ROUTE_AMBIGUOUS);

  const crossProfile = clone(fixture);
  crossProfile.conversationEntries[1] = replaceRoute(crossProfile.conversationEntries[1], {
    session: { ...routeInput().session, profile_id: "profile-other" },
  });
  refreshEvidence(crossProfile);
  assertDeferred(classify(crossProfile), REASON.MIXED_TOPIC_OR_PROFILE);
});

test("multi-route, multi-session, missing window, and source hash mismatch never infer a route", () => {
  const cases = [];

  const multiRoute = classifierFixture();
  multiRoute.conversationEntries[1] = replaceRoute(multiRoute.conversationEntries[1], {
    route_lane: { ...routeInput().route_lane, lane_key: "lane-other", chat_id: "chat-other" },
  });
  refreshEvidence(multiRoute);
  cases.push(multiRoute);

  const multiSession = classifierFixture();
  multiSession.conversationEntries[1] = replaceRoute(multiSession.conversationEntries[1], {
    session: { ...routeInput().session, session_slot_key: "slot-other", runtime_thread_id: "thread-other" },
  });
  refreshEvidence(multiSession);
  cases.push(multiSession);

  const missingWindow = classifierFixture();
  const partial = clone(routeInput());
  delete partial.session.window_id;
  missingWindow.conversationEntries[1] = replaceRoute(missingWindow.conversationEntries[1], partial, { partial: true });
  refreshEvidence(missingWindow);
  cases.push(missingWindow);

  const hashMismatch = classifierFixture();
  hashMismatch.candidates[0].source_ref.content_sha256 = "0".repeat(64);
  cases.push(hashMismatch);

  for (const fixture of cases) {
    const result = classify(fixture);
    assertDeferred(result, REASON.ROUTE_AMBIGUOUS);
    assert.equal(Object.hasOwn(result, "subject_route"), false);
  }
});

test("classification output uses opaque route values and never leaks paths, raw profiles, or canaries", () => {
  const fixture = classifierFixture();
  const output = JSON.stringify(classify(fixture));
  assert.doesNotMatch(output, new RegExp(escapeRegex(fixture.allowedConversationDirs[0]), "iu"));
  assert.doesNotMatch(output, /raw-profile-id/iu);
  assert.doesNotMatch(output, new RegExp(CANARY, "u"));
  assert.match(output, /profile-[0-9a-f]{64}/u);
});

function classifierFixture() {
  const conversationDir = path.join(os.tmpdir(), "g2-7-fixture-conversations");
  const file = path.join(conversationDir, "fixture.jsonl");
  const entries = [conversationRow(file, 1, "entry-1"), conversationRow(file, 2, "entry-2")];
  const sourceEntryHashes = entries.map((row) => ({ entry_id: row.entry.id, sha256: sha256(row.rawLine) }));
  return {
    candidates: [{
      candidate_id: "cand-legacy-exact",
      type: "episode",
      author: "closeout",
      body: CANARY,
      source_ref: {
        file,
        window: "1-2",
        source_entry_ids: entries.map((row) => row.entry.id),
        source_entry_hashes: sourceEntryHashes,
        content_sha256: sha256(entries.map((row) => row.rawLine).join("\n")),
      },
    }],
    conversationEntries: entries,
    allowedConversationDirs: [conversationDir],
  };
}

function conversationRow(file, line, id) {
  const entry = { id, type: "user", text: `fixture-${line}`, meta: { subject_route: createSubjectRoute(routeInput()) } };
  return { file, line, entry, rawLine: JSON.stringify(entry) };
}

function routeInput() {
  return {
    version: 1,
    provider: "telegram",
    continuity_binding: { workspace_id: "workspace-raw", account_id: "account-raw", sender_id: "sender-raw", binding_key: "binding-opaque" },
    route_lane: { lane_key: "lane-opaque", chat_id: "chat-raw", message_thread_id: "topic-raw" },
    session: {
      runtime_id: "claudecode",
      session_slot_key: "slot-opaque",
      runtime_thread_id: "thread-raw",
      profile_id: `raw-profile-id-${CANARY}`,
      profile_fingerprint: "profile-fingerprint-opaque",
      window_id: "window-raw",
    },
    author_turn_id: "turn-raw",
    source_entry_ids: ["evidence-placeholder"],
  };
}

function replaceRoute(row, overrides, { partial = false } = {}) {
  const base = routeInput();
  const input = {
    ...base,
    ...overrides,
    continuity_binding: overrides.continuity_binding || base.continuity_binding,
    route_lane: overrides.route_lane || base.route_lane,
    session: overrides.session || base.session,
  };
  const subjectRoute = partial ? { ...input, route_fingerprint: "0".repeat(64) } : createSubjectRoute(input);
  const entry = { ...row.entry, meta: { ...row.entry.meta, subject_route: subjectRoute } };
  return { ...row, entry, rawLine: JSON.stringify(entry) };
}

function refreshEvidence(fixture) {
  fixture.candidates[0].source_ref.source_entry_hashes = fixture.conversationEntries.map((row) => ({
    entry_id: row.entry.id,
    sha256: sha256(row.rawLine),
  }));
  fixture.candidates[0].source_ref.content_sha256 = sha256(fixture.conversationEntries.map((row) => row.rawLine).join("\n"));
}

function classify(fixture) {
  return classifyLegacyCandidates(fixture)[0];
}

function assertDeferred(result, reason) {
  assert.equal(result.classification, LEGACY_DEFERRED);
  assert.equal(result.reason_code, reason);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
