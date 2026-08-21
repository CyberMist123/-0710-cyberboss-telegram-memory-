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
const { findModelByQuery } = require("../src/adapters/runtime/codex/model-catalog");
const { CyberbossApp } = require("../src/core/app");

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

// --- /effort command ---------------------------------------------------------

// A CyberbossApp reduced to what the command handler touches: a session store
// that persists runtime params in memory and a channel that records replies.
function makeApp({
  storedEffort = "",
  runtimeId = "claudecode",
  sessionModels = [],
  runtimeModels = [],
  windowEnabled = false,
} = {}) {
  const sent = [];
  const stored = { model: "", modelProvider: "", effort: storedEffort };
  const runtimeWrites = [];
  const windowWrites = [];
  const sessionStore = {
    buildBindingKey: () => "binding-1",
    getAvailableModelCatalog: () => ({ models: sessionModels }),
    getRuntimeParamsForWorkspace: () => ({ ...stored }),
    setRuntimeParamsForWorkspace: (bindingKey, workspaceRoot, params) => {
      runtimeWrites.push({ bindingKey, workspaceRoot, params: { ...params } });
      Object.assign(stored, params);
      return stored;
    },
  };
  const app = Object.create(CyberbossApp.prototype);
  app.runtimeAdapter = {
    describe: () => ({ id: runtimeId, model: "", models: runtimeModels }),
    getSessionStore: () => sessionStore,
    getWindowOverride: () => ({ enabled: windowEnabled, value: {} }),
    setWindowOverride: (request) => {
      windowWrites.push(request);
      return { enabled: windowEnabled, applied: windowEnabled, value: request.patch };
    },
  };
  app.channelAdapter = { sendText: async (payload) => { sent.push(payload); } };
  app.resolveWorkspaceRoot = () => "/tmp/workspace";
  return { app, sent, stored, runtimeWrites, windowWrites };
}

const INBOUND = { senderId: "user-1", workspaceId: "default", accountId: "telegram", contextToken: "" };

test("/effort with no argument reports the level in force and its source", async () => {
  const fresh = makeApp();
  await fresh.app.handleEffortCommand(INBOUND, { name: "effort", args: "" });
  assert.match(fresh.sent[0].text, /Current effort: medium/);
  assert.match(fresh.sent[0].text, /Source: default/);
  assert.match(fresh.sent[0].text, /Available levels: low, medium, high, xhigh, max/);

  const overridden = makeApp({ storedEffort: "high" });
  await overridden.app.handleEffortCommand(INBOUND, { name: "effort", args: "" });
  assert.match(overridden.sent[0].text, /Current effort: high/);
  assert.match(overridden.sent[0].text, /Source: this chat/);
});

test("/effort with no argument names the environment when that is what applies", async () => {
  const previous = process.env.CYBERBOSS_CLAUDE_EFFORT;
  process.env.CYBERBOSS_CLAUDE_EFFORT = "low";
  try {
    const { app, sent } = makeApp();
    await app.handleEffortCommand(INBOUND, { name: "effort", args: "" });
    assert.match(sent[0].text, /Current effort: low/);
    assert.match(sent[0].text, /Source: CYBERBOSS_CLAUDE_EFFORT/);
  } finally {
    if (previous === undefined) {
      delete process.env.CYBERBOSS_CLAUDE_EFFORT;
    } else {
      process.env.CYBERBOSS_CLAUDE_EFFORT = previous;
    }
  }
});

test("/effort <level> persists the choice for this workspace and confirms it", async () => {
  const { app, sent, stored } = makeApp();
  await app.handleEffortCommand(INBOUND, { name: "effort", args: " HIGH " });
  assert.equal(stored.effort, "high");
  assert.match(sent[0].text, /Effort switched/);
  assert.match(sent[0].text, /effort: high/);
  assert.match(sent[0].text, /workspace: \/tmp\/workspace/);
});

test("/effort high writes both the window override and workspace runtime params", async () => {
  const { app, stored, runtimeWrites, windowWrites } = makeApp({ windowEnabled: true });
  await app.handleEffortCommand(INBOUND, { name: "effort", args: "high" });

  assert.equal(windowWrites.length, 1);
  assert.deepEqual(windowWrites[0].patch, {
    effort: "high",
    effortSource: "command",
    effortScope: "window",
  });
  assert.deepEqual(runtimeWrites.map((entry) => entry.params), [{ effort: "high" }]);
  assert.equal(stored.effort, "high");
});

