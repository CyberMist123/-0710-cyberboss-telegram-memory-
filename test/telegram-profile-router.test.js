"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ProfileRoutingError,
  createTelegramProfileRouter,
} = require("../src/adapters/runtime/claudecode/telegram-profile-router");
const { buildTelegramRouteLane } = require("../src/core/route-lane");

const BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cb-router-"));

function router(profiles, mappings) {
  return createTelegramProfileRouter({
    profilesJson: profiles === undefined ? "" : JSON.stringify(profiles),
    mappingJson: mappings === undefined ? "" : JSON.stringify(mappings),
    baseDir: BASE_DIR,
  });
}

function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ProfileRoutingError, `expected ProfileRoutingError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

const lane = (chatId, messageThreadId = null, accountId = "telegram") =>
  buildTelegramRouteLane({ accountId, chatId, messageThreadId });

test("no configuration at all keeps every lane on the legacy path", () => {
  const r = createTelegramProfileRouter({});
  assert.deepEqual({ ...r.describe() }, { enabled: false, profileCount: 0, mappingCount: 0 });
  const selection = r.select(lane(1));
  assert.equal(selection.status, "unmapped");
  assert.equal(selection.launchProfile, null);
  assert.equal(selection.profileFingerprint, "legacy");
});

test("profiles declared with an empty mapping array stay disabled", () => {
  const r = router({ safe: { effort: "low" } }, []);
  assert.equal(r.isEnabled(), false);
  assert.equal(r.select(lane(1)).status, "unmapped");
});

test("a mapped route resolves to its validated profile, an unmapped one does not", () => {
  const r = router(
    { safe: { effort: "low", strictMcpConfig: true }, wide: { effort: "high" } },
    [
      { accountId: "telegram", chatId: 100, messageThreadId: null, profileId: "safe" },
      { accountId: "telegram", chatId: 100, messageThreadId: 7, profileId: "wide" },
    ],
  );
  assert.deepEqual({ ...r.describe() }, { enabled: true, profileCount: 2, mappingCount: 2 });

  const defaultLane = r.select(lane(100, null));
  const topicLane = r.select(lane(100, 7));
  const otherTopic = r.select(lane(100, 8));

  assert.equal(defaultLane.profileId, "safe");
  assert.equal(topicLane.profileId, "wide");
  assert.equal(otherTopic.status, "unmapped");
  assert.notEqual(defaultLane.profileFingerprint, topicLane.profileFingerprint);
  assert.equal(defaultLane.launchProfile.effort, "low");
});

test("a route naming an unknown profile blocks startup instead of falling back", () => {
  rejects(() => router({ safe: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "missing" },
  ]), "unknown_profile");
});

test("a route naming an invalid profile blocks startup instead of falling back", () => {
  // The v1 selector skipped invalid profiles and let the route fall through to
  // the legacy (more permissive) launch. That must not happen.
  rejects(() => router({ safe: { effort: "ultra" } }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "safe" },
  ]), "invalid_enum");
});

test("duplicate routes are rejected", () => {
  rejects(() => router({ a: {}, b: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "a" },
    { accountId: "telegram", chatId: "1", messageThreadId: null, profileId: "b" },
  ]), "duplicate_route");

  rejects(() => router({ a: {}, b: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: 4, profileId: "a" },
    { accountId: "telegram", chatId: 1, messageThreadId: "4", profileId: "b" },
  ]), "duplicate_route");
});

test("the default lane and a topic lane are not duplicates of each other", () => {
  const r = router({ a: {}, b: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "a" },
    { accountId: "telegram", chatId: 1, messageThreadId: 4, profileId: "b" },
  ]);
  assert.equal(r.describe().mappingCount, 2);
});

test("profile ids colliding after trim or case folding are rejected", () => {
  rejects(() => router({ safe: {}, " safe ": {} }), "profile_id_collision");
  rejects(() => router({ safe: {}, Safe: {} }), "profile_id_collision");
});

test("a profile whose declared profileId contradicts its key is rejected", () => {
  rejects(() => router({ safe: { profileId: "other" } }), "profile_id_mismatch");
});

test("unknown fields are rejected in both profiles and mappings", () => {
  rejects(() => router({ safe: { nope: 1 } }), "unknown_field");
  rejects(() => router({ safe: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "safe", extra: 1 },
  ]), "unknown_field");
});

test("messageThreadId must be stated explicitly in a mapping", () => {
  rejects(() => router({ safe: {} }, [
    { accountId: "telegram", chatId: 1, profileId: "safe" },
  ]), "missing_field");
});

test("non-canonical Telegram ids are rejected in mappings", () => {
  const cases = [
    { chatId: 1.5, messageThreadId: null },
    { chatId: "1e3", messageThreadId: null },
    { chatId: "0123", messageThreadId: null },
    { chatId: "+1", messageThreadId: null },
    { chatId: "chat-one", messageThreadId: null },
    { chatId: "", messageThreadId: null },
    { chatId: 1, messageThreadId: "" },
    { chatId: 1, messageThreadId: 0 },
    { chatId: 1, messageThreadId: -2 },
    { chatId: 1, messageThreadId: 2.5 },
    { chatId: 1, messageThreadId: "topic" },
    { chatId: Number.MAX_SAFE_INTEGER + 2, messageThreadId: null },
  ];
  for (const override of cases) {
    assert.throws(
      () => router({ safe: {} }, [{ accountId: "telegram", profileId: "safe", ...override }]),
      ProfileRoutingError,
      `expected rejection for ${JSON.stringify(override)}`,
    );
  }
});

test("prototype pollution is rejected in profiles and in mappings", () => {
  for (const raw of [
    '{"__proto__":{"polluted":true}}',
    '{"safe":{"__proto__":{"polluted":true}}}',
    '{"constructor":{}}',
    '{"prototype":{}}',
  ]) {
    rejects(
      () => createTelegramProfileRouter({ profilesJson: raw, baseDir: BASE_DIR }),
      "forbidden_key",
    );
  }
  rejects(
    () => createTelegramProfileRouter({
      profilesJson: '{"safe":{}}',
      mappingJson: '[{"__proto__":{"x":1},"accountId":"t","chatId":"1","messageThreadId":null,"profileId":"safe"}]',
      baseDir: BASE_DIR,
    }),
    "forbidden_key",
  );
  assert.equal({}.polluted, undefined);
});

test("size, count and depth budgets block oversized configuration", () => {
  const hugeProfiles = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { effort: "low" }])),
  );
  rejects(
    () => createTelegramProfileRouter({ profilesJson: hugeProfiles, baseDir: BASE_DIR }),
    "too_many_profiles",
  );

  // Wider than the JSON key budget: rejected before profile validation runs.
  rejects(
    () => createTelegramProfileRouter({
      profilesJson: JSON.stringify(
        Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, {}])),
      ),
      baseDir: BASE_DIR,
    }),
    "too_many_keys",
  );

  rejects(
    () => createTelegramProfileRouter({
      profilesJson: JSON.stringify({ safe: { systemPrompt: "x".repeat(100_000) } }),
      baseDir: BASE_DIR,
    }),
    "too_large",
  );

  const manyRoutes = JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({
      accountId: "t", chatId: String(i + 1), messageThreadId: null, profileId: "safe",
    })),
  );
  rejects(
    () => createTelegramProfileRouter({
      profilesJson: '{"safe":{}}', mappingJson: manyRoutes, baseDir: BASE_DIR,
    }),
    "array_too_long",
  );

  rejects(
    () => createTelegramProfileRouter({
      profilesJson: '{"safe":{}}',
      mappingJson: '[{"accountId":"t","chatId":{"nested":{"deep":1}},"messageThreadId":null,"profileId":"safe"}]',
      baseDir: BASE_DIR,
    }),
    "too_deep",
  );
});

test("malformed JSON blocks startup", () => {
  rejects(() => createTelegramProfileRouter({ profilesJson: "{", baseDir: BASE_DIR }), "invalid_json");
  rejects(
    () => createTelegramProfileRouter({ profilesJson: '{"safe":{}}', mappingJson: "[", baseDir: BASE_DIR }),
    "invalid_json",
  );
});

test("the wrong top-level shape blocks startup", () => {
  rejects(() => createTelegramProfileRouter({ profilesJson: "[]", baseDir: BASE_DIR }), "invalid_shape");
  rejects(
    () => createTelegramProfileRouter({ profilesJson: '{"safe":{}}', mappingJson: "{}", baseDir: BASE_DIR }),
    "invalid_shape",
  );
});

test("a lane with no key never matches", () => {
  const r = router({ safe: {} }, [
    { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "safe" },
  ]);
  assert.equal(r.select(null).status, "unmapped");
  assert.equal(r.select({}).status, "unmapped");
  assert.equal(r.select("").status, "unmapped");
});
