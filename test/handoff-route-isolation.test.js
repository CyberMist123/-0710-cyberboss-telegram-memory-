"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HandoffDispatcher } = require("../src/continuity/handoff-dispatcher");
const { createHandoffEnvelope, reviewArtifactPaths } = require("../src/continuity/review-artifacts");
const { createSubjectRoute } = require("../src/continuity/subject-route");

test("same sender in another topic or profile cannot receive the handoff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-handoff-route-"));
  const paths = reviewArtifactPaths(root);
  const target = route();
  const candidate = {
    candidate_id: "cand-route-negative",
    type: "reentry_draft",
    body: "原窗口专属正文",
    source_ref: { entry_ids: ["entry-1"] },
    subject_route: target,
  };
  const envelope = createHandoffEnvelope(candidate, {
    decision_id: "decision-route-negative",
    candidate_id: candidate.candidate_id,
    result: "rejected",
    reason: "imperative_style",
    checks: {},
  }, "2026-07-31T00:00:00.000Z");
  fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
  fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify(envelope)}\n`, "utf8");
  const dispatcher = new HandoffDispatcher({ continuityDir: root, enabled: true });

  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(route({
    laneKey: "tg:telegram:500:topic:10",
    topic: "10",
    slot: "slot-topic-10",
    thread: "native-topic-10",
  })) }).status, "none");
  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: identity(route({
    profile: "other-profile",
    profileFingerprint: "other-profile-fingerprint",
    slot: "slot-other-profile",
    thread: "native-other-profile",
  })) }).status, "none");
  assert.equal(fs.existsSync(paths.handoffDeliveryEvents), false);

  const exact = dispatcher.beginSubjectTurn({ currentRoute: identity(target) });
  assert.equal(exact.status, "ready");
  dispatcher.markDelivered(exact.token);
  assert.equal(JSON.stringify(readJsonl(paths.handoffDeliveryEvents)).includes("topic-10"), false);
  assert.equal(JSON.stringify(readJsonl(paths.handoffDeliveryEvents)).includes("other-profile"), false);
});

test("T06 switched lane delivers only to the origin window and voids a terminated origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-handoff-origin-"));
  const paths = reviewArtifactPaths(root);
  const origin = route({
    profile: "profile-a",
    profileFingerprint: "fingerprint-a",
    slot: "slot-profile-a",
    thread: "native-profile-a",
  });
  const envelope = createHandoffEnvelope({
    candidate_id: "cand-origin-only",
    type: "reentry_draft",
    body: "仅供原窗口处理的测试正文",
    source_ref: { entry_ids: ["entry-1"] },
    subject_route: origin,
  }, {
    decision_id: "decision-origin-only",
    candidate_id: "cand-origin-only",
    result: "rejected",
    reason: "imperative_style",
    checks: {},
  }, "2026-08-02T00:00:00.000Z");
  fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
  fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify(envelope)}\n`, "utf8");
  const dispatcher = new HandoffDispatcher({ continuityDir: root, enabled: true });

  const newestWindow = identity(route({
    profile: "profile-b",
    profileFingerprint: "fingerprint-b",
    slot: "slot-profile-b",
    thread: "native-profile-b",
  }));
  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: newestWindow }).status, "none");
  assert.equal(fs.existsSync(paths.handoffDeliveryEvents), false);

  const exactOrigin = dispatcher.beginSubjectTurn({ currentRoute: identity(origin) });
  assert.equal(exactOrigin.status, "ready");
  assert.equal(exactOrigin.token.route_match, "EXACT");
  dispatcher.markFailed(exactOrigin.token, { reason: "fixture_retry", retryable: true });

  const terminatedOrigin = identity(route({
    profile: "profile-a",
    profileFingerprint: "fingerprint-a",
    slot: "slot-profile-a",
    thread: "native-profile-a-successor",
  }));
  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: terminatedOrigin }).status, "none");
  const events = readJsonl(paths.handoffDeliveryEvents);
  assert.equal(events.at(-1).result, "window_gone");
  assert.equal(events.at(-1).reason, "window_gone");
  assert.equal(JSON.stringify(events).includes("native-profile-b"), false);
});

function route(overrides = {}) {
  const thread = overrides.thread || "native-session-a";
  return createSubjectRoute({
    version: 1,
    provider: "telegram",
    continuity_binding: {
      workspace_id: "default", account_id: "telegram", sender_id: "500",
      binding_key: "default:telegram:500",
    },
    route_lane: {
      lane_key: overrides.laneKey || "tg:telegram:500:topic:9",
      chat_id: "500",
      message_thread_id: overrides.topic || "9",
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: overrides.slot || "slot-topic-9",
      runtime_thread_id: thread,
      profile_id: overrides.profile || "subject-profile",
      profile_fingerprint: overrides.profileFingerprint || "profile-fingerprint-a",
      window_id: thread,
    },
    author_turn_id: "turn-author",
    source_entry_ids: ["entry-1"],
  });
}

function identity(value) {
  return {
    provider: value.provider,
    continuity_binding: value.continuity_binding,
    route_lane: value.route_lane,
    session: value.session,
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}
