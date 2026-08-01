"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { readConfig } = require("../src/core/config");
const { ContinuityPipeline } = require("../src/continuity/continuity-pipeline");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const {
  SubjectCapabilityRegistry,
  SubjectCandidateService,
} = require("../src/continuity/subject-signing");
const { canonicalSerialize } = require("../src/continuity/subject-route");
const { sha256 } = require("../src/continuity/continuity-store");

test("subject signing defaults off and background/system lanes cannot obtain a capability", () => {
  const original = process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
  try {
    delete process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
    assert.equal(readConfig().subjectSigningEnabled, false);
  } finally {
    restoreEnv("CYBERBOSS_SUBJECT_SIGNING_ENABLED", original);
  }

  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const app = { subjectCapabilityRegistry: registry };
  const result = CyberbossApp.prototype.issueSubjectCapabilityForTurnFailOpen.call(app, {
    prepared: { provider: "system" },
    lane: { kind: "system" },
  });
  assert.equal(result, null);
  assert.equal(registry.diagnostics.at(-1).code, "non_subject_lane");
});

test("real Telegram subject turn wiring issues one opaque turn-bound capability", () => {
  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const app = {
    subjectCapabilityRegistry: registry,
    subjectCapabilityByRunKey: new Map(),
    runtimeAdapter: { describe: () => ({ id: "claudecode" }) },
  };
  const capability = CyberbossApp.prototype.issueSubjectCapabilityForTurnFailOpen.call(app, {
    bindingKey: "binding-a",
    prepared: {
      provider: "telegram",
      workspaceId: "workspace-a",
      accountId: "telegram",
      senderId: "42",
      chatId: "-100",
      subjectSourceEntryId: "entry-subject",
    },
    lane: {
      kind: "tg",
      laneKey: "lane:-100:7",
      chatId: "-100",
      messageThreadId: "7",
    },
    turn: {
      turnId: "turn-subject",
      threadId: "native-session-a",
      sessionSlotKey: "slot-a",
      profileId: "profile-a",
      profileFingerprint: "profile-fingerprint-a",
      laneKey: "lane:-100:7",
    },
  });
  assert.match(capability.capability_id, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(capability.subject_turn_id, "turn-subject");
  assert.equal(app.subjectCapabilityByRunKey.size, 1);
  registry.expireTurn("turn-subject");
  assert.equal(registry.active.get(capability.capability_id).active, false);
});

test("B and C share createSubjectCandidate and server fixes subject_ai + high", () => {
  const root = temporaryRoot();
  const registry = new SubjectCapabilityRegistry({
    enabled: true,
    now: () => new Date("2026-07-31T01:02:03.000Z"),
  });
  const service = new SubjectCandidateService({ continuityDir: root, registry, enabled: true });

  for (const [origin, materialPackId, turnId, body] of [
    ["live_subject", "", "turn-b", "我想把这一刻留下。"],
    ["closeout_materials_then_subject", "mat-fixture", "turn-c", "我从材料里认出了那次停顿。"],
  ]) {
    const route = exactRoute(turnId, [`entry-${turnId}`]);
    const capability = registry.issue({ subjectTurnId: turnId, subjectRoute: route });
    const result = service.createSubjectCandidate(candidateInput({
      route, capability, origin, materialPackId, body,
      author_role: "extractor",
      semantic_authority: "none",
    }));
    assert.equal(result.status, "created");
    assert.equal(result.candidate.author_role, "subject_ai");
    assert.equal(result.candidate.semantic_authority, "high");
    assert.equal(result.candidate.origin, origin);
    assert.equal(result.candidate.author_attestation.body_sha256, sha256(body));
    assert.equal(result.candidate.author_attestation.subject_turn_id, turnId);
    if (materialPackId) assert.equal(result.candidate.material_pack_id, materialPackId);
  }
});

test("forged metadata, expired turn, changed body and different route cannot sign", () => {
  const root = temporaryRoot();
  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const service = new SubjectCandidateService({ continuityDir: root, registry, enabled: true });
  const route = exactRoute("turn-a", ["entry-a"]);

  assert.throws(() => service.createSubjectCandidate(candidateInput({
    route,
    capability: { capability_id: "forged" },
    origin: "live_subject",
    body: "伪造",
    author_role: "subject_ai",
    semantic_authority: "high",
  })), { code: "capability_expired" });

  const expired = registry.issue({ subjectTurnId: "turn-a", subjectRoute: route });
  registry.expireTurn("turn-a");
  assert.throws(() => service.createSubjectCandidate(candidateInput({
    route, capability: expired, origin: "live_subject", body: "过期",
  })), { code: "capability_expired" });

  const bodyBound = registry.issue({ subjectTurnId: "turn-a", subjectRoute: route });
  registry.verifyAndBind({
    capabilityId: bodyBound.capability_id,
    subjectTurnId: "turn-a",
    subjectRoute: route,
    bodySha256: sha256("原正文"),
    sourceEntryIdsSha256: sha256(canonicalSerialize(["entry-a"])),
  });
  assert.throws(() => service.createSubjectCandidate(candidateInput({
    route, capability: bodyBound, origin: "live_subject", body: "被改正文",
  })), { code: "subject_body_hash_mismatch" });

  const routeBound = registry.issue({ subjectTurnId: "turn-a", subjectRoute: route });
  const otherRoute = exactRoute("turn-a", ["entry-a"], { chatId: "-200" });
  assert.throws(() => service.createSubjectCandidate(candidateInput({
    route: otherRoute, capability: routeBound, origin: "live_subject", body: "跨路由",
  })), { code: "subject_route_mismatch" });

  assert.deepEqual(
    registry.diagnostics.slice(-4).map((event) => event.code),
    ["capability_expired", "capability_expired", "subject_body_hash_mismatch", "subject_route_mismatch"],
  );
  assert.equal(readCandidates(root).length, 0);
});

test("same idempotency key persists once and retry never invokes a model", () => {
  const root = temporaryRoot();
  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const service = new SubjectCandidateService({ continuityDir: root, registry, enabled: true });
  const route = exactRoute("turn-idempotent", ["entry-idempotent"]);
  let modelCalls = 0;
  const body = "同一份正文";
  const firstCapability = registry.issue({ subjectTurnId: "turn-idempotent", subjectRoute: route });
  const first = service.createSubjectCandidate(candidateInput({
    route, capability: firstCapability, origin: "live_subject", body,
  }));
  const retryCapability = registry.issue({ subjectTurnId: "turn-idempotent", subjectRoute: route });
  const retry = service.createSubjectCandidate(candidateInput({
    route, capability: retryCapability, origin: "live_subject", body,
  }));
  assert.equal(first.status, "created");
  assert.equal(retry.status, "duplicate");
  assert.equal(first.candidate.idempotency_key, retry.candidate.idempotency_key);
  assert.equal(readCandidates(root).length, 1);
  assert.equal(modelCalls, 0);
});

test("subject rewrite persists candidate lineage fields and refuses an already-published predecessor", () => {
  const root = temporaryRoot();
  const candidatesPath = path.join(root, "candidates", "episodes.candidates.jsonl");
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(candidatesPath, `${JSON.stringify({
    candidate_id: "cand-old",
    type: "episode",
    body: "old body",
  })}\n`, "utf8");
  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const service = new SubjectCandidateService({ continuityDir: root, registry, enabled: true });
  const route = exactRoute("turn-rewrite", ["entry-rewrite"]);
  const capability = registry.issue({ subjectTurnId: route.author_turn_id, subjectRoute: route });
  const created = service.createSubjectCandidate(candidateInput({
    route,
    capability,
    origin: "subject_rewrite",
    body: "new subject-written body",
    supersedes_candidate_id: "cand-old",
    rewrite_handoff_id: "handoff-old",
    rewrite_of_decision_id: "decision-old-head",
  }));
  assert.equal(created.candidate.supersedes_candidate_id, "cand-old");
  assert.equal(created.candidate.rewrite_handoff_id, "handoff-old");
  assert.equal(created.candidate.rewrite_of_decision_id, "decision-old-head");
  assert.equal(Object.hasOwn(created.candidate, "supersedes"), false);

  fs.mkdirSync(path.join(root, ".jobs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".jobs", "history-writer-state.json"), JSON.stringify({
    published_candidate_ids: ["cand-old"],
  }), "utf8");
  const blockedRoute = exactRoute("turn-rewrite-blocked", ["entry-rewrite-blocked"]);
  const blockedCapability = registry.issue({
    subjectTurnId: blockedRoute.author_turn_id,
    subjectRoute: blockedRoute,
  });
  assert.throws(() => service.createSubjectCandidate(candidateInput({
    route: blockedRoute,
    capability: blockedCapability,
    origin: "subject_rewrite",
    body: "published predecessor cannot be rewritten",
    supersedes_candidate_id: "cand-old",
    rewrite_handoff_id: "handoff-published",
    rewrite_of_decision_id: "decision-published",
  })), { code: "candidate_predecessor_already_published" });
});

