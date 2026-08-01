const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { acquireWriterLease, releaseWriterLease } = require("../src/orchestration/writer-lease");
const { authorCloseout } = require("../src/continuity/background-author");
const { stripConversationArtifacts } = require("../src/continuity/conversation-purity");
const {
  ContinuityPipeline,
  PUBLISH_REFUSED_EVENT,
  buildLocalChecks,
  createCandidate,
  createDecision,
} = require("../src/continuity/continuity-pipeline");
const { appendJsonlUnique, loadJson, readJsonl } = require("../src/continuity/continuity-store");
const { detailsFileFor, readDetailsForLookup } = require("../src/continuity/detail-ledger");
const { MATERIAL_ROUTE_EXACT } = require("../src/continuity/subject-route");
const { MemoryLookupService } = require("../src/services/memory-lookup-service");

const SUBJECT_AI_METADATA = {
  origin: "live_closeout",
  authorRole: "subject_ai",
  authorModel: "fixture-subject-ai",
  contextScope: "active_session",
  semanticAuthority: "high",
  needsSubjectReview: false,
};

test("closeout, review, and history writer are byte-idempotent and preserve authored wording", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  let authorCalls = 0;
  const closeout = pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author({ materials, routeStatus, route, sourceEntryIds }) {
      authorCalls += 1;
      assert.match(materials, /此刻真实原话/);
      assert.doesNotMatch(materials, /注入回声|打回信封正文|secret\.png|旧 Episode 正文|工具结果/);
      assert.equal(routeStatus, MATERIAL_ROUTE_EXACT);
      assert.equal(route.windowId, "native-session-fixture");
      assert.deepEqual(sourceEntryIds, ["entry-fixture-user", "entry-fixture-reply"]);
      return {
        episodes: [{ body: "2026-07-11，在测试场景里，她说“此刻真实原话”。我注意到这仍悬着。" }],
        self_note: "我选择先承认悬而未决。",
        reentry_draft: "我刚走到一次仍未结束的确认；下一次先看她此刻怎么说。我不确定这个钩子是否还相关。",
      };
    },
  });
  assert.equal(closeout.status, "success");
  assert.equal(closeout.candidates.length, 3);
  assert.equal(authorCalls, 1);
  for (const candidate of readJsonl(pipeline.paths.candidates)) {
    assert.deepEqual(Object.keys(candidate), [
      "candidate_id", "ts", "type", "author", "origin", "author_role", "author_model",
      "context_scope", "semantic_authority", "needs_subject_review", "body", "source_ref",
      "idempotency_key",
    ]);
    assert.equal(candidate.origin, "live_closeout");
    assert.equal(candidate.author_role, "subject_ai");
    assert.equal(candidate.semantic_authority, "high");
    assert.equal(candidate.needs_subject_review, false);
    assert.deepEqual(
      candidate.source_ref.source_entry_ids,
      ["entry-fixture-user", "entry-fixture-reply"],
    );
    assert.equal(candidate.source_ref.source_entry_hashes.length, 2);
  }

  const review = pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  assert.equal(review.status, "success");
  assert.equal(review.decisions.length, 3);
  for (const decision of review.decisions) {
    assert.equal(Object.prototype.hasOwnProperty.call(decision, "body"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, "rewrite"), false);
  }
  const writer = pipeline.runHistoryWriter();
  assert.equal(writer.written.length, 3);
  assert.equal(writer.skipped.length, 0);
  const episodeCandidate = readJsonl(pipeline.paths.candidates).find((item) => item.type === "episode");
  const episode = readJsonl(pipeline.paths.episodes)[0];
  assert.equal(episode.body, episodeCandidate.body);
  assert.equal(episode.origin, "live_closeout");
  assert.equal(episode.author_role, "subject_ai");
  assert.equal(fs.readFileSync(pipeline.paths.reentry, "utf8"), readJsonl(pipeline.paths.candidates).find((item) => item.type === "reentry_draft").body);
  assert.match(fs.readFileSync(pipeline.paths.selfNotes, "utf8"), /我选择先承认悬而未决。/);

  const before = snapshotBytes(fixture.continuityDir);
  const secondCloseout = pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => { authorCalls += 1; return {}; },
  });
  const secondReview = pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  const secondWriter = pipeline.runHistoryWriter();
  assert.equal(secondCloseout.status, "success");
  assert.equal(secondCloseout.reason, "already_ran");
  assert.equal(secondCloseout.author_called, false);
  assert.equal(secondReview.decisions.length, 0);
  assert.equal(secondWriter.written.length, 0);
  assert.equal(authorCalls, 1);
  assert.deepEqual(snapshotBytes(fixture.continuityDir), before);
  assert.equal(hashFile(fixture.stateLog), fixture.stateLogHash);
});

