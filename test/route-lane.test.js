"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RouteLaneError,
  buildLaneScopeKey,
  buildLegacyRouteLane,
  buildSystemRouteLane,
  buildTelegramRouteLane,
  canonicalTelegramChatId,
  canonicalTelegramMessageThreadId,
  describeLaneShape,
  isSameLane,
  normalizeInboundMessageThreadId,
  resolveInboundRouteLane,
} = require("../src/core/route-lane");

function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RouteLaneError, `expected RouteLaneError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("canonical chat ids accept only safe integers and strict decimal strings", () => {
  assert.equal(canonicalTelegramChatId(123), "123");
  assert.equal(canonicalTelegramChatId("123"), "123");
  assert.equal(canonicalTelegramChatId(-1001234567890), "-1001234567890");
  assert.equal(canonicalTelegramChatId("-1001234567890"), "-1001234567890");
  assert.equal(canonicalTelegramChatId("0"), "0");
});

test("canonical chat ids reject every non-canonical form", () => {
  for (const value of [
    1.5, "1.5", "1e3", "1E3", "0x7b", "+123", "0123", "-0", -0, " 123", "123 ", "12 3",
    "", "abc", "١٢٣", NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2,
    true, null, undefined, {}, [], 123n,
  ]) {
    assert.throws(
      () => canonicalTelegramChatId(value),
      RouteLaneError,
      `expected rejection for ${String(value)}`,
    );
  }
});

test("message thread ids are positive integers or the explicit null lane", () => {
  assert.equal(canonicalTelegramMessageThreadId(null), null);
  assert.equal(canonicalTelegramMessageThreadId(7), "7");
  assert.equal(canonicalTelegramMessageThreadId("7"), "7");

  for (const value of [0, "0", -3, "-3", 1.5, "1.5", "1e3", "+7", "07", "", " 7", undefined, {}, true]) {
    rejects(() => canonicalTelegramMessageThreadId(value), "non_canonical_id");
  }
});

test("a missing topic is the default lane but an empty string never is", () => {
  assert.equal(normalizeInboundMessageThreadId(undefined), null);
  assert.equal(normalizeInboundMessageThreadId(null), null);
  assert.equal(normalizeInboundMessageThreadId(9), "9");
  rejects(() => normalizeInboundMessageThreadId(""), "non_canonical_id");
});

test("the default lane and a topic lane in the same chat are different lanes", () => {
  const defaultLane = buildTelegramRouteLane({ accountId: "telegram", chatId: 100, messageThreadId: null });
  const topicLane = buildTelegramRouteLane({ accountId: "telegram", chatId: 100, messageThreadId: 5 });

  assert.notEqual(defaultLane.laneKey, topicLane.laneKey);
  assert.equal(defaultLane.messageThreadId, null);
  assert.equal(topicLane.messageThreadId, "5");
  assert.equal(isSameLane(defaultLane, topicLane), false);
  assert.equal(
    isSameLane(defaultLane, buildTelegramRouteLane({ accountId: "telegram", chatId: "100", messageThreadId: null })),
    true,
  );
});

test("lane keys are length-prefixed so ids containing separators cannot collide", () => {
  const left = buildTelegramRouteLane({ accountId: "a|1", chatId: 2, messageThreadId: 3 });
  const right = buildTelegramRouteLane({ accountId: "a", chatId: 12, messageThreadId: 3 });
  assert.notEqual(left.laneKey, right.laneKey);

  const withColon = buildTelegramRouteLane({ accountId: "a::b", chatId: 1, messageThreadId: null });
  const plain = buildTelegramRouteLane({ accountId: "a", chatId: 1, messageThreadId: null });
  assert.notEqual(withColon.laneKey, plain.laneKey);
});

test("scope keys separate lanes and workspaces without ambiguity", () => {
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 1, messageThreadId: null });
  const other = buildTelegramRouteLane({ accountId: "telegram", chatId: 1, messageThreadId: 2 });

  assert.notEqual(buildLaneScopeKey(lane, "/w"), buildLaneScopeKey(other, "/w"));
  assert.notEqual(buildLaneScopeKey(lane, "/w"), buildLaneScopeKey(lane, "/w2"));
  assert.equal(buildLaneScopeKey(lane, ""), "");
  assert.equal(buildLaneScopeKey(null, "/w"), "");
});

test("system lanes are distinct from each other and from every Telegram lane", () => {
  const keys = new Set();
  for (const channel of ["closeout", "liveness", "system-message", "background-author", "automation-sender"]) {
    const lane = buildSystemRouteLane(channel);
    assert.equal(lane.kind, "sys");
    assert.equal(lane.messageThreadId, null);
    keys.add(lane.laneKey);
  }
  assert.equal(keys.size, 5);

  const telegramLane = buildTelegramRouteLane({ accountId: "telegram", chatId: 1, messageThreadId: null });
  assert.equal(keys.has(telegramLane.laneKey), false);
});

test("non-Telegram providers keep a binding-scoped legacy lane", () => {
  const lane = buildLegacyRouteLane({ provider: "weixin", bindingKey: "default:acc:user" });
  assert.equal(lane.kind, "legacy");
  assert.equal(lane.messageThreadId, null);
  assert.notEqual(
    lane.laneKey,
    buildLegacyRouteLane({ provider: "weixin", bindingKey: "default:acc:other" }).laneKey,
  );
});

test("inbound resolution reads the topic from either the top level or the telegram block", () => {
  const fromTop = resolveInboundRouteLane({
    provider: "telegram", accountId: "telegram", chatId: "42", messageThreadId: "8",
  });
  const fromBlock = resolveInboundRouteLane({
    provider: "telegram", accountId: "telegram", chatId: "42", telegram: { messageThreadId: "8" },
  });
  assert.equal(fromTop.laneKey, fromBlock.laneKey);

  const noTopic = resolveInboundRouteLane({
    provider: "telegram", accountId: "telegram", chatId: "42",
  });
  assert.equal(noTopic.messageThreadId, null);
  assert.notEqual(noTopic.laneKey, fromTop.laneKey);
});

test("inbound resolution fails closed on a present but non-canonical topic id", () => {
  rejects(
    () => resolveInboundRouteLane({
      provider: "telegram", accountId: "telegram", chatId: "42", messageThreadId: "not-a-topic",
    }),
    "non_canonical_id",
  );
});

test("lane shape telemetry carries no identifiers", () => {
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 999, messageThreadId: 7 });
  const shape = describeLaneShape(lane);
  assert.deepEqual({ ...shape }, { kind: "tg", topic: "topic" });
  const serialized = JSON.stringify(shape);
  assert.equal(serialized.includes("999"), false);
  assert.equal(serialized.includes("7"), false);
});
