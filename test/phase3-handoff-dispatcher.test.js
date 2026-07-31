"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HandoffAckLedger } = require("../src/continuity/handoff-ack");
const { createHandoffAckId } = require("../src/continuity/handoff-context");
const {
  HandoffDispatcher,
  readHandoffDeliverySummary,
  summarizeHandoffDeliveries,
} = require("../src/continuity/handoff-dispatcher");
const {
  resolveHandoffWriterLeaseFile,
} = require("../src/continuity/handoff-writer-lease");
const {
  createHandoffEnvelope,
  reviewArtifactPaths,
} = require("../src/continuity/review-artifacts");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { acquireWriterLease, releaseWriterLease } = require("../src/orchestration/writer-lease");

test("dispatcher delivers once only to the canonical original window", () => {
  const fixture = createFixture("exact-once");
  const envelopeBytes = fs.readFileSync(fixture.paths.handoffEnvelopes);
  const caseBytes = fs.readFileSync(fixture.caseFile);
  const wrongTopic = currentIdentity(exactRoute({
    laneKey: "tg:telegram:500:topic:99",
    messageThreadId: "99",
    sessionSlotKey: "slot-topic-99",
    threadId: "native-topic-99",
  }));
  const wrongProfile = currentIdentity(exactRoute({
    profileId: "other-profile",
    profileFingerprint: "other-profile-fingerprint",
    sessionSlotKey: "slot-other-profile",
    threadId: "native-other-profile",
  }));

  assert.equal(fixture.dispatcher.beginSubjectTurn({ currentRoute: wrongTopic }).status, "none");
  assert.equal(fixture.dispatcher.beginSubjectTurn({ currentRoute: wrongProfile }).status, "none");
  assert.equal(fs.existsSync(fixture.paths.handoffDeliveryEvents), false);

  const begun = fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) });
  assert.equal(begun.status, "ready");
  assert.equal(begun.token.route_match, "EXACT");
  const delivered = fixture.dispatcher.markDelivered(begun.token);
  assert.equal(delivered.result, "delivered");
  assert.equal(delivered.attempt, 1);

  assert.equal(
    fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) }).status,
    "none",
    "delivered without ack is never injected again",
  );
  assert.equal(readJsonl(fixture.paths.handoffDeliveryEvents).length, 1);
  assert.deepEqual(fs.readFileSync(fixture.paths.handoffEnvelopes), envelopeBytes);
  assert.deepEqual(fs.readFileSync(fixture.caseFile), caseBytes);
});

test("a successor transcript retires the delivery as window_gone without touching artifacts", () => {
  const fixture = createFixture("window-gone");
  const envelopeBytes = fs.readFileSync(fixture.paths.handoffEnvelopes);
  const caseBytes = fs.readFileSync(fixture.caseFile);
  const successor = currentIdentity(exactRoute({
    threadId: "native-successor",
    // Same canonical slot: only the D24 native transcript changed.
    sessionSlotKey: fixture.route.session.session_slot_key,
  }));

  assert.equal(fixture.dispatcher.beginSubjectTurn({ currentRoute: successor }).status, "none");
  const events = readJsonl(fixture.paths.handoffDeliveryEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "window_gone");
  assert.equal(events[0].reason, "window_gone");
  assert.equal(
    fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) }).status,
    "none",
    "the original or any successor can never receive a retired handoff",
  );
  assert.deepEqual(fs.readFileSync(fixture.paths.handoffEnvelopes), envelopeBytes);
  assert.deepEqual(fs.readFileSync(fixture.caseFile), caseBytes);
});

