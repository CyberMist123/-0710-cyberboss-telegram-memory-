"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_EFFORT,
  EFFORT_VALUES,
  buildArgs,
  normalizeEffort,
  resolveEffortLevel,
  resolveStrictMcpConfig,
} = require("../src/adapters/runtime/claudecode/process-client");

// A launch built from nothing but the base runtime contract: no model, no
// profile, no operator extra args. Every case below varies exactly one input
// away from this, so a changed flag can only come from that input.
function argsWith(overrides = {}) {
  return buildArgs({
    model: "",
    permissionMode: "default",
    disableVerbose: true,
    extraArgs: [],
    mcpConfigPaths: [],
    resumeSessionId: "",
    env: {},
    ...overrides,
  });
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function countFlag(args, flag) {
  return args.filter((arg) => arg === flag).length;
}

test("buildArgs launches at the medium default when nothing overrides it", () => {
  const args = argsWith();
  assert.equal(flagValue(args, "--effort"), "medium");
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.equal(countFlag(args, "--effort"), 1);
});

test("buildArgs prefers the binding's effort over the environment default", () => {
  const args = argsWith({
    effort: "high",
    env: { CYBERBOSS_CLAUDE_EFFORT: "low" },
  });
  assert.equal(flagValue(args, "--effort"), "high");
  assert.equal(countFlag(args, "--effort"), 1);
});

test("buildArgs falls back to the environment default when the binding has no override", () => {
  const args = argsWith({ env: { CYBERBOSS_CLAUDE_EFFORT: "low" } });
  assert.equal(flagValue(args, "--effort"), "low");
});

test("an unrecognised effort at either level falls through to the next one", () => {
  assert.equal(resolveEffortLevel("turbo", { CYBERBOSS_CLAUDE_EFFORT: "low" }), "low");
  assert.equal(resolveEffortLevel("turbo", { CYBERBOSS_CLAUDE_EFFORT: "hyper" }), "medium");
  assert.equal(resolveEffortLevel(" HIGH ", {}), "high");
  assert.equal(normalizeEffort("nope"), "");
});

test("an explicit --effort in CYBERBOSS_CLAUDE_EXTRA_ARGS is not doubled", () => {
  const listForm = argsWith({
    effort: "high",
    extraArgs: ["--effort", "max"],
    env: { CYBERBOSS_CLAUDE_EFFORT: "low" },
  });
  assert.equal(countFlag(listForm, "--effort"), 1);
  assert.equal(flagValue(listForm, "--effort"), "max");

  // `--effort=max` is the same request written differently and must dedupe too.
  const equalsForm = argsWith({ effort: "high", extraArgs: ["--effort=max"] });
  assert.equal(countFlag(equalsForm, "--effort"), 0);
  assert.ok(equalsForm.includes("--effort=max"));
});

test("strict MCP configuration is on by default and off only when explicitly disabled", () => {
  assert.ok(argsWith().includes("--strict-mcp-config"));
  assert.ok(!argsWith({ env: { CYBERBOSS_CLAUDE_STRICT_MCP: "0" } }).includes("--strict-mcp-config"));
  assert.ok(!argsWith({ env: { CYBERBOSS_CLAUDE_STRICT_MCP: "false" } }).includes("--strict-mcp-config"));
  assert.ok(argsWith({ env: { CYBERBOSS_CLAUDE_STRICT_MCP: "1" } }).includes("--strict-mcp-config"));
  // An unrecognised value must not silently disable an isolation flag.
  assert.equal(resolveStrictMcpConfig({ CYBERBOSS_CLAUDE_STRICT_MCP: "maybe" }), true);
});

test("an explicit --strict-mcp-config in the extra args is not doubled", () => {
  const args = argsWith({ extraArgs: ["--strict-mcp-config"] });
  assert.equal(countFlag(args, "--strict-mcp-config"), 1);
});

test("a validated launch profile owns both flags, so the base launch emits neither", () => {
  const args = argsWith({ effort: "high", profileManaged: true });
  assert.equal(countFlag(args, "--effort"), 0);
  assert.equal(countFlag(args, "--strict-mcp-config"), 0);
  // The transport contract is untouched by the profile.
  assert.ok(args.includes("--output-format"));
});

test("an isolated system launch opts out of effort but keeps strict MCP isolation", () => {
  const args = argsWith({ emitEffort: false, env: { CYBERBOSS_CLAUDE_EFFORT: "max" } });
  assert.equal(countFlag(args, "--effort"), 0);
  assert.ok(args.includes("--strict-mcp-config"));
});

test("the effort level set is the CLI capability table's, not a second copy", () => {
  const { EFFORT_VALUES: capabilityValues } = require("../src/adapters/runtime/claudecode/cli-capabilities");
  assert.deepEqual(EFFORT_VALUES, capabilityValues);
  for (const level of EFFORT_VALUES) {
    assert.equal(flagValue(argsWith({ effort: level }), "--effort"), level);
  }
});
