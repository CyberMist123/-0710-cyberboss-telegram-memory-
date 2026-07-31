"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { ContextTraceRecorder, sanitizeTraceEntry } = require("../src/core/context-trace");
const { TurnGateStore } = require("../src/core/turn-gate-store");
const { stripConversationArtifacts } = require("../src/continuity/conversation-purity");
const {
  createHandoffAckId,
  formatSubjectMemoryHandoff,
  injectSubjectMemoryHandoff,
  parseSubjectMemoryHandoffAck,
} = require("../src/continuity/handoff-context");
const { HandoffDispatcher } = require("../src/continuity/handoff-dispatcher");
const { createHandoffEnvelope, reviewArtifactPaths } = require("../src/continuity/review-artifacts");
const { createSubjectRoute } = require("../src/continuity/subject-route");

test("handoff block deterministically copies the immutable envelope and parses tagged ack", () => {
  const envelope = fixtureEnvelope("deterministic");
  const deliveryId = "delivery-0123456789abcdef0123";
  const block = formatSubjectMemoryHandoff({ envelope, deliveryId });

  assert.match(block, /^<subject_memory_handoff>/u);
  assert.ok(block.includes(envelope.candidate_body), "candidate body is copied verbatim");
  assert.ok(block.includes(`reason_code: ${envelope.reason.code}`));
  assert.ok(block.includes(`handoff_id: ${envelope.handoff_id}`));
  assert.ok(block.includes(`delivery_id: ${deliveryId}`));
  assert.equal(block, formatSubjectMemoryHandoff({ envelope, deliveryId }), "assembly is pure/deterministic");
  assert.equal(injectSubjectMemoryHandoff("ORIGINAL_PAYLOAD", block), `${block}\n\nORIGINAL_PAYLOAD`);

  const ack = {
    ack_id: createHandoffAckId(deliveryId),
    delivery_id: deliveryId,
    handoff_id: envelope.handoff_id,
    disposition: "rewrite_submitted",
  };
  assert.deepEqual(
    parseSubjectMemoryHandoffAck(
      `reply\n<subject_memory_handoff_ack>${JSON.stringify(ack)}</subject_memory_handoff_ack>`,
    ),
    ack,
  );
  assert.equal(parseSubjectMemoryHandoffAck("free-form: I read it"), null);
  assert.equal(parseSubjectMemoryHandoffAck(
    `<subject_memory_handoff_ack>${JSON.stringify({ ...ack, disposition: "invented" })}</subject_memory_handoff_ack>`,
  ), null);

  const source = fs.readFileSync(require.resolve("../src/continuity/handoff-context"), "utf8");
  assert.doesNotMatch(source, /runtimeAdapter|sendTurn|runBackgroundTurn/u, "pure assembly has no runtime/model call");
});

test("purity strips handoff and ack artifacts before closeout material", () => {
  const envelope = fixtureEnvelope("purity");
  const deliveryId = "delivery-abcdef0123456789abcd";
  const block = formatSubjectMemoryHandoff({ envelope, deliveryId });
  const ack = `<subject_memory_handoff_ack>${JSON.stringify({
    ack_id: createHandoffAckId(deliveryId),
    delivery_id: deliveryId,
    handoff_id: envelope.handoff_id,
    disposition: "read_only",
  })}</subject_memory_handoff_ack>`;
  const cleaned = stripConversationArtifacts(`真实用户内容\n\n${block}\n\n${ack}\n\n真实回复`);
  assert.equal(cleaned, "真实用户内容\n\n真实回复");
  assert.equal(cleaned.includes(envelope.candidate_body), false);
  assert.equal(cleaned.includes("subject_memory_handoff"), false);
});

test("context trace retains handoff explanation fields and never records body", () => {
  const body = "绝不能进入 trace 的候选正文";
  const row = sanitizeTraceEntry({
    threadId: "thread-secret",
    turnId: "turn-1",
    blocks: [{
      type: "subject_memory_handoff",
      loaded: true,
      reason: "exact_route",
      handoff_id: "handoff-abc",
      route_match: "EXACT",
      chars: body.length,
      result: "injected",
      candidate_body: body,
    }],
  });
  const handoff = row.blocks[0];
  assert.deepEqual(handoff, {
    type: "subject_memory_handoff",
    loaded: true,
    reason: "exact_route",
    chars: body.length,
    hash: "",
    src_mtime: "",
    handoff_id: "handoff-abc",
    route_match: "EXACT",
    result: "injected",
  });
  assert.equal(JSON.stringify(row).includes(body), false);
});