test("retryable delivery gets one retry, then becomes terminal and appears in the derived view", () => {
  const fixture = createFixture("retry-cap");
  const first = fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) });
  assert.equal(first.token.attempt, 1);
  assert.equal(
    fixture.dispatcher.markFailed(first.token, { reason: "runtime_busy", retryable: true }).result,
    "retryable_failed",
  );

  const second = fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) });
  assert.equal(second.token.attempt, 2);
  assert.equal(
    fixture.dispatcher.markFailed(second.token, { reason: "runtime_busy_again", retryable: true }).result,
    "terminal_failed",
  );
  for (let index = 0; index < 3; index += 1) {
    assert.equal(fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) }).status, "none");
  }

  const events = readJsonl(fixture.paths.handoffDeliveryEvents);
  assert.deepEqual(events.map((event) => event.result), ["retryable_failed", "terminal_failed"]);
  const summary = readHandoffDeliverySummary({
    deliveryEventsPath: fixture.paths.handoffDeliveryEvents,
  });
  assert.deepEqual(summary, [{
    handoff_id: fixture.envelope.handoff_id,
    delivered: 0,
    acked: 0,
    retryable_failed: 1,
    terminal_failed: 1,
    window_gone: 0,
    attempts: 2,
    latest_failure_reason: "runtime_busy_again",
    latest_failure_at: events[1].started_at,
    terminal_state: "terminal_failed",
  }]);
});

test("ack ledger is separate, supports all dispositions, and replays each ack_id once", () => {
  const root = fixtureRoot("ack-ledger");
  const paths = reviewArtifactPaths(root);
  const ledger = new HandoffAckLedger({ continuityDir: root, enabled: true, now: fixedClock() });
  const deliveryEvents = [];

  for (const [index, disposition] of ["rewrite_submitted", "abandoned", "read_only"].entries()) {
    const expectedDelivery = {
      delivery_id: `delivery-${String(index + 1).padStart(20, "a")}`,
      handoff_id: `handoff-${String(index + 1).padStart(20, "b")}`,
    };
    const ack = {
      ack_id: createHandoffAckId(expectedDelivery.delivery_id),
      delivery_id: expectedDelivery.delivery_id,
      handoff_id: expectedDelivery.handoff_id,
      disposition,
    };
    deliveryEvents.push({ ...expectedDelivery, result: "delivered", attempt: 1 });
    assert.equal(
      ledger.record({ ack, expectedDelivery, subjectTurnId: `turn-${index}` }).status,
      "acknowledged",
    );
    assert.equal(
      ledger.record({ ack, expectedDelivery, subjectTurnId: `turn-replay-${index}` }).status,
      "replayed",
    );
  }

  const ackEvents = readJsonl(paths.handoffAckEvents);
  assert.equal(ackEvents.length, 3);
  assert.equal(fs.existsSync(paths.handoffDeliveryEvents), false, "injector never writes delivery ledger");
  const summary = summarizeHandoffDeliveries({ deliveryEvents, ackEvents });
  assert.equal(summary.length, 3);
  assert.ok(summary.every((row) => row.delivered === 1 && row.acked === 1 && row.terminal_state === "acked"));
});

test("delivery and ack writer leases fail closed with deterministic errors", () => {
  const fixture = createFixture("lease-conflict");
  const deliveryLeaseFile = resolveHandoffWriterLeaseFile({
    continuityDir: fixture.root,
    kind: "delivery",
  });
  const heldDelivery = acquireWriterLease(deliveryLeaseFile, leaseDetails("other-delivery-writer"));
  try {
    assert.throws(
      () => fixture.dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(fixture.route) }),
      (error) => error?.code === "handoff_delivery_writer_lease_unavailable",
    );
    assert.equal(fs.existsSync(fixture.paths.handoffDeliveryEvents), false);
  } finally {
    releaseWriterLease(deliveryLeaseFile, heldDelivery.lease_id);
  }

  const ackLeaseFile = resolveHandoffWriterLeaseFile({ continuityDir: fixture.root, kind: "ack" });
  const heldAck = acquireWriterLease(ackLeaseFile, leaseDetails("other-ack-writer"));
  try {
    const ledger = new HandoffAckLedger({ continuityDir: fixture.root, enabled: true });
    const delivery = { delivery_id: "delivery-123", handoff_id: "handoff-123" };
    assert.throws(
      () => ledger.record({
        ack: {
          ack_id: createHandoffAckId(delivery.delivery_id),
          delivery_id: delivery.delivery_id,
          handoff_id: delivery.handoff_id,
          disposition: "read_only",
        },
        expectedDelivery: delivery,
        subjectTurnId: "turn-1",
      }),
      (error) => error?.code === "handoff_ack_writer_lease_unavailable",
    );
    assert.equal(fs.existsSync(fixture.paths.handoffAckEvents), false);
  } finally {
    releaseWriterLease(ackLeaseFile, heldAck.lease_id);
  }
});