test("/effort with an unrecognised level changes nothing and prints the usage line", async () => {
  const { app, sent, stored } = makeApp({ storedEffort: "high" });
  await app.handleEffortCommand(INBOUND, { name: "effort", args: "turbo" });
  assert.equal(stored.effort, "high");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Usage: \/effort low\|medium\|high\|xhigh\|max/);
});

test("/effort is dispatched by name and is listed in the help output", async () => {
  const { app, stored } = makeApp();
  await CyberbossApp.prototype.dispatchChannelCommand.call(
    app, INBOUND, { name: "effort", args: "max" },
  );
  assert.equal(stored.effort, "max");

  const { buildWeixinHelpText } = require("../src/core/command-registry");
  assert.match(buildWeixinHelpText(), /\/effort, \/effort <level>/);
});

// --- /model command ----------------------------------------------------------

const CLAUDE_MODELS = [
  { model: "claude-fable-5", aliases: ["fable"] },
  { model: "claude-opus-5", aliases: ["opus"] },
  { model: "claude-sonnet-5", aliases: ["sonnet"] },
  { model: "claude-haiku-4-5-20251001", aliases: ["haiku", "claude-haiku-4-5"] },
  { model: "claude-opus-4-8", aliases: ["opus-4.8"] },
  { model: "claude-opus-4-7", aliases: ["opus-4.7"] },
  { model: "claude-opus-4-6", aliases: ["opus-4.6"] },
  { model: "claude-sonnet-4-6", aliases: ["sonnet-4.6"] },
];

test("/model rejects an unknown Claude model, lists ids and aliases, and writes no storage", async () => {
  const { app, sent, runtimeWrites, windowWrites } = makeApp({ runtimeModels: CLAUDE_MODELS });
  await app.handleModelCommand(INBOUND, { name: "model", args: "claude-opus-3-9" });

  assert.match(sent[0].text, /^❌ Model not found/m);
  assert.match(sent[0].text, /claude-opus-5 \(aliases: opus\)/);
  assert.match(sent[0].text, /claude-haiku-4-5-20251001 \(aliases: haiku, claude-haiku-4-5\)/);
  assert.deepEqual(windowWrites, []);
  assert.deepEqual(runtimeWrites, []);
});

test("/model resolves a Claude alias and writes both window override and runtime params", async () => {
  const { app, sent, stored, runtimeWrites, windowWrites } = makeApp({
    runtimeModels: CLAUDE_MODELS,
    windowEnabled: true,
  });
  await app.handleModelCommand(INBOUND, { name: "model", args: " OPUS " });

  assert.deepEqual(windowWrites[0].patch, {
    model: "claude-opus-5",
    modelSource: "command",
    modelScope: "window",
  });
  assert.deepEqual(runtimeWrites.map((entry) => entry.params), [{ model: "claude-opus-5" }]);
  assert.equal(stored.model, "claude-opus-5");
  assert.match(sent[0].text, /scope: window/);
  assert.match(sent[0].text, /model: claude-opus-5/);
});

test("findModelByQuery preserves Codex id and model matching when aliases are absent", () => {
  const models = [
    { id: "model-row-1", model: "gpt-5.2-codex" },
    { id: "model-row-2", model: "gpt-5.3-codex" },
  ];

  assert.equal(findModelByQuery(models, "GPT-5.2-CODEX"), models[0]);
  assert.equal(findModelByQuery(models, "MODEL-ROW-2"), models[1]);
  assert.equal(findModelByQuery(models, "opus"), null);
});

test("/effort auto-restarts the lane child so the new level applies on the next message", async () => {
  const { app, sent } = makeApp({ windowEnabled: true });
  const restarts = [];
  app.runtimeAdapter.restartLaneChild = async (req) => { restarts.push(req); return { retired: true, threadId: "t" }; };
  await app.handleEffortCommand(INBOUND, { name: "effort", args: "high" });
  assert.equal(restarts.length, 1, "restartLaneChild is invoked once");
  assert.equal(restarts[0].effort, "high", "the restart carries the newly-set effort");
  assert.match(sent[0].text, /Effort switched/);
  assert.match(sent[0].text, /进程已重启/);
});

test("/effort still succeeds when the runtime cannot restart (fail-open)", async () => {
  const { app, sent } = makeApp({ windowEnabled: true });
  app.runtimeAdapter.restartLaneChild = async () => { throw new Error("boom"); };
  await app.handleEffortCommand(INBOUND, { name: "effort", args: "high" });
  assert.match(sent[0].text, /Effort switched/, "the command still reports success");
  assert.doesNotMatch(sent[0].text, /进程已重启/, "no restart line when the restart failed");
});
