"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildOpeningTurnText } = require("../src/adapters/runtime/shared-instructions");
const { sha256 } = require("../src/continuity/continuity-store");
const {
  LEGACY_ID_PREFIX,
  LEGACY_SOURCE,
  LEGACY_SOURCE_NOTICE,
} = require("../src/continuity/legacy-candidate-lookup");
const { createSubjectRoute } = require("../src/continuity/subject-route");
const { CyberbossApp } = require("../src/core/app");
const { prepareOpeningContext } = require("../src/core/hard-context");
const { MemoryLookupService } = require("../src/services/memory-lookup-service");
const { ProjectToolHost } = require("../src/tools/tool-host");

const QUERY = "FAKE-LEGACY-ANCHOR";
const ROUTE_TOKEN = "fixture-session-slot";
const LANE_KEY = "fixture-route-lane";

test("D28 exposes only route-matched EXACTLY_RECOVERABLE rows with an explicit non-handwriting marker", (t) => {
  const fixture = legacyFixture(t);
  const sourceBytes = snapshotSources(fixture);
  const result = fixture.service.lookup(lookupArgs(), lookupContext());

  assert.equal(result.error, undefined);
  const legacyHits = result.hits.filter((hit) => hit.ep_id.startsWith(LEGACY_ID_PREFIX));
  assert.deepEqual(legacyHits.map((hit) => hit.ep_id), [`${LEGACY_ID_PREFIX}cand-fake-matching`]);
  assert.equal(legacyHits[0].source, LEGACY_SOURCE);
  assert.equal(legacyHits[0].source_notice, LEGACY_SOURCE_NOTICE);
  assert.equal(LEGACY_SOURCE_NOTICE, "旧后台存量、非你的笔迹");
  assert.match(legacyHits[0].body, /MATCHING/u);
  assert.doesNotMatch(JSON.stringify(result.hits), /OTHER-ROUTE|DEFERRED/u);
  assert.deepEqual(snapshotSources(fixture), sourceBytes, "lookup must not write either sealed source");
});

test("D28 route mismatch yields no legacy hit and missing route identity preserves ordinary sources", (t) => {
  const other = legacyFixture(t);
  const wrongRoute = other.service.lookup(lookupArgs(), lookupContext({
    threadId: "thread-other-route",
    routeToken: "unbound-session-slot",
    laneKey: "unbound-route-lane",
  }));
  assert.equal(wrongRoute.error, undefined);
  assert.equal(wrongRoute.hits.some((hit) => hit.ep_id.startsWith(LEGACY_ID_PREFIX)), false);

  const missing = legacyFixture(t);
  const noRoute = missing.service.lookup(lookupArgs(), {
    provider: "telegram",
    accountId: "fixture-account",
    threadId: "thread-no-route",
  });
  assert.equal(noRoute.error, undefined);
  assert.deepEqual(noRoute.hits.map((hit) => hit.ep_id), ["ep-fake-ordinary"]);
  assert.match(noRoute.hits[0].body, /ORDINARY/u);
});

test("D28 missing, empty, and damaged companion data fail open without blocking episodes", (t) => {
  for (const [name, companion] of [["missing", null], ["empty", ""], ["damaged", "{ damaged jsonl\n"]]) {
    const fixture = legacyFixture(t, { companion });
    const result = fixture.service.lookup(lookupArgs(), lookupContext({ threadId: `thread-${name}` }));
    assert.equal(result.error, undefined, name);
    assert.deepEqual(result.hits.map((hit) => hit.ep_id), ["ep-fake-ordinary"], name);
  }

  const mixed = legacyFixture(t, { damagedPrefix: true });
  const result = mixed.service.lookup(lookupArgs(), lookupContext({ threadId: "thread-mixed-jsonl" }));
  assert.equal(result.error, undefined);
  assert.equal(result.hits.some((hit) => hit.ep_id === `${LEGACY_ID_PREFIX}cand-fake-matching`), true);
});

test("D28 legacy text stays out of Re-entry, Current State, and memory_context assembly", async (t) => {
  const fixture = legacyFixture(t);
  const reentryFile = path.join(fixture.root, "reentry.md");
  const currentStateFile = path.join(fixture.root, "desire-state.json");
  fs.writeFileSync(reentryFile, "FAKE REENTRY ONLY", "utf8");
  fs.writeFileSync(currentStateFile, JSON.stringify({ intent: { drive_key: "FAKE_STATE_ONLY" } }), "utf8");

  const opening = prepareOpeningContext({
    config: { reentryFile, continuityDir: fixture.root, desireStateFile: currentStateFile },
    sessionStore: { getReentryInjection: () => null },
    threadId: "thread-injection-boundary",
  });
  const openingText = buildOpeningTurnText({ channel: "telegram" }, "FAKE USER MESSAGE", opening);
  assert.match(openingText, /FAKE REENTRY ONLY/u);
  assert.match(openingText, /FAKE_STATE_ONLY/u);
  assert.doesNotMatch(openingText, new RegExp(QUERY, "u"));

  const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
    config: { continuityDir: fixture.root, legacyMemoryRetrieval: false },
    projectServices: {},
  }, { prepared: { provider: "telegram", originalText: "FAKE USER MESSAGE" } });
  assert.doesNotMatch(runtimeTurn.text, new RegExp(QUERY, "u"));
  assert.equal(runtimeTurn.text.includes("<memory_context>"), false);
});

