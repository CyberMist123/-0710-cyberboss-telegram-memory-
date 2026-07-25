"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BoundedJsonError,
  DEFAULT_LIMITS,
  parseBoundedJson,
  parseStrictBoolean,
} = require("../src/core/bounded-json");

function rejects(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BoundedJsonError, `expected BoundedJsonError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("valid bounded JSON parses", () => {
  assert.deepEqual(parseBoundedJson('{"a":1,"b":["x"]}', { label: "T" }), { a: 1, b: ["x"] });
});

test("malformed JSON is rejected, never silently ignored", () => {
  rejects(() => parseBoundedJson("{", { label: "T" }), "invalid_json");
  rejects(() => parseBoundedJson("{'a':1}", { label: "T" }), "invalid_json");
  rejects(() => parseBoundedJson("undefined", { label: "T" }), "invalid_json");
  rejects(() => parseBoundedJson(undefined, { label: "T" }), "not_a_string");
});

test("byte budget is enforced on the raw value", () => {
  const withinLimit = JSON.stringify({ a: "x".repeat(200) });
  assert.ok(parseBoundedJson(withinLimit, { label: "T", limits: { maxBytes: 4096 } }));
  rejects(
    () => parseBoundedJson(withinLimit, { label: "T", limits: { maxBytes: 64 } }),
    "too_large",
  );
  // Multi-byte characters count as bytes, not code units.
  rejects(
    () => parseBoundedJson(JSON.stringify({ a: "中".repeat(40) }), { label: "T", limits: { maxBytes: 60 } }),
    "too_large",
  );
});

test("nesting depth is bounded", () => {
  let deep = "1";
  for (let i = 0; i < 12; i += 1) {
    deep = `{"a":${deep}}`;
  }
  rejects(() => parseBoundedJson(deep, { label: "T", limits: { maxDepth: 4 } }), "too_deep");
  assert.ok(parseBoundedJson('{"a":{"b":1}}', { label: "T", limits: { maxDepth: 3 } }));
});

test("string, array, key-count and node-count budgets are enforced", () => {
  rejects(
    () => parseBoundedJson(JSON.stringify({ a: "x".repeat(50) }), { label: "T", limits: { maxStringLength: 10 } }),
    "string_too_long",
  );
  rejects(
    () => parseBoundedJson(JSON.stringify([1, 2, 3, 4, 5]), { label: "T", limits: { maxArrayLength: 3 } }),
    "array_too_long",
  );
  const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  rejects(
    () => parseBoundedJson(JSON.stringify(wide), { label: "T", limits: { maxObjectKeys: 5 } }),
    "too_many_keys",
  );
  rejects(
    () => parseBoundedJson(JSON.stringify(wide), { label: "T", limits: { maxTotalNodes: 5 } }),
    "too_many_nodes",
  );
});

test("prototype-polluting keys are rejected everywhere they can appear", () => {
  for (const payload of [
    '{"__proto__":{"polluted":true}}',
    '{"a":{"__proto__":{"polluted":true}}}',
    '{"prototype":{}}',
    '{"constructor":{"prototype":{}}}',
    '[{"__proto__":1}]',
  ]) {
    rejects(() => parseBoundedJson(payload, { label: "T" }), "forbidden_key");
  }
  // The prototype is untouched after the rejected parses.
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("an unknown bound name is itself a configuration error", () => {
  rejects(() => parseBoundedJson("{}", { label: "T", limits: { maxThings: 3 } }), "unknown_bound");
  rejects(() => parseBoundedJson("{}", { label: "T", limits: { maxBytes: 0 } }), "unknown_bound");
});

test("default limits are conservative", () => {
  assert.ok(DEFAULT_LIMITS.maxBytes <= 64 * 1024);
  assert.ok(DEFAULT_LIMITS.maxDepth <= 8);
});

test("strict boolean parsing does not treat an arbitrary string as true", () => {
  assert.equal(parseStrictBoolean("1", { label: "F" }), true);
  assert.equal(parseStrictBoolean("true", { label: "F" }), true);
  assert.equal(parseStrictBoolean("TRUE", { label: "F" }), true);
  assert.equal(parseStrictBoolean("0", { label: "F" }), false);
  assert.equal(parseStrictBoolean("false", { label: "F" }), false);
  assert.equal(parseStrictBoolean(undefined, { label: "F", fallback: false }), false);
  assert.equal(parseStrictBoolean("", { label: "F", fallback: true }), true);

  for (const value of ["yes", "on", "enabled", "y", "please", "2", "null"]) {
    rejects(() => parseStrictBoolean(value, { label: "F" }), "invalid_boolean");
  }
});