test("disabled dispatcher has zero filesystem side effects and legacy envelopes never dispatch", () => {
  const parent = fixtureRoot("disabled-parent");
  const disabledRoot = path.join(parent, "does-not-exist");
  const disabled = new HandoffDispatcher({ continuityDir: disabledRoot });
  assert.equal(disabled.beginSubjectTurn({ currentRoute: {} }).status, "disabled");
  assert.equal(fs.existsSync(disabledRoot), false);

  const root = fixtureRoot("legacy");
  const paths = reviewArtifactPaths(root);
  fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
  fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify({
    schema_version: 1,
    handoff_id: "handoff-legacy",
    candidate_body: "legacy",
  })}\n`, "utf8");
  const dispatcher = new HandoffDispatcher({ continuityDir: root, enabled: true });
  assert.equal(dispatcher.beginSubjectTurn({ currentRoute: currentIdentity(exactRoute()) }).status, "none");
  assert.equal(fs.existsSync(paths.handoffDeliveryEvents), false);
});

function createFixture(name) {
  const root = fixtureRoot(name);
  const paths = reviewArtifactPaths(root);
  const route = exactRoute();
  const candidate = {
    candidate_id: `cand-${name}`,
    type: "reentry_draft",
    body: `候选原文-${name}`,
    source_ref: { entry_ids: ["entry-1"] },
    subject_route: route,
  };
  const decision = {
    decision_id: `decision-${name}`,
    candidate_id: candidate.candidate_id,
    result: "rejected",
    reason: "imperative_style",
    checks: { imperative_style: false },
  };
  const envelope = createHandoffEnvelope(candidate, decision, "2026-07-31T00:00:00.000Z");
  fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
  fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify(envelope)}\n`, "utf8");
  const caseFile = paths.rejectionCases;
  fs.mkdirSync(path.dirname(caseFile), { recursive: true });
  fs.writeFileSync(caseFile, `${JSON.stringify({ case_id: `case-${name}`, immutable: true })}\n`, "utf8");
  return {
    root,
    paths,
    caseFile,
    route,
    envelope,
    dispatcher: new HandoffDispatcher({ continuityDir: root, enabled: true, now: fixedClock() }),
  };
}

function exactRoute(overrides = {}) {
  const threadId = overrides.threadId || "native-session-a";
  return createSubjectRoute({
    version: 1,
    provider: "telegram",
    continuity_binding: {
      workspace_id: "default",
      account_id: "telegram",
      sender_id: "500",
      binding_key: "default:telegram:500",
    },
    route_lane: {
      lane_key: overrides.laneKey || "tg:telegram:500:topic:9",
      chat_id: "500",
      message_thread_id: Object.hasOwn(overrides, "messageThreadId") ? overrides.messageThreadId : "9",
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: overrides.sessionSlotKey || "slot-topic-9",
      runtime_thread_id: threadId,
      profile_id: overrides.profileId || "subject-profile",
      profile_fingerprint: overrides.profileFingerprint || "profile-fingerprint-a",
      window_id: threadId,
    },
    author_turn_id: "turn-author",
    source_entry_ids: ["entry-1"],
  });
}

function currentIdentity(route) {
  return {
    provider: route.provider,
    continuity_binding: route.continuity_binding,
    route_lane: route.route_lane,
    session: route.session,
  };
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-31T00:00:00.000Z") + tick++ * 1000);
}

function fixtureRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cyberboss-handoff-${name}-`));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

function leaseDetails(writer) {
  return {
    writer,
    model: "test",
    phase: "g2-5",
    branch: "test",
    worktree: "test",
    base_sha: "0".repeat(40),
  };
}