test("background proxy closeout candidates remain deferred and never publish canon", () => {
  const fixture = createFixture();
  fixture.pipeline.runCloseout({
    date: "2026-07-11",
    author: () => ({
      episodes: [{ body: "后台代理可以提出这条 Episode 候选。" }],
      self_note: "后台代理不能替主体认领这段自述。",
      reentry_draft: "后台代理不能直接成为下一次醒来的交接。",
    }),
  });

  const candidates = readJsonl(fixture.pipeline.paths.candidates);
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    assert.equal(candidate.origin, "nightly_closeout");
    assert.equal(candidate.author_role, "background_proxy");
    assert.equal(candidate.context_scope, "daily_materials");
    assert.equal(candidate.semantic_authority, "none");
  }
  assert.equal(candidates.find((item) => item.type === "episode").needs_subject_review, false);
  assert.equal(candidates.find((item) => item.type === "self_note").needs_subject_review, true);
  assert.equal(candidates.find((item) => item.type === "reentry_draft").needs_subject_review, true);

  const decisions = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
  }).decisions;
  const episodeCandidate = candidates.find((item) => item.type === "episode");
  const episodeDecision = decisions.find((item) => item.candidate_id === episodeCandidate.candidate_id);
  assert.equal(episodeDecision.result, "deferred");
  assert.equal(episodeDecision.reason, "semantic_authority_missing");
  for (const type of ["self_note", "reentry_draft"]) {
    const candidate = candidates.find((item) => item.type === type);
    const decision = decisions.find((item) => item.candidate_id === candidate.candidate_id);
    assert.equal(decision.result, "deferred");
    assert.equal(decision.reason, "semantic_authority_missing");
    assert.equal(Object.prototype.hasOwnProperty.call(decision, "body"), false);
  }

  const writer = fixture.pipeline.runHistoryWriter();
  assert.equal(writer.written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.selfNotes), false);
  assert.equal(fs.existsSync(fixture.pipeline.paths.reentry), false);
});

test("episode candidates with an empty author have no publication authority", () => {
  const fixture = createFixture();
  const candidate = createCandidate({
    date: "2026-07-11",
    type: "episode",
    author: "",
    body: "没有作者的 Episode 候选不能进入正史。",
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");

  const decision = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
  }).decisions[0];
  assert.equal(decision.result, "deferred");
  assert.equal(decision.reason, "semantic_authority_missing");
  assert.equal(decision.checks.publication_allowed, false);
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
});