test("enabled closeout deterministically persists only a source-derived material pack", async () => {
  const root = temporaryRoot();
  const conversationDir = path.join(root, "conversations");
  fs.mkdirSync(conversationDir, { recursive: true });
  const route = exactRoute("turn-closeout", ["entry-u", "entry-a"]);
  const recorderRoute = exactRecorderRoute();
  const rows = [
    { id: "entry-u", type: "user", timestamp: "2026-07-31T01:00:00.000Z", route: recorderRoute, text: "她说先停一下。", meta: { subject_route: route } },
    { id: "entry-a", type: "runtime.turn.completed", timestamp: "2026-07-31T01:01:00.000Z", route: recorderRoute, text: "我收住了追问。", meta: { subject_route: route } },
  ];
  fs.writeFileSync(
    path.join(conversationDir, "2026-07-31.jsonl"),
    `${rows.map(JSON.stringify).join("\n")}\n`,
    "utf8",
  );
  const pipeline = pipelineFor(root, { subjectSigningEnabled: true });
  let authorCalls = 0;
  const first = await pipeline.runCloseoutAsync({
    date: "2026-07-31",
    author: async () => { authorCalls += 1; return { episodes: [{ body: "forbidden" }] }; },
  });
  assert.equal(first.status, "MATERIAL_READY");
  assert.equal(authorCalls, 0);
  assert.equal(first.candidates.length, 0);
  assert.equal(first.material_pack.created_by, "closeout-materializer");
  assert.equal(first.material_pack.facts, "[2026-07-31T01:00:00.000Z] user: 她说先停一下。\n[2026-07-31T01:01:00.000Z] runtime.turn.completed: 我收住了追问。");
  for (const fragment of first.material_pack.facts.split("\n")) {
    assert.equal(rows.some((row) => fragment.includes(row.text)), true);
  }

  fs.rmSync(path.join(root, ".jobs", "closeout-2026-07-31.json"));
  const second = pipeline.runCloseout({ date: "2026-07-31", subjectRoute: route });
  assert.equal(JSON.stringify(second.material_pack), JSON.stringify(first.material_pack));
  assert.equal(readJsonl(path.join(root, "materials", "closeout-material-packs.jsonl")).length, 1);
});

