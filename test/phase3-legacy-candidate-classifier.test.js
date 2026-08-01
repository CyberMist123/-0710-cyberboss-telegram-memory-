"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { canPublishCandidate } = require("../src/continuity/candidate-authority");
const { HandoffDispatcher } = require("../src/continuity/handoff-dispatcher");
const { readJsonl, sha256 } = require("../src/continuity/continuity-store");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { readConfig } = require("../src/core/config");
const { runMigration } = require("../scripts/continuity/classify-legacy-candidates");

const CLI = path.join(__dirname, "..", "scripts", "continuity", "classify-legacy-candidates.js");
const CANARY = "planted-nondisclosure-canary-0000";
const FIXED_TIME = "2026-08-01T00:00:00.000Z";

test("apply writes only the companion and leaves authority plus every existing jsonl byte unchanged", () => {
  const fixture = makeFixture();
  const protectedBefore = snapshotFiles(fixture.protectedFiles);
  const candidateBytes = fs.readFileSync(fixture.candidatesFile);
  const legacyNegative = readJsonl(fixture.candidatesFile)[0];
  const positive = { ...legacyNegative, author_role: "subject_ai", semantic_authority: "high", needs_subject_review: false };
  const authorityBefore = [canPublishCandidate(legacyNegative), canPublishCandidate(positive)];

  const result = apply(fixture);
  assert.equal(result.added, 2);
  assert.deepEqual(snapshotFiles(fixture.protectedFiles), protectedBefore);
  assert.deepEqual(fs.readFileSync(fixture.candidatesFile), candidateBytes);
  assert.deepEqual([canPublishCandidate(legacyNegative), canPublishCandidate(positive)], authorityBefore);
  assert.deepEqual(authorityBefore, [false, true]);

  const rows = readJsonl(fixture.targetFile);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.writer === "legacy-candidate-migration"));
  assert.ok(rows.every((row) => row.legacy_background_proposal === true));
  assert.ok(rows.every((row) => row.subject_route && !row.reason_code));
});

test("apply is idempotent by candidate_id", () => {
  const fixture = makeFixture();
  const first = apply(fixture);
  const bytes = fs.readFileSync(fixture.targetFile);
  const second = apply(fixture);
  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
  assert.deepEqual(fs.readFileSync(fixture.targetFile), bytes);
  assert.equal(new Set(readJsonl(fixture.targetFile).map((row) => row.candidate_id)).size, 2);
});

test("a mid-run append failure preserves completed rows and rerun converges to one-shot output", () => {
  const interrupted = makeFixture();
  const pristineCandidate = fs.readFileSync(interrupted.candidatesFile);
  let calls = 0;
  assert.throws(() => apply(interrupted, {
    appendLine(file, line) {
      calls += 1;
      if (calls === 2) throw new Error("injected append failure");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, "utf8");
    },
  }), /injected append failure/u);
  assert.equal(readJsonl(interrupted.targetFile).length, 1);
  assert.deepEqual(fs.readFileSync(interrupted.candidatesFile), pristineCandidate);

  const resumed = apply(interrupted);
  assert.equal(resumed.added, 1);
  const oneShot = makeFixture();
  apply(oneShot);
  assert.deepEqual(readJsonl(interrupted.targetFile), readJsonl(oneShot.targetFile));
});

test("deferred is terminal and companion rows are invisible to dispatcher/context paths while the gate is off", () => {
  const fixture = makeFixture();
  const dispatcher = new HandoffDispatcher({ continuityDir: fixture.continuityDir, enabled: true });
  const identity = currentIdentity();
  const before = JSON.stringify(dispatcher.beginSubjectTurn({ currentRoute: identity }));
  const queueBefore = directoryDigest(fixture.continuityDir);
  const result = apply(fixture);
  const deferred = result.results.filter((row) => row.classification === "LEGACY_DEFERRED");
  assert.equal(deferred.length, 1);
  assert.equal(readJsonl(fixture.targetFile).some((row) => row.candidate_id === deferred[0].candidate_id), false);
  assert.equal(JSON.stringify(dispatcher.beginSubjectTurn({ currentRoute: identity })), before);
  assert.equal(fs.existsSync(path.join(fixture.continuityDir, "handoffs", "envelopes.jsonl")), true);
  assert.equal(fs.readFileSync(path.join(fixture.continuityDir, "handoffs", "envelopes.jsonl"), "utf8"), "");
  assert.notEqual(directoryDigest(fixture.continuityDir), queueBefore, "only the companion changes the directory digest");

  const previous = process.env.CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED;
  delete process.env.CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED;
  try { assert.equal(readConfig().legacyCandidateBindingEnabled, false); } finally {
    if (previous === undefined) delete process.env.CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED;
    else process.env.CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED = previous;
  }
});