test("legacy janitor candidates are mapped to extractor authority and cannot publish", () => {
  const fixture = createFixture();
  const legacy = {
    candidate_id: "cand-legacy-janitor",
    ts: "2026-07-11T23:59:59+08:00",
    type: "episode",
    author: "janitor",
    body: "旧 Janitor 小模型曾经写出的解释。",
    source_ref: { file: fixture.conversationFile, window: "1-2" },
    idempotency_key: "legacy-janitor",
  };
  appendJsonlUnique(fixture.pipeline.paths.candidates, [legacy], "candidate_id");

  const decision = fixture.pipeline.runReview({
    env: { ...process.env, AUTO_REVIEW_MOCK: "accept" },
  }).decisions[0];
  assert.equal(decision.result, "deferred");
  assert.equal(decision.reason, "semantic_authority_missing");
  assert.equal(decision.checks.publication_allowed, false);
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);

  const fixture2 = createFixture();
  appendJsonlUnique(fixture2.pipeline.paths.candidates, [legacy], "candidate_id");
  appendJsonlUnique(fixture2.pipeline.paths.decisions, [{
    decision_id: "decision-malicious-accept",
    candidate_id: legacy.candidate_id,
    result: "accepted",
    reason: "fixture",
    checks: {},
    merged_into: null,
    pushed_to_user: false,
  }], "decision_id");
  assert.equal(fixture2.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  const defensive = fixture2.pipeline.runHistoryWriter();
  assert.equal(defensive.written.length, 0);
  assert.equal(defensive.skipped.length, 1);
  assert.equal(defensive.skipped[0].decision_id, "decision-malicious-accept");
  assert.match(defensive.skipped[0].publication_intent_id, /^intent-[0-9a-f]{20}$/u);
  assert.equal(defensive.skipped[0].reason, "semantic_authority_missing");
  assert.equal(fs.existsSync(fixture2.pipeline.paths.episodes), false);
});

test("duplicate candidates merge without a second canon write", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ episodes: [{ body: "同一段主体 AI 原稿。" }] }),
  });
  pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  pipeline.runHistoryWriter();
  const duplicate = createCandidate({
    date: "2026-07-12",
    type: "episode",
    author: "closeout",
    body: "同一段主体 AI 原稿。",
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
  });
  appendJsonlUnique(pipeline.paths.candidates, [duplicate], "candidate_id");
  const result = pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  assert.equal(result.decisions[0].result, "merged");
  assert.ok(result.decisions[0].merged_into);
  pipeline.runHistoryWriter();
  assert.equal(readJsonl(pipeline.paths.episodes).length, 1);
});

// issue #36 起，开头的祈使句不再只是警告，而是打回（reason=imperative_style）。
// 句中的祈使措辞仍然只标 checks.imperative_warning，不影响结果。
test("leading imperatives are deferred, mid-sentence ones only warn, and boundary conflicts are pushed", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ reentry_draft: "下次必须先确认这一点。" }),
  });
  const blocked = pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } }).decisions[0];
  assert.equal(blocked.result, "deferred");
  assert.equal(blocked.reason, "imperative_style");
  assert.equal(blocked.checks.imperative_style, true);
  assert.equal(blocked.checks.imperative_warning, true);

  const fixtureWarn = createFixture();
  fixtureWarn.pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ reentry_draft: "我当时觉得必须先确认，后来没确认成，这个钩子还悬着。" }),
  });
  const warning = fixtureWarn.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } }).decisions[0];
  assert.equal(warning.result, "accepted");
  assert.equal(warning.checks.imperative_style, false);
  assert.equal(warning.checks.imperative_warning, true);

  const fixture2 = createFixture();
  fixture2.pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ episodes: [{ body: "这条触及已确认边界。" }] }),
  });
  const conflict = fixture2.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "reject_conflict" } }).decisions[0];
  assert.equal(conflict.result, "rejected");
  assert.equal(conflict.reason, "reject_conflict");
  assert.equal(conflict.pushed_to_user, true);
});

test("correction appends and never overwrites the superseded episode", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  pipeline.runCloseout({ date: "2026-07-11", candidateMetadata: SUBJECT_AI_METADATA, author: () => ({ episodes: [{ body: "原事件。" }] }) });
  pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  pipeline.runHistoryWriter();
  const original = readJsonl(pipeline.paths.episodes)[0];
  const correction = createCandidate({
    date: "2026-07-12",
    type: "episode",
    author: "closeout",
    body: "后来确认的修正。",
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
    ...SUBJECT_AI_METADATA,
  });
  correction.canon_supersedes = original.ep_id;
  appendJsonlUnique(pipeline.paths.candidates, [correction], "candidate_id");
  pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  pipeline.runHistoryWriter();
  const entries = readJsonl(pipeline.paths.episodes);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].body, "原事件。");
  assert.equal(entries[1].type, "correction");
  assert.equal(entries[1].supersedes, original.ep_id);
});