test("disabled closeout remains byte-compatible and background candidate prose is rejected", () => {
  const root = temporaryRoot();
  seedConversation(root, "2026-07-30");
  const pipeline = pipelineFor(root, { subjectSigningEnabled: false });
  const result = pipeline.runCloseout({
    date: "2026-07-30",
    author: () => ({ episodes: [{ body: "旧路径正文。" }] }),
  });
  assert.equal(result.status, "success");
  assert.equal(result.candidates[0].body, "旧路径正文。");

  const registry = new SubjectCapabilityRegistry({ enabled: true });
  const service = new SubjectCandidateService({ continuityDir: root, registry, enabled: true });
  assert.throws(() => service.createSubjectCandidate({
    created_by: "closeout-materializer",
    episodes: [{ body: "后台建议正文" }],
  }), { code: "background_candidate_forbidden" });
});

test("empty enabled closeout keeps D18 retryable/sealed no_output semantics", () => {
  const openRoot = temporaryRoot();
  const open = pipelineFor(openRoot, { subjectSigningEnabled: true })
    .runCloseout({ date: "2026-07-29", windowClosed: false });
  assert.equal(open.status, "retryable_no_output");
  const closedRoot = temporaryRoot();
  const closed = pipelineFor(closedRoot, { subjectSigningEnabled: true })
    .runCloseout({ date: "2026-07-29", windowClosed: true });
  assert.equal(closed.status, "sealed_no_output");
});

function candidateInput({ route, capability, origin, materialPackId = "", body, ...metadata }) {
  const sourceContentSha256 = sha256("source fixture");
  return {
    type: "episode",
    body,
    origin,
    capability_id: capability.capability_id,
    subject_turn_id: route.author_turn_id,
    subject_route: route,
    source_ref: {
      source_entry_ids: route.source_entry_ids,
      content_sha256: sourceContentSha256,
    },
    ...(materialPackId ? {
      material_pack_id: materialPackId,
      material_pack: {
        material_pack_id: materialPackId,
        source_entry_ids: route.source_entry_ids,
        source_content_sha256: sourceContentSha256,
        facts: "source fixture",
        created_by: "closeout-materializer",
      },
    } : {}),
    ...metadata,
  };
}

function exactRoute(turnId, sourceEntryIds, { chatId = "-100" } = {}) {
  return createSubjectRoute({
    provider: "telegram",
    continuity_binding: {
      workspace_id: "workspace-a",
      account_id: "telegram",
      sender_id: "42",
      binding_key: "binding-a",
    },
    route_lane: {
      lane_key: `lane:${chatId}:7`,
      chat_id: chatId,
      message_thread_id: "7",
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: "slot-a",
      runtime_thread_id: "native-session-a",
      profile_id: "profile-a",
      profile_fingerprint: "profile-fingerprint-a",
      window_id: "native-session-a",
    },
    author_turn_id: turnId,
    source_entry_ids: sourceEntryIds,
  });
}

function exactRecorderRoute() {
  return {
    bindingKey: "binding-a",
    laneKey: "lane:-100:7",
    sessionSlotKey: "slot-a",
    messageThreadId: "7",
    profileId: "profile-a",
    windowId: "native-session-a",
  };
}

function pipelineFor(root, extra = {}) {
  return new ContinuityPipeline({
    continuityDir: root,
    conversationDir: path.join(root, "conversations"),
    writerLeaseFile: path.join(root, ".jobs", "writer.lease"),
    reviewScript: path.join(root, "unused-review.py"),
    worktree: root,
    automationTimezone: "UTC",
    ...extra,
  });
}

function seedConversation(root, date) {
  const dir = path.join(root, "conversations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify({
    id: "entry-legacy",
    type: "user",
    timestamp: `${date}T01:00:00.000Z`,
    route: exactRecorderRoute(),
    text: "legacy fixture",
  })}\n`, "utf8");
}

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-subject-signing-"));
}

function readCandidates(root) {
  return readJsonl(path.join(root, "candidates", "episodes.candidates.jsonl"));
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
