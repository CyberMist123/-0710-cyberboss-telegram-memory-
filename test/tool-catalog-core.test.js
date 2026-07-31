"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildCatalog } = require("../scripts/audit/catalog-metering");
const {
  ProjectToolHost, PROJECT_TOOLS, TOOL_ALIASES, DEPRECATED_HIDDEN_TOOL_NAMES, createExtraToolHosts,
} = require("../src/tools/tool-host");
const {
  TOOL_RISKS, buildManifest, catalogEnabled, findSchema, resolveToolset,
} = require("../src/tools/tool-catalog-manifest");

const plantedValue = "planted-nondisclosure-canary-0000";
const directorySchema = { type: "object", properties: { handle: { type: "string" } }, additionalProperties: false };
const privatePatterns = [/[A-Za-z]:[\\/]/, /\/home\/[A-Za-z0-9_.-]+/, /\/Users\/[A-Za-z0-9_.-]+/, /(sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/];

function services() {
  return {
    memoryLookup: { lookup: () => ({ hits: [], empty: true }) }, memoryNote: { note: () => ({ id: "note-test" }) },
    reminder: { create: async (args) => ({ id: "reminder-test", command: args.command }) },
    diary: { append: async () => ({ filePath: "diary-test" }) }, system: { queueMessage: () => ({ id: "system-test" }) }, weather: { getRaw: async () => ({ query: { value: "test" }, extensions: "all" }) }, whereabouts: {},
  };
}
function host(toolset = "") { return new ProjectToolHost({ services: services(), runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } }, toolset }); }
function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  try { const value = run(); return value && typeof value.then === "function" ? value.finally(restore) : (restore(), value); } catch (error) { restore(); throw error; }
}
function enabled(run, toolset = undefined) { return withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_TOOL_CATALOG_TOOLSET: toolset }, run); }
function manifest(toolset = null) { return buildManifest({ projectTools: PROJECT_TOOLS, aliases: TOOL_ALIASES, extraHosts: createExtraToolHosts({ whereabouts: {} }), deprecatedNames: DEPRECATED_HIDDEN_TOOL_NAMES, toolset }); }
function assertCode(error, code) { assert.equal(error?.code, code); return true; }
function assertNoPrivateText(value) { const text = typeof value === "string" ? value : JSON.stringify(value); const withoutUriSchemes = text.replace(/[a-z]+:\/\//gi, ""); for (const pattern of privatePatterns) assert.doesNotMatch(withoutUriSchemes, pattern); if (process.env.USERNAME) assert.equal(text.includes(process.env.USERNAME), false); assert.equal(text.includes(plantedValue), false); }
function assertFailedClosed(result, message) { assert.equal(result.error, undefined, `process never ran: ${result.error}`); assert.notEqual(result.status, null, "process never ran: spawnSync returned status null"); assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`); }

const serverProgram = String.raw`
const { ProjectToolHost } = require("./src/tools/tool-host");
const { runToolMcpServer } = require("./src/tools/mcp-stdio-server");
const calls = [];
const services = { memoryLookup:{lookup:()=>({hits:[],empty:true})}, memoryNote:{note:()=>({id:"note-test"})}, reminder:{create:async(args)=>({id:"reminder-test",command:args.command})}, diary:{append:async()=>({filePath:"diary-test"})}, system:{queueMessage:(args,context)=>({id:"system-test",routeToken:context.routeToken})}, whereabouts:{} };
const toolHost = new ProjectToolHost({ services, runtimeContextStore:{load(){},resolveActiveContext(){return {}}}, toolset:process.env.TEST_TOOLSET||"" });
runToolMcpServer({toolHost,runtimeId:"test",workspaceRoot:"workspace-test",routeToken:process.env.TEST_ROUTE_TOKEN||""});`;
function mcp(messages, env = {}) {
  const input = messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["-e", serverProgram], { cwd: path.join(__dirname, ".."), input, encoding: "utf8", env: { ...process.env, CYBERBOSS_TOOL_CATALOG_ENABLED: undefined, CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined, ...env } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("A0/A1/A15 flag-off is exact and enabled surface is four minimal directories plus two original residents", () => {
  withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: undefined, CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined }, () => {
    assert.equal(catalogEnabled(), false); const baseline = host().listTools();
    withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "false" }, () => assert.deepEqual(host().listTools(), baseline));
  });
  enabled(() => {
    const tools = host().listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["cyberboss_catalog_memory", "cyberboss_catalog_tool", "cyberboss_catalog_mcp", "cyberboss_catalog_skill", "cyberboss_system_send", "cyberboss_time"]);
    for (const tool of tools.slice(0, 4)) { assert.deepEqual(tool.inputSchema, directorySchema); assert.ok(JSON.stringify(tool.inputSchema).length <= 120); }
    for (const tool of tools.slice(4)) assert.deepEqual(tool.inputSchema, PROJECT_TOOLS.find((item) => item.name === tool.name).inputSchema);
  });
});

test("A0 flag-off leaves the legacy invocation set unchanged even when a toolset is supplied", async () => withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "false" }, async () => {
  const result = await host("chat-core@1").invokeTool("weather_raw", {}); assert.equal(result.data.extensions, "all");
  await assert.rejects(() => host("chat-core@1").invokeTool("invented_tool", {}), /Unknown tool/);
}));

test("A0/A11/A12 MCP stdio preserves flag-off output and narrows enabled resources without schema leakage", () => {
  const requests = [{ id: 1, method: "initialize", params: {} }, { id: 2, method: "tools/list" }, { id: 3, method: "resources/list" }];
  const unset = mcp(requests); const disabled = mcp(requests, { CYBERBOSS_TOOL_CATALOG_ENABLED: "false" }); assert.deepEqual(disabled, unset);
  const enabledOutput = mcp(requests, { CYBERBOSS_TOOL_CATALOG_ENABLED: "true" });
  assert.equal(enabledOutput[0].result.capabilities.tools.listChanged, false);
  assert.deepEqual(enabledOutput[1].result.tools.map((tool) => tool.name), ["cyberboss_catalog_memory", "cyberboss_catalog_tool", "cyberboss_catalog_mcp", "cyberboss_catalog_skill", "cyberboss_system_send", "cyberboss_time"]);
  const resources = enabledOutput[2].result.resources; const toolUris = resources.filter((item) => item.uri.startsWith("cyberboss://tools/")).map((item) => item.uri);
  assert.deepEqual(toolUris, ["cyberboss://tools/index", "cyberboss://tools/cyberboss_system_send", "cyberboss://tools/cyberboss_time"]);
  for (const uri of ["sleep-mode", "telegram-send", "telegram-send-file", "telegram-send-voice", "weather"]) assert.ok(resources.some((item) => item.uri === `cyberboss://docs/${uri}`));
  const reads = mcp([{ id: 1, method: "resources/read", params: { uri: "cyberboss://tools/index" } }, { id: 2, method: "resources/read", params: { uri: "cyberboss://tools/weather" } }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true" });
  assert.equal(reads[0].result.contents[0].text.includes(JSON.stringify(PROJECT_TOOLS.find((item) => item.name === "weather").inputSchema)), false);
  assert.match(reads[1].error.message, /Unknown resource/); assertNoPrivateText(enabledOutput); assertNoPrivateText(reads);
});

test("A2/A3/A5/A17 manifest exactly matches T01 classification, marks compatibility entries, and has explicit risk", () => {
  const entries = manifest(); const t01 = buildCatalog().items;
  assert.deepEqual(entries.map((entry) => [entry.id, entry.category]), t01.map((entry) => [entry.name, entry.category]));
  assert.equal(Object.keys(TOOL_RISKS).length, PROJECT_TOOLS.length + 5);
  for (const entry of entries) { assert.ok(["read", "append", "send", "mutate", "admin"].includes(entry.risk)); assert.equal(entry.max_result_bytes, null); }
  for (const name of ["location_debug_snapshot", "location_event_dashboard"]) assert.equal(entries.find((entry) => entry.id === name).hidden, true);
  for (const name of ["whereabouts_current_stay", "whereabouts_recent_stays", "whereabouts_recent_moves", "whereabouts_snapshot", "whereabouts_summary"]) assert.equal(entries.find((entry) => entry.id === name).deprecated, true);
  assert.throws(() => buildManifest({ projectTools: [{ name: "unclassified-test", topics: [], inputSchema: {} }] }), (error) => assertCode(error, "catalog_unclassified_entry"));
});

test("A4/A7 D13 floor schemas and calls remain available; aliases canonicalize before gate", async () => enabled(async () => {
  const catalog = host(); const entries = catalog.catalogState().entries;
  for (const name of ["memory_lookup", "memory_note", "cyberboss_reminder", "cyberboss_diary_append", "cyberboss_system_send", "cyberboss_time"]) {
    const entry = entries.find((item) => item.id === name); assert.ok(entry); const loaded = await catalog.invokeTool(`cyberboss_catalog_${entry.category}`, { handle: entry.schema_handle }); assert.deepEqual(loaded.data.inputSchema, PROJECT_TOOLS.find((tool) => tool.name === name).inputSchema);
  }
  await catalog.invokeTool("memory_lookup", { query: "test", trigger: "user_pull", reason: "test" }); await catalog.invokeTool("memory_note", { text: "test" });
  await catalog.invokeTool("cyberboss_reminder", { command: "create", text: "test", delayMinutes: 1 }); await catalog.invokeTool("cyberboss_diary_append", { text: "test" });
  await catalog.invokeTool("cyberboss_system_send", { text: "test" }); await catalog.invokeTool("cyberboss_time", {});
  const restricted = host("chat-core@1"); const reminder = await restricted.invokeTool("cyberboss_reminder_create", { text: "test", delayMinutes: 1 }); assert.equal(reminder.data.command, "create");
  await restricted.invokeTool("memory.lookup", { query: "test", trigger: "user_pull", reason: "test" });
  await assert.rejects(() => restricted.invokeTool("weather_raw", {}), (error) => assertCode(error, "catalog_tool_not_in_toolset"));
}));

test("A6/A8/A10 stdio and in-process paths fail closed with stable catalog reasons", async () => enabled(async () => {
  const restricted = host("chat-core@1"); const weather = restricted.catalogState().entries.find((entry) => entry.id === "weather"); assert.equal(weather.authorized, false);
  await assert.rejects(() => restricted.invokeTool("weather", {}), (error) => assertCode(error, "catalog_tool_not_in_toolset"));
  await assert.rejects(() => restricted.invokeTool("cyberboss_catalog_tool", { handle: "tool/weather" }), (error) => assertCode(error, "catalog_schema_not_authorized"));
  for (const [category, handle, code] of [["tool", "tool/missing", "catalog_unknown_handle"], ["tool", "not-a-handle", "catalog_invalid_handle"], ["memory", "tool/weather", "catalog_handle_category_mismatch"]]) await assert.rejects(() => restricted.invokeTool(`cyberboss_catalog_${category}`, { handle }), (error) => assertCode(error, code));
  assert.throws(() => resolveToolset("unknown@1"), (error) => assertCode(error, "catalog_unknown_toolset"));
  assert.throws(() => resolveToolset("duplicate@1", {}, { "duplicate@1": ["weather", "weather"] }), (error) => assertCode(error, "catalog_duplicate_toolset_member"));
  await assert.rejects(() => restricted.invokeTool("invented_tool", {}), /Unknown tool/); await assert.rejects(() => restricted.invokeTool("tool/weather", {}), /Unknown tool/);
  const rpc = mcp([{ id: 1, method: "tools/call", params: { name: "weather", arguments: {} } }, { id: 2, method: "tools/call", params: { name: "cyberboss_catalog_tool", arguments: { handle: "tool/weather" } } }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", TEST_TOOLSET: "chat-core@1" });
  assert.match(rpc[0].result.content[0].text, /catalog_tool_not_in_toolset/); assert.equal(rpc[0].result.isError, true); assert.match(rpc[1].result.content[0].text, /catalog_schema_not_authorized/);
}));

test("A9 tools/call passes the exact startup route token through real stdio", () => {
  const token = "0123456789abcdef"; const rpc = mcp([{ id: 1, method: "tools/call", params: { name: "cyberboss_system_send", arguments: { text: "test" } } }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", TEST_ROUTE_TOKEN: token });
  assert.equal(JSON.parse(rpc[0].result.content[0].text.split("\n").slice(1).join("\n")).routeToken, token);
});

test("A16 CLI rejects toolset while catalog flag is off", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cli-"));
  try {
    const env = { ...process.env, CYBERBOSS_CHANNEL: "telegram", CYBERBOSS_RUNTIME: "claudecode", CYBERBOSS_TELEGRAM_BOT_TOKEN: "fake-token", CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS: "1", CYBERBOSS_TOOL_CATALOG_ENABLED: "false", CYBERBOSS_STATE_DIR: path.join(temp, "state"), CYBERBOSS_MEMORY_DIR: path.join(temp, "memory"), CYBERBOSS_WORKSPACE: path.join(temp, "workspace"), CYBERBOSS_CONFIG_DIR: path.join(temp, "config"), CYBERBOSS_CONTINUITY_DIR: path.join(temp, "continuity"), CYBERBOSS_PROMPT_FILE: path.join(temp, "prompt.md") };
    for (const dir of [env.CYBERBOSS_STATE_DIR, env.CYBERBOSS_MEMORY_DIR, env.CYBERBOSS_WORKSPACE, env.CYBERBOSS_CONFIG_DIR, env.CYBERBOSS_CONTINUITY_DIR]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(env.CYBERBOSS_PROMPT_FILE, "test", "utf8");
    const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/cyberboss.js"), "tool-mcp-server", "--workspace-root", temp, "--toolset", "chat-core@1"], { encoding: "utf8", env });
    assertFailedClosed(result, "disabled catalog must reject --toolset"); assert.match(`${result.stderr}${result.stdout}`, /catalog_disabled_toolset_not_accepted/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("privacy canary never appears in manifest, stdio, metering, errors, or fixtures", () => withEnv({ CATALOG_TEST_SECRET: plantedValue }, () => {
  const values = [manifest(), mcp([{ id: 1, method: "tools/list" }, { id: 2, method: "resources/list" }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CATALOG_TEST_SECRET: plantedValue }), buildCatalog(), fs.readFileSync(path.join(__dirname, "fixtures/catalog-metering-resident.json"), "utf8")];
  try { findSchema({ entries: [], category: "tool", handle: "tool/missing" }); } catch (error) { values.push(error.message); }
  for (const value of values) assertNoPrivateText(value);
}));