test("writer lease contention skips background work without calling the model", () => {
  const fixture = createFixture();
  const lease = acquireWriterLease(fixture.writerLeaseFile, {
    writer: "fixture-holder", model: "fixture", phase: "phase3", branch: "fixture",
    worktree: fixture.root, base_sha: "a".repeat(40),
  });
  let called = false;
  try {
    const result = fixture.pipeline.runCloseout({ date: "2026-07-11", author: () => { called = true; return {}; } });
    assert.deepEqual(result, { status: "skipped", reason: "lease_unavailable" });
    assert.equal(called, false);
  } finally {
    releaseWriterLease(fixture.writerLeaseFile, lease.lease_id);
  }
});

test("continuity pipeline recovers a dead writer lease before background work", () => {
  const fixture = createFixture({ isProcessAlive: () => false });
  const stale = acquireWriterLease(fixture.writerLeaseFile, {
    writer: "dead-review-writer", model: "fixture", phase: "phase3", branch: "fixture",
    worktree: fixture.root, base_sha: "a".repeat(40), owner_pid: 424242,
  });
  let called = false;
  const result = fixture.pipeline.runCloseout({
    date: "2026-07-11",
    author: () => { called = true; return {}; },
  });
  assert.equal(result.status, "retryable_no_output");
  assert.equal(called, true);
  assert.equal(fs.existsSync(fixture.writerLeaseFile), false);
  const archiveDir = path.join(fixture.continuityDir, ".backups", "writer-leases");
  const archives = fs.readdirSync(archiveDir);
  assert.equal(archives.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archiveDir, archives[0]), "utf8")).lease_id, stale.lease_id);
});

test("review failure defers the candidate and never publishes canon", () => {
  const fixture = createFixture();
  fixture.pipeline.runCloseout({ date: "2026-07-11", author: () => ({ episodes: [{ body: "等待审核。" }] }) });
  const decision = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "defer" } }).decisions[0];
  assert.equal(decision.result, "deferred");
  assert.equal(fixture.pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
});

test("review model can be disabled without bypassing deterministic checks", () => {
  const fixture = createFixture();
  const closeout = fixture.pipeline.runCloseout({
    date: "2026-07-11",
    author: () => ({ episodes: ["有来源的确定性候选。"] }),
    candidateMetadata: { authorRole: "subject_ai", semanticAuthority: "high", needsSubjectReview: false },
  });
  assert.equal(closeout.candidates.length, 1);
  const review = fixture.pipeline.runReview({ env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" } });
  assert.equal(review.decisions[0].result, "accepted");
  assert.equal(review.decisions[0].reason, "model_review_disabled");
  assert.equal(review.decisions[0].checks.source_ref_located, true);
  assert.equal(review.decisions[0].checks.length_ok, true);
});

test("closeout source evidence is located by entry id and exact persisted-line hash", () => {
  const fixture = createFixture();
  const closeout = fixture.pipeline.runCloseout({
    date: "2026-07-11",
    author: () => ({ episodes: ["按 entry ID 取证。"] }),
    candidateMetadata: { authorRole: "subject_ai", semanticAuthority: "high", needsSubjectReview: false },
  });
  const sourceRef = closeout.candidates[0].source_ref;
  assert.deepEqual(sourceRef.source_entry_ids, ["entry-fixture-user", "entry-fixture-reply"]);
  assert.equal(sourceRef.source_entry_hashes.length, 2);

  const lines = fs.readFileSync(fixture.conversationFile, "utf8").trim().split(/\r?\n/u);
  const tampered = JSON.parse(lines[0]);
  tampered.text = "同 ID 但正文已被篡改";
  lines[0] = JSON.stringify(tampered);
  fs.writeFileSync(fixture.conversationFile, `${lines.join("\n")}\n`, "utf8");

  const review = fixture.pipeline.runReview({ env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" } });
  assert.equal(review.decisions[0].result, "deferred");
  assert.equal(review.decisions[0].reason, "source_ref_missing");
  assert.equal(review.decisions[0].checks.source_ref_located, false);
});

test("over-budget Re-entry is retained as evidence, deferred, and never published", () => {
  const fixture = createFixture();
  fixture.pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ reentry_draft: "她".repeat(301) }),
  });
  const candidate = readJsonl(fixture.pipeline.paths.candidates)[0];
  assert.equal(candidate.body.length, 301);
  const decision = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } }).decisions[0];
  assert.equal(decision.result, "deferred");
  assert.equal(decision.reason, "over_budget");
  fixture.pipeline.runHistoryWriter();
  assert.equal(fs.existsSync(fixture.pipeline.paths.reentry), false);
});

