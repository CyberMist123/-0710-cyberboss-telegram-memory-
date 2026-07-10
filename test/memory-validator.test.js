const test = require("node:test");
const assert = require("node:assert/strict");

const { rewriteDraftToMatchMemory, validateDraftAgainstMemory } = require("../src/core/memory-validator");

test("memory validator detects address mismatch from hard preference memory", () => {
  const resolved = {
    index: [{
      id: "mem_1",
      key: "nickname",
      value: "哥哥",
      text: "叫我哥哥",
      priority: "hard_preference",
      status: "active",
    }],
  };
  const result = validateDraftAgainstMemory("以后我叫你宝宝", resolved);
  assert.equal(result.ok, false);
  assert.equal(result.conflicts[0].type, "address_mismatch");
  assert.equal(result.conflicts[0].expectedTerm, "哥哥");
  assert.equal(result.conflicts[0].actualTerm, "宝宝");
});

test("memory validator rewrites address mismatch to expected term", () => {
  const resolved = {
    index: [{
      id: "mem_1",
      key: "nickname",
      value: "哥哥",
      text: "叫我哥哥",
      priority: "hard_preference",
      status: "active",
    }],
  };
  const result = rewriteDraftToMatchMemory("以后我叫你宝宝", resolved);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.text, "以后我叫你哥哥");
});