test("tool context carries both existing route identity fields without changing memory_lookup args", () => {
  const host = new ProjectToolHost({
    runtimeContextStore: {
      load() {},
      resolveActiveContext: () => ({
        provider: "telegram", accountId: "fixture-account", threadId: "fixture-thread",
        routeToken: ROUTE_TOKEN, laneKey: LANE_KEY,
      }),
    },
  });
  const resolved = host.resolveContext({});
  assert.equal(resolved.routeToken, ROUTE_TOKEN);
  assert.equal(resolved.laneKey, LANE_KEY);

  const lookup = host.listTools().find((tool) => tool.name === "memory_lookup");
  assert.deepEqual(lookup.inputSchema.required, ["query", "trigger", "reason"]);
  assert.deepEqual(lookup.inputSchema.properties.trigger.enum, ["user_pull"]);
});

function legacyFixture(t, { companion = undefined, damagedPrefix = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-d28-lookup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidatesDir = path.join(root, "candidates");
  const episodesFile = path.join(root, "episodes.jsonl");
  const candidatesFile = path.join(candidatesDir, "episodes.candidates.jsonl");
  const bindingsFile = path.join(candidatesDir, "legacy-candidate-route-bindings.jsonl");
  fs.mkdirSync(candidatesDir, { recursive: true });
  writeJsonl(episodesFile, [{ ep_id: "ep-fake-ordinary", body: `${QUERY} ORDINARY` }]);
  writeJsonl(candidatesFile, [
    { candidate_id: "cand-fake-matching", body: `${QUERY} MATCHING` },
    { candidate_id: "cand-fake-other", body: `${QUERY} OTHER-ROUTE` },
    { candidate_id: "cand-fake-deferred", body: `${QUERY} DEFERRED` },
  ]);

  const defaultBindings = [
    binding("cand-fake-matching", ROUTE_TOKEN, LANE_KEY, "EXACTLY_RECOVERABLE"),
    binding("cand-fake-other", "another-session-slot", "another-route-lane", "EXACTLY_RECOVERABLE"),
    binding("cand-fake-deferred", ROUTE_TOKEN, LANE_KEY, "LEGACY_DEFERRED"),
  ];
  if (companion !== null) {
    const body = companion === undefined
      ? `${damagedPrefix ? "{ damaged jsonl\n" : ""}${defaultBindings.map(JSON.stringify).join("\n")}\n`
      : companion;
    fs.writeFileSync(bindingsFile, body, "utf8");
  }
  return { root, episodesFile, candidatesFile, bindingsFile, service: new MemoryLookupService({ continuityDir: root }) };
}

function binding(candidateId, routeToken, laneKey, classification) {
  return {
    candidate_id: candidateId,
    classification,
    subject_route: createSubjectRoute({
      version: 1,
      provider: "telegram",
      continuity_binding: {
        workspace_id: "workspace-fake", account_id: "account-fake",
        sender_id: "sender-fake", binding_key: "binding-fake",
      },
      route_lane: {
        lane_key: `lane-${sha256(laneKey)}`,
        chat_id: "chat-fake",
        message_thread_id: "topic-fake",
      },
      session: {
        runtime_id: "claudecode",
        session_slot_key: `slot-${sha256(routeToken)}`,
        runtime_thread_id: "thread-fake",
        profile_id: "profile-fake",
        profile_fingerprint: "profile-fingerprint-fake",
        window_id: "window-fake",
      },
      author_turn_id: "turn-fake",
      source_entry_ids: ["entry-fake"],
    }),
  };
}

function lookupArgs() {
  return { query: QUERY, trigger: "user_pull", reason: "explicit fixture lookup" };
}

function lookupContext(overrides = {}) {
  return {
    provider: "telegram",
    accountId: "fixture-account",
    threadId: "fixture-thread",
    routeToken: ROUTE_TOKEN,
    laneKey: LANE_KEY,
    ...overrides,
  };
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
}

function snapshotSources(fixture) {
  return {
    canon: fs.readFileSync(fixture.episodesFile),
    candidates: fs.readFileSync(fixture.candidatesFile),
    bindings: fs.readFileSync(fixture.bindingsFile),
  };
}