test("app injects once, records trace, and marks delivered only after both succeed", async () => {
  const fixture = createAppFixture("app-injection", { enabled: true });
  const ok = await fixture.app.dispatchPreparedTurn({
    bindingKey: fixture.bindingKey,
    workspaceRoot: "/workspace",
    prepared: fixture.prepared,
    lane: fixture.lane,
  });
  assert.equal(ok, true);
  assert.match(fixture.runtimeTexts[0], /<subject_memory_handoff>/u);
  assert.ok(fixture.runtimeTexts[0].includes(fixture.envelope.candidate_body));

  const deliveryEvents = readJsonl(fixture.paths.handoffDeliveryEvents);
  assert.equal(deliveryEvents.length, 1);
  assert.equal(deliveryEvents[0].result, "delivered");
  const traceRows = readJsonl(fixture.tracePath);
  const traceBlock = traceRows[0].blocks.find((item) => item.type === "subject_memory_handoff");
  assert.equal(traceBlock.handoff_id, fixture.envelope.handoff_id);
  assert.equal(traceBlock.route_match, "EXACT");
  assert.equal(traceBlock.result, "injected");
  assert.equal(JSON.stringify(traceRows).includes(fixture.envelope.candidate_body), false);

  fixture.app.turnGateStore.releaseThread("native-session-a");
  await fixture.app.dispatchPreparedTurn({
    bindingKey: fixture.bindingKey,
    workspaceRoot: "/workspace",
    prepared: { ...fixture.prepared, messageId: "message-2" },
    lane: fixture.lane,
  });
  assert.equal(fixture.runtimeTexts[1].includes("subject_memory_handoff"), false);
  assert.equal(readJsonl(fixture.paths.handoffDeliveryEvents).length, 1);
});

test("switch off is byte-identical and injection preparation failure remains fail-open", async () => {
  const disabled = createAppFixture("app-disabled", { enabled: false, writeEnvelope: false });
  const rootExistedBefore = fs.existsSync(disabled.continuityDir);
  assert.equal(rootExistedBefore, false);
  assert.equal(await disabled.app.dispatchPreparedTurn({
    bindingKey: disabled.bindingKey,
    workspaceRoot: "/workspace",
    prepared: disabled.prepared,
    lane: disabled.lane,
  }), true);
  assert.equal(disabled.runtimeTexts[0], "ORIGINAL_PAYLOAD");
  assert.equal(fs.existsSync(disabled.continuityDir), false, "disabled path creates no file or directory");

  const failing = createAppFixture("app-fail-open", { enabled: false, writeEnvelope: false });
  failing.app.prepareHandoffForSubjectTurnFailOpen = () => {
    throw new Error("injection exploded");
  };
  assert.equal(await failing.app.dispatchPreparedTurn({
    bindingKey: failing.bindingKey,
    workspaceRoot: "/workspace",
    prepared: failing.prepared,
    lane: failing.lane,
  }), true);
  assert.equal(failing.runtimeTexts[0], "ORIGINAL_PAYLOAD");
});

test("trace failure after model input is fail-open but terminal, so正文 is never replayed", async () => {
  const fixture = createAppFixture("trace-fail-open", { enabled: true });
  fixture.app.recordContextTrace = () => {
    throw new Error("trace unavailable");
  };
  assert.equal(await fixture.app.dispatchPreparedTurn({
    bindingKey: fixture.bindingKey,
    workspaceRoot: "/workspace",
    prepared: fixture.prepared,
    lane: fixture.lane,
  }), true);
  assert.match(fixture.runtimeTexts[0], /<subject_memory_handoff>/u);
  const [failed] = readJsonl(fixture.paths.handoffDeliveryEvents);
  assert.equal(failed.result, "terminal_failed");
  assert.equal(failed.reason, "context_trace_write_failed_after_injection");

  fixture.app.turnGateStore.releaseThread("native-session-a");
  await fixture.app.dispatchPreparedTurn({
    bindingKey: fixture.bindingKey,
    workspaceRoot: "/workspace",
    prepared: { ...fixture.prepared, messageId: "message-2" },
    lane: fixture.lane,
  });
  assert.equal(fixture.runtimeTexts[1], "ORIGINAL_PAYLOAD");
  assert.equal(readJsonl(fixture.paths.handoffDeliveryEvents).length, 1);
});

test("ack ledger failure is swallowed by the completed-turn handler", async () => {
  const delivery = { delivery_id: "delivery-ack-fail", handoff_id: "handoff-ack-fail" };
  const ack = {
    ack_id: createHandoffAckId(delivery.delivery_id),
    delivery_id: delivery.delivery_id,
    handoff_id: delivery.handoff_id,
    disposition: "abandoned",
  };
  const appLike = {
    handoffAckLedger: { record() { throw new Error("ack disk unavailable"); } },
  };
  const result = await CyberbossApp.prototype.recordHandoffAckFromTurnFailOpen.call(
    appLike,
    {
      turnId: "turn-ack-fail",
      text: `<subject_memory_handoff_ack>${JSON.stringify(ack)}</subject_memory_handoff_ack>`,
    },
    delivery,
  );
  assert.equal(result, null);
});

