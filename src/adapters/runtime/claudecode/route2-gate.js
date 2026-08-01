"use strict";

const ROUTE2_GATE_FLAG = "CYBERBOSS_ROUTE2_GATE_ENABLED";
const ROUTE2_STATUS = "我把这个任务转到独立执行会话，完成后回来告诉你。";
const LIMITS = Object.freeze({
  soft: Object.freeze({ maxNamespaces: 1, maxTools: 4, maxSchemaChars: 3000, maxToolUses: 3, maxContextTokens: 6000 }),
  hard: Object.freeze({ maxToolsets: 1, maxMcpServers: 1, maxTools: 6, minContextTokens: 8000 }),
});

function route2GateEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.[ROUTE2_GATE_FLAG] || "").trim());
}

function decideRoute2Gate(plan = {}, { env = process.env } = {}) {
  if (!route2GateEnabled(env)) return null;
  const catalog = Array.isArray(plan.catalog) ? plan.catalog : [];
  const requestedNames = Array.isArray(plan.toolNames) ? plan.toolNames.map(normalizeText).filter(Boolean) : [];
  const entries = requestedNames.map((name) => catalog.find((entry) => entry?.id === name && !entry.alias_of) || null);
  const schemaChars = entries.reduce((total, entry) => total + nonnegativeNumber(entry?.estimated_schema_chars), 0);
  const namespaces = new Set(requestedNames.map((name) => namespaceOf(name)));
  const hardReasons = [];

  if (!requestedNames.length) hardReasons.push("no_tools");
  if (entries.some((entry) => !entry)) hardReasons.push("catalog_entry_missing");
  if (entries.some((entry) => entry && entry.authorized === false)) hardReasons.push("outside_base_allowlist");
  if (entries.some((entry) => entry && !validResultLimit(entry.max_result_bytes))) hardReasons.push("unbounded_result");
  if (plan.serverTruncatable === false) hardReasons.push("server_truncation_unavailable");
  if (plan.fullEngineeringHarness === true) hardReasons.push("full_engineering_harness");
  if (plan.repositoryWork === true) hardReasons.push("repository_work");
  if (plan.subagent === true) hardReasons.push("subagent");
  if (plan.parallel === true) hardReasons.push("parallel");
  if (plan.longLoop === true) hardReasons.push("long_loop");
  if (plan.callCountControllable === false) hardReasons.push("uncontrolled_call_count");
  if (nonnegativeNumber(plan.toolsetCount) > LIMITS.hard.maxToolsets) hardReasons.push("toolset_count_hard_limit");
  if (nonnegativeNumber(plan.mcpServerCount || namespaces.size) > LIMITS.hard.maxMcpServers) hardReasons.push("mcp_server_count_hard_limit");
  if (plan.leaseValid === false) hardReasons.push("capability_lease_expired");
  if (requestedNames.length > LIMITS.hard.maxTools) hardReasons.push("tool_count_hard_limit");
  if (nonnegativeNumber(plan.expectedContextTokens) >= LIMITS.hard.minContextTokens) hardReasons.push("context_hard_limit");
  if (plan.multipleLargeMcpServers === true) hardReasons.push("multiple_large_mcp_servers");

  const actualToolUses = nonnegativeNumber(plan.actualToolUses);
  const withinSoft = hardReasons.length === 0
    && namespaces.size <= LIMITS.soft.maxNamespaces
    && requestedNames.length <= LIMITS.soft.maxTools
    && schemaChars <= LIMITS.soft.maxSchemaChars
    && actualToolUses <= LIMITS.soft.maxToolUses
    && nonnegativeNumber(plan.expectedContextTokens) <= LIMITS.soft.maxContextTokens;
  const route = hardReasons.length || (!withinSoft && plan.preferRoute2 !== true) ? "route1" : "route2";
  return {
    route,
    decision: route === "route1" ? "route_to_route1" : "stay_route2",
    status: route === "route1" ? ROUTE2_STATUS : "",
    chat_capability: "unchanged",
    reasons: hardReasons.length ? hardReasons : (withinSoft ? ["within_soft_limit"] : ["middle_band_selected_route2"]),
    estimate: {
      schema_chars: schemaChars,
      expected_context_tokens: nonnegativeNumber(plan.expectedContextTokens),
      tool_count: requestedNames.length,
      namespace_count: namespaces.size,
    },
  };
}