test("CLI defaults to read-only and stdout contains no absolute path, raw profile, or secret-shaped canary", () => {
  const fixture = makeFixture();
  const before = snapshotTree(fixture.continuityDir);
  const run = spawnSync(process.execPath, [
    CLI,
    "--continuity-dir", fixture.continuityDir,
    "--conversation-dir", fixture.conversationDir,
  ], { encoding: "utf8", env: { ...process.env, CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED: "false" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(snapshotTree(fixture.continuityDir), before);
  assert.equal(fs.existsSync(fixture.targetFile), false);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, "dry_run");
  assert.equal(report.added, 0);
  assert.doesNotMatch(run.stdout, new RegExp(escapeRegex(fixture.root), "iu"));
  assert.doesNotMatch(run.stdout, /raw-profile-id/iu);
  assert.doesNotMatch(run.stdout, new RegExp(CANARY, "u"));
});

function apply(fixture, overrides = {}) {
  return runMigration({
    apply: true,
    candidatesFile: fixture.candidatesFile,
    conversationDirs: [fixture.conversationDir],
    targetFile: fixture.targetFile,
    now: () => new Date(FIXED_TIME),
    ...overrides,
  });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-g2-7-"));
  const continuityDir = path.join(root, "continuity");
  const conversationDir = path.join(root, "conversations");
  const candidatesFile = path.join(continuityDir, "candidates", "episodes.candidates.jsonl");
  const targetFile = path.join(continuityDir, "candidates", "legacy-candidate-route-bindings.jsonl");
  fs.mkdirSync(path.dirname(candidatesFile), { recursive: true });
  fs.mkdirSync(conversationDir, { recursive: true });

  const conversationFile = path.join(conversationDir, "2026-08-01.jsonl");
  const entries = [entry("entry-1", "one"), entry("entry-2", "two"), entry("entry-3", "three")];
  const lines = entries.map(JSON.stringify);
  fs.writeFileSync(conversationFile, `${lines.join("\n")}\n`, "utf8");
  const candidates = [
    candidate("cand-legacy-1", conversationFile, [0], lines),
    candidate("cand-legacy-2", conversationFile, [1, 2], lines),
    { candidate_id: "cand-deferred", type: "episode", author: "closeout", body: "deferred", source_ref: { file: path.join(root, "outside.jsonl") } },
  ];
  fs.writeFileSync(candidatesFile, `${candidates.map(JSON.stringify).join("\n")}\n`, "utf8");

  const protectedFiles = [
    path.join(continuityDir, "episodes.jsonl"),
    path.join(continuityDir, "decisions", "decisions.jsonl"),
    path.join(continuityDir, "decisions", "publication-intents.jsonl"),
    path.join(continuityDir, "handoffs", "envelopes.jsonl"),
    path.join(continuityDir, ".jobs", "handoff-delivery-events.jsonl"),
  ];
  for (const file of protectedFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
  }
  return { root, continuityDir, conversationDir, candidatesFile, targetFile, protectedFiles };
}

function candidate(id, file, indexes, lines) {
  const ids = indexes.map((index) => `entry-${index + 1}`);
  return {
    candidate_id: id,
    type: "episode",
    author: "closeout",
    body: `${CANARY}-${id}`,
    source_ref: {
      file,
      window: `${indexes[0] + 1}-${indexes[indexes.length - 1] + 1}`,
      source_entry_ids: ids,
      source_entry_hashes: indexes.map((index) => ({ entry_id: `entry-${index + 1}`, sha256: sha256(lines[index]) })),
      content_sha256: sha256(indexes.map((index) => lines[index]).join("\n")),
    },
  };
}

function entry(id, text) {
  return { id, type: "user", text, meta: { subject_route: createSubjectRoute(route()) } };
}

function route() {
  return {
    version: 1,
    provider: "telegram",
    continuity_binding: { workspace_id: "workspace-raw", account_id: "account-raw", sender_id: "sender-raw", binding_key: "binding-opaque" },
    route_lane: { lane_key: "lane-opaque", chat_id: "chat-raw", message_thread_id: "topic-raw" },
    session: {
      runtime_id: "claudecode", session_slot_key: "slot-opaque", runtime_thread_id: "thread-raw",
      profile_id: `raw-profile-id-${CANARY}`, profile_fingerprint: "profile-fingerprint-opaque", window_id: "window-raw",
    },
    author_turn_id: "turn-raw",
    source_entry_ids: ["evidence-placeholder"],
  };
}

function currentIdentity() {
  const value = createSubjectRoute(route());
  return { provider: value.provider, continuity_binding: value.continuity_binding, route_lane: value.route_lane, session: value.session };
}

function snapshotFiles(files) {
  return Object.fromEntries(files.map((file) => [file, { hash: hashFile(file), mtimeMs: fs.statSync(file).mtimeMs }]));
}

function snapshotTree(root) {
  const output = {};
  walk(root, (file) => { output[path.relative(root, file)] = hashFile(file); });
  return output;
}

function directoryDigest(root) { return sha256(JSON.stringify(snapshotTree(root))); }
function hashFile(file) { return sha256(fs.readFileSync(file)); }
function walk(dir, visit) {
  for (const name of fs.readdirSync(dir).sort()) {
    const target = path.join(dir, name);
    if (fs.statSync(target).isDirectory()) walk(target, visit); else visit(target);
  }
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