// issue #76 目标 3：canon 的最后一个写入点必须自己证明预算成立。
// 威胁模型是「decisions.jsonl 被手改 / Review 被绕过 / 预算常量漂移」——
// 这三种情况下 Review 侧的 length_ok 都不在场，只有 History writer 能挡。
test("history writer refuses an over-budget reentry draft even with an accepted decision", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ reentry_draft: "她".repeat(954) }),
  });
  const candidate = readJsonl(pipeline.paths.candidates)[0];
  // Review 绕过：直接伪造一条 accepted，模拟决策账被手改。
  const forged = createDecision(candidate, {
    result: "accepted",
    reason: "model_review_disabled",
    checks: { ...buildLocalChecks(candidate, true), length_ok: true },
  });
  appendJsonlUnique(pipeline.paths.decisions, [forged], "decision_id");
  assert.equal(pipeline.repairReviewArtifacts().publication_intent_complete, true);

  const first = pipeline.runHistoryWriter();
  assert.equal(first.written.length, 0);
  assert.equal(fs.existsSync(pipeline.paths.reentry), false);
  const refusal = first.skipped.find((item) => item.decision_id === forged.decision_id);
  assert.equal(refusal.reason, "over_budget");
  assert.equal(refusal.candidate_id, candidate.candidate_id);

  // 这是与 Review 案例库共存的 History 发布闸诊断：仍只写自己的
  // diagnostic_events，正文不复制，只留可 join 的 candidate_id 与摘要哈希。
  const event = first.diagnostics.find((item) => item.event === PUBLISH_REFUSED_EVENT);
  assert.equal(event.candidate_id, candidate.candidate_id);
  assert.equal(event.chars, 954);
  assert.equal(event.budget, 300);
  assert.equal(event.body_sha256.length, 64);
  assert.equal(Object.prototype.hasOwnProperty.call(event, "body"), false);
  const state = loadJson(pipeline.paths.writerState, {});
  assert.equal(state.diagnostic_events.filter((item) => item.event_id === event.event_id).length, 1);
  // 不记 applied：改写重交后能再次走到发布点（D17 打回可重试）。
  assert.equal((state.applied_decision_ids || []).includes(forged.decision_id), false);
  // 正文原样留在候选层，后台一个字都不许截断或改写（D16 / D19）。
  assert.equal(readJsonl(pipeline.paths.candidates)[0].body, "她".repeat(954));

  const second = pipeline.runHistoryWriter();
  assert.equal(second.written.length, 0);
  assert.equal(fs.existsSync(pipeline.paths.reentry), false);
  assert.equal(loadJson(pipeline.paths.writerState, {}).diagnostic_events.length, 1);

  // 原作者改写重交：同一条链在预算内就能发布，打回不是死路。
  const rewritten = createCandidate({
    date: "2026-07-11",
    type: "reentry_draft",
    author: "subject_ai",
    body: "我停在她那句「先不管了」上，明天先看她此刻怎么说。",
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
    origin: "live_closeout",
    authorRole: "subject_ai",
    authorModel: "fixture-subject-ai",
    contextScope: "active_session",
    semanticAuthority: "high",
    needsSubjectReview: false,
  });
  appendJsonlUnique(pipeline.paths.candidates, [rewritten], "candidate_id");
  const review = pipeline.runReview({ env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" } });
  assert.equal(review.decisions.find((item) => item.candidate_id === rewritten.candidate_id).result, "accepted");
  const third = pipeline.runHistoryWriter();
  assert.equal(third.written.length, 1);
  assert.equal(fs.readFileSync(pipeline.paths.reentry, "utf8"), rewritten.body);
});

