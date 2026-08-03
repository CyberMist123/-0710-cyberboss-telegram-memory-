const test = require("node:test");
const assert = require("node:assert/strict");

const { parseMemoryCommand, parseTerminalMemoryCommand } = require("../src/core/memory-command-router");

test("parseMemoryCommand parses weixin memory command", () => {
  const parsed = parseMemoryCommand("/memory approve pending_1 不喜欢奇怪比喻，偏好直接表达");
  assert.equal(parsed.action, "approve");
  assert.deepEqual(parsed.args, ["pending_1", "不喜欢奇怪比喻，偏好直接表达"]);
});

test("parseTerminalMemoryCommand parses terminal memory args", () => {
  const parsed = parseTerminalMemoryCommand(["approve", "pending_1", "不喜欢奇怪比喻，偏好直接表达"]);
  assert.equal(parsed.action, "approve");
  assert.deepEqual(parsed.args, ["pending_1", "不喜欢奇怪比喻，偏好直接表达"]);
});

test("parseTerminalMemoryCommand parses terminal flags", () => {
  const parsed = parseTerminalMemoryCommand(["review", "--category", "preferences", "--limit", "5", "--json"]);
  assert.equal(parsed.action, "review");
  assert.deepEqual(parsed.args, []);
  assert.deepEqual(parsed.options, { category: "preferences", limit: "5", json: true });
});

test("parseMemoryCommand honours telegram /memory review flags (not dropped into args)", () => {
  const parsed = parseMemoryCommand("/memory review --category preferences --limit 5 --json");
  assert.equal(parsed.action, "review");
  assert.deepEqual(parsed.args, []);
  assert.deepEqual(parsed.options, { category: "preferences", limit: "5", json: true });
});