function createAppFixture(name, { enabled, writeEnvelope = true }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `cyberboss-handoff-${name}-`));
  const continuityDir = enabled || writeEnvelope ? path.join(parent, "continuity") : path.join(parent, "absent");
  const paths = reviewArtifactPaths(continuityDir);
  const envelope = fixtureEnvelope(name);
  if (writeEnvelope) {
    fs.mkdirSync(path.dirname(paths.handoffEnvelopes), { recursive: true });
    fs.writeFileSync(paths.handoffEnvelopes, `${JSON.stringify(envelope)}\n`, "utf8");
  }
  const tracePath = path.join(continuityDir, "trace", "context_trace.jsonl");
  const runtimeTexts = [];
  const bindingKey = envelope.subject_route.continuity_binding.binding_key;
  const lane = {
    kind: "tg",
    laneKey: envelope.subject_route.route_lane.lane_key,
    chatId: envelope.subject_route.route_lane.chat_id,
    messageThreadId: envelope.subject_route.route_lane.message_thread_id,
  };
  const prepared = {
    provider: "telegram",
    workspaceId: "default",
    accountId: "telegram",
    senderId: "500",
    chatId: "500",
    messageThreadId: "9",
    messageId: "message-1",
    contextToken: "telegram:500",
    originalText: "hello",
    text: "hello",
  };
  const app = {
    config: {},
    handoffDispatcher: enabled ? new HandoffDispatcher({ continuityDir, enabled: true }) : null,
    handoffDeliveryByRunKey: new Map(),
    contextTraceRecorder: new ContextTraceRecorder({ filePath: enabled ? tracePath : "" }),
    contextTraceRunState: new Map(),
    turnGateStore: new TurnGateStore(),
    channelAdapter: { async sendTyping() {}, async sendText() {} },
    streamDelivery: {
      setReplyTargetForThread() {}, bindReplyTargetForTurn() {}, queueReplyTargetForThread() {},
    },
    runtimeContextStore: { setActiveContext() {} },
    pendingOperationByRunKey: new Map(),
    runtimeAdapter: {
      describe: () => ({ id: "claudecode" }),
      getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({ model: "" }) }),
      resolveRouteSession: () => ({
        sessionSlotKey: "slot-topic-9",
        laneKey: lane.laneKey,
        messageThreadId: "9",
        threadId: "native-session-a",
        profileId: "subject-profile",
        profileFingerprint: "profile-fingerprint-a",
      }),
      async sendTurn(args) {
        runtimeTexts.push(args.text);
        return {
          threadId: "native-session-a",
          turnId: `turn-${runtimeTexts.length}`,
          sessionSlotKey: "slot-topic-9",
          laneKey: lane.laneKey,
          profileId: "subject-profile",
          continuity: { blocks: [], skipped: [], total_chars: 0 },
        };
      },
    },
    async buildRuntimeTurn() { return { text: "ORIGINAL_PAYLOAD", attachments: [] }; },
    resolveLaunchProfileForLane: () => null,
    recordRoutingTelemetry() {},
    dispatchPreparedTurn: CyberbossApp.prototype.dispatchPreparedTurn,
    prepareHandoffForSubjectTurnFailOpen: CyberbossApp.prototype.prepareHandoffForSubjectTurnFailOpen,
    completeHandoffDeliveryFailOpen: CyberbossApp.prototype.completeHandoffDeliveryFailOpen,
    failHandoffDeliveryFailOpen: CyberbossApp.prototype.failHandoffDeliveryFailOpen,
    recordContextTrace: CyberbossApp.prototype.recordContextTrace,
  };
  return { app, continuityDir, paths, tracePath, runtimeTexts, envelope, bindingKey, lane, prepared };
}

function fixtureEnvelope(name) {
  const candidate = {
    candidate_id: `cand-${name}`,
    type: "reentry_draft",
    body: `逐字候选正文-${name}\n第二行`,
    source_ref: { entry_ids: ["entry-1"] },
    subject_route: createSubjectRoute({
      version: 1,
      provider: "telegram",
      continuity_binding: {
        workspace_id: "default",
        account_id: "telegram",
        sender_id: "500",
        binding_key: "default:telegram:500",
      },
      route_lane: {
        lane_key: "tg:telegram:500:topic:9",
        chat_id: "500",
        message_thread_id: "9",
      },
      session: {
        runtime_id: "claudecode",
        session_slot_key: "slot-topic-9",
        runtime_thread_id: "native-session-a",
        profile_id: "subject-profile",
        profile_fingerprint: "profile-fingerprint-a",
        window_id: "native-session-a",
      },
      author_turn_id: "author-turn",
      source_entry_ids: ["entry-1"],
    }),
  };
  return createHandoffEnvelope(candidate, {
    decision_id: `decision-${name}`,
    candidate_id: candidate.candidate_id,
    result: "rejected",
    reason: "imperative_style",
    checks: { imperative_style: false },
  }, "2026-07-31T00:00:00.000Z");
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}