// issue #76 目标 1：账本（details）走与 Re-entry 同一条发布链，
// 落 details.jsonl，只能经 memory_lookup 被翻到，永不进注入通路。
test("details ledger publishes through the same chain and is only reachable by lookup", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  assert.equal(pipeline.paths.details, detailsFileFor(fixture.continuityDir));
  const body = "下次复查：2026-08-03，空腹；她只喝冰美式。";
  const candidate = createCandidate({
    date: "2026-07-11",
    type: "details",
    author: "subject_ai",
    body,
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
    origin: "live_closeout",
    authorRole: "subject_ai",
    authorModel: "fixture-subject-ai",
    contextScope: "active_session",
    semanticAuthority: "high",
    needsSubjectReview: false,
  });
  appendJsonlUnique(pipeline.paths.candidates, [candidate], "candidate_id");

  const review = pipeline.runReview({ env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" } });
  const decision = review.decisions[0];
  // 账本条目豁免祈使句式闸门（宪法第三条）：「下次复查」在账本里是一个字段，
  // 不是写给明天的我的规则。若豁免失效这里会变成 deferred/imperative_style。
  assert.equal(decision.result, "accepted");
  assert.equal(decision.checks.imperative_exempt, "structured_ledger_type");

  const writer = pipeline.runHistoryWriter();
  assert.deepEqual(writer.written, [decision.decision_id]);
  const rows = readJsonl(pipeline.paths.details);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, body);
  assert.equal(rows[0].type, "details");
  assert.equal(rows[0].candidate_id, candidate.candidate_id);
  assert.equal(rows[0].decision_id, decision.decision_id);
  assert.match(rows[0].detail_id, /^detail-[0-9a-f]{16}$/u);
  // 账本不是 Episode / Self-note / Re-entry：一条都不许漏进那三个正史文件。
  assert.equal(fs.existsSync(pipeline.paths.episodes), false);
  assert.equal(fs.existsSync(pipeline.paths.selfNotes), false);
  assert.equal(fs.existsSync(pipeline.paths.reentry), false);

  // 读取只走既有受控工具通路（Phase 5A memory_lookup），且预算与截断沿用旧规则。
  const lookup = new MemoryLookupService({ continuityDir: fixture.continuityDir });
  const hit = lookup.lookup(
    { query: "复查", trigger: "user_pull", reason: "她问上次说的复查是哪天" },
    { provider: "telegram", accountId: "acct", threadId: "thread-details" },
  );
  assert.equal(hit.hits.length, 1);
  assert.equal(hit.hits[0].ep_id, rows[0].detail_id);
  assert.match(hit.hits[0].body, /2026-08-03/u);

  // 幂等：重复运行不追加第二行，也不重复登记。
  const before = fs.readFileSync(pipeline.paths.details, "utf8");
  assert.equal(pipeline.runHistoryWriter().written.length, 0);
  assert.equal(fs.readFileSync(pipeline.paths.details, "utf8"), before);
  assert.equal(readDetailsForLookup(pipeline.paths.details).length, 1);
});

test("details candidates without subject authority never reach the ledger", () => {
  const fixture = createFixture();
  const pipeline = fixture.pipeline;
  const candidate = createCandidate({
    date: "2026-07-11",
    type: "details",
    author: "janitor",
    body: "提取器搬来的待办，不许自己进抽屉。",
    sourceRef: { file: fixture.conversationFile, window: "1-2" },
    origin: "janitor_legacy",
    authorRole: "extractor",
    authorModel: "legacy-extractor",
    contextScope: "isolated_chunk",
    semanticAuthority: "none",
  });
  appendJsonlUnique(pipeline.paths.candidates, [candidate], "candidate_id");
  const review = pipeline.runReview({ env: { ...process.env, CYBERBOSS_AUTO_REVIEW_MODEL: "off" } });
  assert.equal(review.decisions[0].result, "deferred");
  assert.equal(review.decisions[0].reason, "semantic_authority_missing");
  pipeline.runHistoryWriter();
  assert.equal(fs.existsSync(pipeline.paths.details), false);
});