class Route2GateState {
  constructor({ sessionSlotStore, env = process.env } = {}) {
    this.sessionSlotStore = sessionSlotStore;
    this.env = env;
    this.active = new Map();
  }

  begin({ sessionSlotKey, windowId, overrideFingerprint = "", taskId = "", plan = {} } = {}) {
    if (!route2GateEnabled(this.env)) return null;
    const slotKey = normalizeText(sessionSlotKey);
    const decision = decideRoute2Gate(plan, { env: this.env });
    if (!slotKey || !decision) return decision;
    const state = {
      sessionSlotKey: slotKey,
      windowId: normalizeText(windowId),
      overrideFingerprint: normalizeText(overrideFingerprint),
      taskId: normalizeText(taskId),
      decision,
      actualToolUses: 0,
      returnBytes: 0,
      usage: emptyUsage(),
    };
    this.active.set(slotKey, state);
    this.sessionSlotStore?.setRoute2Gate?.(slotKey, publicState(state));
    return decision;
  }

  observe(event) {
    if (!route2GateEnabled(this.env)) return null;
    const slotKey = normalizeText(event?.payload?.sessionSlotKey);
    const state = this.active.get(slotKey);
    if (!state) return null;
    if (event.type === "runtime.tool.use") state.actualToolUses += 1;
    if (event.type === "runtime.tool.result") state.returnBytes += nonnegativeNumber(event.payload.returnBytes);
    if (event.type === "runtime.context.updated") state.usage = normalizeUsage(event.payload);
    this.sessionSlotStore?.setRoute2Gate?.(slotKey, publicState(state));
    if (event.type !== "runtime.turn.completed" && event.type !== "runtime.turn.failed") return null;
    this.active.delete(slotKey);
    const payload = {
      route: state.decision.route,
      routeToken: slotKey,
      sessionSlotKey: slotKey,
      windowId: state.windowId,
      taskId: state.taskId,
      overrideFingerprint: state.overrideFingerprint,
      threadId: normalizeText(event.payload.threadId),
      turnId: normalizeText(event.payload.turnId),
      estimate: state.decision.estimate,
      actualToolUses: state.actualToolUses,
      returnBytes: state.returnBytes,
      usage: state.usage,
      outcome: event.type === "runtime.turn.completed" ? "success" : "error",
    };
    this.sessionSlotStore?.setRoute2Gate?.(slotKey, { ...publicState(state), completed: true });
    return { type: "runtime.route2.cost", payload };
  }
}

async function runOptionalRoute2Tool({ invoke, chatCore }) {
  try {
    return { toolResult: await invoke(), reply: await chatCore() };
  } catch (error) {
    return { toolResult: null, toolError: normalizeText(error?.code || error?.message) || "optional_tool_failed", reply: await chatCore() };
  }
}

function publicState(state) {
  return {
    route: state.decision.route,
    decision: state.decision.decision,
    windowId: state.windowId,
    overrideFingerprint: state.overrideFingerprint,
    taskId: state.taskId,
    actualToolUses: state.actualToolUses,
    returnBytes: state.returnBytes,
    usage: state.usage,
  };
}

function normalizeUsage(value = {}) {
  return {
    input_tokens: nonnegativeNumber(value.inputTokens),
    cache_creation_input_tokens: nonnegativeNumber(value.cacheCreationInputTokens),
    cache_read_input_tokens: nonnegativeNumber(value.cacheReadInputTokens),
    output_tokens: nonnegativeNumber(value.outputTokens),
  };
}

function emptyUsage() { return normalizeUsage(); }
function validResultLimit(value) { return Number.isInteger(value) && value > 0; }
function nonnegativeNumber(value) { return Math.max(0, Number(value) || 0); }
function namespaceOf(name) { const match = /^mcp__([^_]+)__/.exec(name); return match ? match[1] : "cyberboss_tools"; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = {
  LIMITS,
  ROUTE2_GATE_FLAG,
  ROUTE2_STATUS,
  Route2GateState,
  decideRoute2Gate,
  route2GateEnabled,
  runOptionalRoute2Tool,
};