test("janitor runs through the leased wrapper and writes evidence only", () => {
  const fixture = createFixture();
  const result = fixture.pipeline.runJanitor({ env: { ...process.env, JANITOR_MOCK: "1" } });
  assert.equal(result.status, "success");

  const gaps = readJsonl(path.join(fixture.continuityDir, "gaps", "gaps.jsonl"));
  const evidence = readJsonl(path.join(fixture.continuityDir, "evidence", "janitor.evidence.jsonl"));
  assert.equal(gaps.length, 1);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].origin, "janitor");
  assert.equal(evidence[0].author_role, "extractor");
  assert.equal(evidence[0].semantic_authority, "none");
  assert.equal(evidence[0].gap_id, gaps[0].gap_id);
  assert.equal(fs.existsSync(fixture.pipeline.paths.candidates), false);

  const review = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } });
  assert.equal(review.decisions.length, 0);
  assert.equal(fs.existsSync(fixture.pipeline.paths.episodes), false);
  assert.equal(fs.existsSync(fixture.writerLeaseFile), false);
});

test("consumer filter removes injected blocks, tool results, attachments, and old episode echoes", () => {
  const cleaned = stripConversationArtifacts(pollutedText());
  assert.match(cleaned, /此刻真实原话/);
  assert.doesNotMatch(cleaned, /注入回声|打回信封正文|工具结果|secret\.png|旧 Episode 正文/);
});

test("dashboard freezes every legacy write endpoint before Phase 3 data writes", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/dashboard.py"), "utf8");
  for (const endpoint of ["/api/save", "/api/state_log", "/api/episode_candidate", "/api/janitor/run", "/api/care/config", "/api/care/cycle", "/api/config"]) {
    assert.match(source, new RegExp(`FROZEN_WRITE_ENDPOINTS[\\s\\S]*?${endpoint.replaceAll("/", "\\/")}`));
  }
  assert.match(source, /if u\.path in FROZEN_WRITE_ENDPOINTS:[\s\S]*?self\._send\(403/);
});

test("subject-AI authoring uses the configured runtime in an isolated background turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase3-author-"));
  const promptFile = path.join(root, "persona.md");
  fs.writeFileSync(promptFile, "同一 persona source", "utf8");
  let captured = null;
  const result = await authorCloseout({
    runtimeAdapter: {
      async runBackgroundTurn(payload) {
        captured = payload;
        return JSON.stringify({ episodes: [{ body: "主体 AI 原稿" }], self_note: "我的选择", reentry_draft: "短交接" });
      },
    },
    config: { workspaceRoot: root, runtime: "claudecode", claudeModel: "fixture", weixinInstructionsFile: promptFile, reentryAuthoringMode: "ai_direct" },
    materials: "过滤后的事实材料",
  });
  assert.match(captured.text, /同一 persona source/);
  assert.match(captured.text, /过滤后的事实材料/);
  assert.match(captured.text, /use 我\/她\/我们, never 用户\/AI\/assistant/);
  assert.match(captured.text, /room for the future self to reinterpret/);
  assert.equal(captured.workspaceRoot, root);
  assert.equal(result.reentry_draft, "短交接");
});

test("claudecode background author uses an isolated client and closes it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase3-claude-bg-"));
  const indexPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/index.js");
  const processPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/process-client.js");
  const settingsPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/project-settings.js");
  const ipcPath = path.resolve(__dirname, "../src/adapters/runtime/claudecode/ipc-server.js");
  const originals = new Map([indexPath, processPath, settingsPath, ipcPath].map((item) => [item, require.cache[item]]));
  const clients = [];
  class MockClient {
    constructor(options) { this.options = options; this.listeners = new Set(); this.closed = false; clients.push(this); }
    onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async connect() {}
    async sendUserMessage({ text }) {
      assert.equal(text, "background prompt");
      queueMicrotask(() => { for (const listener of this.listeners) listener({ type: "turn.completed", text: "background result" }); });
    }
    async close() { this.closed = true; }
  }
  class MockIpc { on() {} async start() {} async close() {} }
  delete require.cache[indexPath];
  require.cache[processPath] = { id: processPath, filename: processPath, loaded: true, exports: { ClaudeCodeProcessClient: MockClient } };
  require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true, exports: { ensureClaudeProjectMcpConfig: () => ({ configPath: path.join(root, ".mcp.json"), serverName: "fixture" }) } };
  require.cache[ipcPath] = { id: ipcPath, filename: ipcPath, loaded: true, exports: { ClaudeCodeIpcServer: MockIpc } };
  try {
    const { createClaudeCodeRuntimeAdapter } = require(indexPath);
    const adapter = createClaudeCodeRuntimeAdapter({ stateDir: root, sessionsFile: path.join(root, "sessions.json"), claudeCommand: "fixture" });
    const result = await adapter.runBackgroundTurn({ workspaceRoot: root, text: "background prompt" });
    assert.equal(result, "background result");
    assert.equal(clients.length, 1);
    assert.equal(clients[0].closed, true);
    assert.equal(clients[0].options.ipcServer, null);
  } finally {
    delete require.cache[indexPath];
    for (const [key, value] of originals.entries()) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  }
});

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase3-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const conversationFile = path.join(conversationDir, "2026-07-11.jsonl");
  const writerLeaseFile = path.join(root, "MEMORY_WRITER_LEASE.json");
  const transcriptDir = path.join(root, "transcripts");
  const stateLog = path.join(root, "state_log.jsonl");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(conversationFile, [
    JSON.stringify({
      id: "entry-fixture-user",
      type: "user",
      timestamp: "2026-07-11T12:00:00Z",
      route: exactRecorderRoute(),
      routeStatus: "RECORDED_EXACT",
      text: pollutedText(),
    }),
    JSON.stringify({
      id: "entry-fixture-reply",
      type: "runtime.reply.completed",
      timestamp: "2026-07-11T12:01:00Z",
      route: exactRecorderRoute(),
      routeStatus: "RECORDED_EXACT",
      text: "我先听见此刻。",
    }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(stateLog, '{"frozen":true}\n', "utf8");
  fs.writeFileSync(path.join(transcriptDir, "session.jsonl"), [
    JSON.stringify({ type: "user", timestamp: "2026-07-11T12:00:00Z", message: { content: "断档原话" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-11T12:01:00Z", message: { content: "我在。" } }),
  ].join("\n") + "\n", "utf8");
  const pipeline = new ContinuityPipeline({
    continuityDir,
    conversationDir,
    writerLeaseFile,
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    janitorScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/janitor.py"),
    transcriptDir,
    python: process.env.PYTHON || "python",
    model: "fixture-model",
    branch: "fixture-branch",
    worktree: root,
    baseSha: "a".repeat(40),
    isProcessAlive: options.isProcessAlive,
    reviewArtifactsEnabled: true,
  });
  return { root, continuityDir, conversationDir, conversationFile, writerLeaseFile, stateLog, stateLogHash: hashFile(stateLog), pipeline };
}

function exactRecorderRoute() {
  return {
    bindingKey: "workspace-fixture:telegram:42",
    laneKey: "v2|tg|8:telegram|4:-100|1:7",
    sessionSlotKey: "slot-fixture",
    messageThreadId: "7",
    profileId: "profile-fixture",
    windowId: "native-session-fixture",
  };
}

function pollutedText() {
  return `TELEGRAM SESSION INSTRUCTIONS
persona

<<<CB_CTX:REENTRY v1 hash=x chars=4>>>
注入回声
<<<END_CB_CTX>>>

Current user message:
此刻真实原话

<subject_memory_handoff handoff_id="handoff-fixture">
打回信封正文
</subject_memory_handoff>

Tool result:
工具结果

Saved attachments:
- secret.png

Old Episode echo:
- 旧 Episode 正文`;
}

function snapshotBytes(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const entry of walk(root)) out[path.relative(root, entry).replace(/\\/g, "/")] = fs.readFileSync(entry).toString("base64");
  return out;
}

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }).sort();
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
