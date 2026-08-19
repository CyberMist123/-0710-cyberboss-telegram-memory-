"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildCatalog, buildResidentCatalog } = require("../scripts/audit/catalog-metering");
const { resolveAppTimezone } = require("../src/utils/app-timezone");
const {
  ProjectToolHost, PROJECT_TOOLS, TOOL_ALIASES, DEPRECATED_HIDDEN_TOOL_NAMES,
  createExtraToolHosts, registeredProjectTools,
} = require("../src/tools/tool-host");
const {
  TOOL_RISKS, TOOL_THEMES, THEME_DEFINITIONS, CATALOG_INPUT_SCHEMA,
  buildManifest, catalogEnabled, findSchema, resolveToolset, subjectSigningEnabled,
} = require("../src/tools/tool-catalog-manifest");
const { truncateToolResult } = require("../src/tools/mcp-stdio-server");

const plantedValue = "planted-nondisclosure-canary-0000";
const privatePatterns = [/[A-Za-z]:[\\/]/, /\/home\/[A-Za-z0-9_.-]+/, /\/Users\/[A-Za-z0-9_.-]+/, /(sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/];
const themeSnapshot = [
  "表达行动(8)   想跟你说话、发文件、发语音、发贴纸时来这——她伸出手的那一面",
  "感知(8)   你和世界的状态：天气、位置；将来健康、手机使用、可穿戴、日常活动 MCP 全进这",
  "记忆(3)   翻过去（Episodes/账本都从这个把手进）、留笔记",
  "生活记录(4)   记日记、设提醒",
  "作息(1)   睡眠模式",
  "工程派活(4)   GitHub 操作；将来 Route 1 派工程车也在这",
  "维护调试(3)   平时不碰",
].join("\n");

function services() {
  return {
    memoryLookup: { lookup: () => ({ hits: [], empty: true }) }, memoryNote: { note: () => ({ id: "note-test" }) },
    reminder: { create: async (args) => ({ id: "reminder-test", command: args.command }) },
    diary: { append: async () => ({ filePath: "diary-test" }) }, system: { queueMessage: (_args, context) => ({ id: "system-test", routeToken: context.routeToken }) }, weather: { getRaw: async () => ({ query: { value: "test" }, extensions: "all" }) }, whereabouts: {},
  };
}
function host(toolset = "", overrides = {}) {
  return new ProjectToolHost({
    services: { ...services(), ...(overrides.services || {}) },
    runtimeContextStore: overrides.runtimeContextStore || { load() {}, resolveActiveContext() { return {}; } },
    toolset,
  });
}
function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  try { const value = run(); return value && typeof value.then === "function" ? value.finally(restore) : (restore(), value); } catch (error) { restore(); throw error; }
}
function enabled(run, toolset = undefined) { return withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_TOOL_CATALOG_TOOLSET: toolset, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, run); }
function signingEnabled(run, catalog = "true") { return withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: catalog, CYBERBOSS_SUBJECT_SIGNING_ENABLED: "true" }, run); }
function manifest(toolset = null) { return buildManifest({ projectTools: registeredProjectTools(), aliases: TOOL_ALIASES, extraHosts: createExtraToolHosts({ whereabouts: {} }), deprecatedNames: DEPRECATED_HIDDEN_TOOL_NAMES, toolset }); }
function assertCode(error, code) { assert.equal(error?.code, code); return true; }
function assertNoPrivateText(value) { const text = typeof value === "string" ? value : JSON.stringify(value); const withoutUriSchemes = text.replace(/[a-z]+:\/\//gi, ""); for (const pattern of privatePatterns) assert.doesNotMatch(withoutUriSchemes, pattern); if (process.env.USERNAME) assert.equal(text.includes(process.env.USERNAME), false); assert.equal(text.includes(plantedValue), false); }
function assertFailedClosed(result, message) { assert.equal(result.error, undefined, `process never ran: ${result.error}`); assert.notEqual(result.status, null, "process never ran: spawnSync returned status null"); assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`); }

const serverProgram = String.raw`
const { ProjectToolHost } = require("./src/tools/tool-host");
const { runToolMcpServer } = require("./src/tools/mcp-stdio-server");
const base = { memoryLookup:{lookup:()=>({hits:[],empty:true})}, memoryNote:{note:()=>({id:"note-test"})}, reminder:{create:async(args)=>({id:"reminder-test",command:args.command})}, diary:{append:async()=>({filePath:"diary-test"})}, system:{queueMessage:(args,context)=>({id:"system-test",routeToken:context.routeToken})}, whereabouts:{} };
if (process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED === "true") {
  let calls = 0;
  base.subjectSigningBroker = {submit:async()=>{calls++; if(calls > 1){const error=new Error("capability_expired");error.code="capability_expired";throw error;} return {status:"created",candidate_id:"component-only",idempotency_key:"component-only"};}};
}
const toolHost = new ProjectToolHost({ services:base, runtimeContextStore:{load(){},resolveActiveContext(){return {threadId:"thread-subject",turnId:"turn-subject"}}}, toolset:process.env.TEST_TOOLSET||"" });
runToolMcpServer({toolHost,runtimeId:"test",workspaceRoot:"workspace-test",routeToken:process.env.TEST_ROUTE_TOKEN||""});`;
function mcp(messages, env = {}) {
  const input = messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n";
  const result = spawnSync(process.execPath, ["-e", serverProgram], { cwd: path.join(__dirname, ".."), input, encoding: "utf8", env: { ...process.env, CYBERBOSS_TOOL_CATALOG_ENABLED: undefined, CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined, ...env } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("A1/A2 flag-off is exact and enabled surface is one minimal catalog plus two residents", () => {
  withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: undefined, CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, () => {
    assert.equal(catalogEnabled(), false); const baseline = host().listTools();
    withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "false" }, () => assert.deepEqual(host().listTools(), baseline));
  });
  enabled(() => {
    const tools = host().listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["cyberboss_catalog", "cyberboss_system_send", "cyberboss_time"]);
    assert.deepEqual(tools[0].inputSchema, CATALOG_INPUT_SCHEMA);
    assert.deepEqual(CATALOG_INPUT_SCHEMA, { type: "object", properties: { theme: { type: "string" }, handle: { type: "string" }, arguments: { type: "object" } }, additionalProperties: false });
    assert.ok(JSON.stringify(tools[0].inputSchema).length <= 160);
    for (const tool of tools.slice(1)) assert.deepEqual(tool.inputSchema, PROJECT_TOOLS.find((item) => item.name === tool.name).inputSchema);
  });
});

test("T07 A5/A8 max_result_bytes is per tool and schema estimates come from the actual tools/list schemas", () => {
  withEnv({ CYBERBOSS_ROUTE2_GATE_ENABLED: "true" }, () => {
    const toolHost = host();
    const listed = toolHost.listTools();
    const entries = toolHost.catalogState().entries.filter((entry) => !entry.alias_of);
    const time = entries.find((entry) => entry.id === "cyberboss_time");
    const send = entries.find((entry) => entry.id === "cyberboss_system_send");
    assert.equal(time.max_result_bytes, 2048);
    assert.equal(send.max_result_bytes, null);
    for (const tool of listed) {
      const entry = entries.find((candidate) => candidate.id === tool.name);
      assert.ok(entry, `manifest entry missing for ${tool.name}`);
      assert.equal(entry.estimated_schema_chars, JSON.stringify(tool.inputSchema || {}).length);
    }
  });
});

test("T07 A6 server-side result truncation is UTF-8 safe and never exceeds the tool budget", () => {
  const result = truncateToolResult("假数据".repeat(100), 37);
  assert.ok(Buffer.byteLength(result, "utf8") <= 37);
  assert.match(result, /\[truncated\]$/);
  assert.doesNotMatch(result, /�/);

  const program = String.raw`
    const { runToolMcpServer } = require("./src/tools/mcp-stdio-server");
    runToolMcpServer({ toolHost: {
      listTools() { return [{ name: "fake_bounded", description: "fixture", inputSchema: { type: "object" } }]; },
      maxResultBytes(name) { return name === "fake_bounded" ? 37 : null; },
      async invokeTool() { return { text: "假数据".repeat(100) }; },
    }});`;
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fake_bounded", arguments: {} } })}\n`;
  const child = spawnSync(process.execPath, ["-e", program], { cwd: path.join(__dirname, ".."), input, encoding: "utf8" });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.trim());
  const returned = response.result.content[0].text;
  assert.ok(Buffer.byteLength(returned, "utf8") <= 37);
  assert.match(returned, /\[truncated\]$/);
});

test("A1 flag-off leaves legacy invocation and real stdio tools/resources byte-compatible", async () => withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "false", CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, async () => {
  const result = await host("chat-core@1").invokeTool("weather_raw", {}); assert.equal(result.data.extensions, "all");
  const requests = [{ id: 1, method: "initialize", params: {} }, { id: 2, method: "tools/list" }, { id: 3, method: "resources/list" }];
  assert.deepEqual(mcp(requests, { CYBERBOSS_TOOL_CATALOG_ENABLED: "false" }), mcp(requests));
}));

test("A3 theme index is an exact seven-line snapshot and excludes aliases and hidden entries", async () => enabled(async () => {
  const result = await host().invokeTool("cyberboss_catalog", {});
  assert.equal(result.text, themeSnapshot);
  assert.deepEqual(result.data.map((item) => item.name), THEME_DEFINITIONS.map((item) => item.name));
  assert.equal(result.data.reduce((sum, item) => sum + item.count, 0), manifest().filter((entry) => !entry.alias_of && !entry.hidden).length);
}));

test("health tool is gated OFF by default and adds exactly one 感知 entry when CYBERBOSS_HEALTH_ENABLED is on", async () => {
  // Default OFF: no CYBERBOSS_HEALTH_ENABLED => health absent, 感知 stays at 8
  // and the theme index is byte-identical to the seven-line snapshot above.
  await enabled(async () => {
    assert.equal(registeredProjectTools().some((tool) => tool.name === "health"), false);
    const off = await host().invokeTool("cyberboss_catalog", {});
    assert.equal(off.text, themeSnapshot);
    assert.equal(off.data.find((item) => item.name === "感知").count, 8);
    await assert.rejects(
      () => host().invokeTool("cyberboss_catalog", { handle: "tool/health" }),
      (error) => assertCode(error, "catalog_unknown_handle"),
    );
  });
  // Flag on: health registers, 感知 becomes 9, and the entry is a read tool
  // under 感知 whose schema is loadable through the catalog.
  await withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_HEALTH_ENABLED: "1", CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, async () => {
    assert.equal(registeredProjectTools().some((tool) => tool.name === "health"), true);
    const index = await host().invokeTool("cyberboss_catalog", {});
    assert.equal(index.data.find((item) => item.name === "感知").count, 9);
    const perception = await host().invokeTool("cyberboss_catalog", { theme: "感知" });
    const health = perception.data.find((entry) => entry.id === "health");
    assert.ok(health, "health entry present in 感知 when enabled");
    assert.equal(health.risk, "read");
    assert.equal(health.theme, "感知");
    const loaded = await host().invokeTool("cyberboss_catalog", { handle: "tool/health" });
    assert.deepEqual(loaded.data.inputSchema, PROJECT_TOOLS.find((tool) => tool.name === "health").inputSchema);
  });
});

test("A4 theme lists are canonical-only with risk while hidden/deprecated handles remain queryable and marked", async () => enabled(async () => {
  const catalog = host();
  const memory = await catalog.invokeTool("cyberboss_catalog", { theme: "记忆" });
  assert.deepEqual(memory.data.map((entry) => entry.id), ["episode_annotate", "memory_lookup", "memory_note"]);
  assert.ok(memory.data.every((entry) => entry.risk));
  const expression = await catalog.invokeTool("cyberboss_catalog", { theme: "表达行动" });
  assert.ok(expression.data.some((entry) => entry.id === "cyberboss_telegram_send"));
  assert.ok(expression.data.some((entry) => entry.id === "cyberboss_sticker_send"));
  assert.equal(expression.data.some((entry) => entry.alias_of), false);
  const hidden = await catalog.invokeTool("cyberboss_catalog", { handle: "tool/location_debug_snapshot" });
  const deprecated = await catalog.invokeTool("cyberboss_catalog", { handle: "mcp/whereabouts_summary" });
  assert.equal(hidden.data.entry.hidden, true); assert.equal(deprecated.data.entry.deprecated, true);
}));

test("A5/A6 handle lookup and request validation retain every fail-closed code", async () => enabled(async () => {
  const catalog = host("chat-core@1");
  const weather = catalog.catalogState().entries.find((entry) => entry.id === "weather"); assert.equal(weather.authorized, false);
  await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "tool/weather" }), (error) => assertCode(error, "catalog_schema_not_authorized"));
  await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "tool/missing" }), (error) => assertCode(error, "catalog_unknown_handle"));
  await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "not-a-handle" }), (error) => assertCode(error, "catalog_invalid_handle"));
  await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { theme: "记忆", handle: "memory/memory_lookup" }), (error) => assertCode(error, "catalog_invalid_request"));
  await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { theme: "不存在" }), (error) => assertCode(error, "catalog_unknown_theme"));
  assert.throws(() => findSchema({ entries: manifest(), category: "memory", handle: "tool/weather" }), (error) => assertCode(error, "catalog_handle_category_mismatch"));
  assert.throws(() => findSchema({ entries: [{ schema_handle: "tool/x", category: "tool", authorized: true }, { schema_handle: "tool/x", category: "tool", authorized: true }], category: "tool", handle: "tool/x" }), (error) => assertCode(error, "catalog_duplicate_handle"));
}));

test("A7 real stdio exposes three tools and supports theme and direct-handle catalog calls", () => {
  const rpc = mcp([
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { theme: "记忆" } } },
    { id: 3, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { handle: "memory/memory_lookup" } } },
  ], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true" });
  assert.deepEqual(rpc[0].result.tools.map((tool) => tool.name), ["cyberboss_catalog", "cyberboss_system_send", "cyberboss_time"]);
  assert.match(rpc[1].result.content[0].text, /memory_lookup/); assert.match(rpc[2].result.content[0].text, /Schema loaded: memory\/memory_lookup/);
  const resources = mcp([{ id: 1, method: "resources/list" }, { id: 2, method: "resources/read", params: { uri: "cyberboss://tools/weather" } }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true" });
  assert.deepEqual(resources[0].result.resources.filter((item) => item.uri.startsWith("cyberboss://tools/")).map((item) => item.uri), ["cyberboss://tools/index", "cyberboss://tools/cyberboss_system_send", "cyberboss://tools/cyberboss_time"]);
  assert.match(resources[1].error.message, /Unknown resource/);
  // The index is the manual: it must document the call shape, not only the
  // schema-load shape, or the D34 seam stays invisible to her.
  const index = mcp([{ id: 1, method: "resources/read", params: { uri: "cyberboss://tools/index" } }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true" })[0].result.contents[0].text;
  assert.match(index, /"arguments"/);
  assert.match(index, /call that tool/);
  for (const definition of THEME_DEFINITIONS) assert.match(index, new RegExp(definition.name));
});

test("A8 toolset discovery is not invocation authority and aliases canonicalize before the gate", async () => enabled(async () => {
  const restricted = host("chat-core@1");
  await restricted.invokeTool("memory.lookup", { query: "test", trigger: "user_pull", reason: "test" });
  await assert.rejects(() => restricted.invokeTool("weather_raw", {}), (error) => assertCode(error, "catalog_tool_not_in_toolset"));
  assert.throws(() => resolveToolset("unknown@1"), (error) => assertCode(error, "catalog_unknown_toolset"));
  assert.throws(() => resolveToolset("duplicate@1", {}, { "duplicate@1": ["weather", "weather"] }), (error) => assertCode(error, "catalog_duplicate_toolset_member"));
}));

test("A9 D13 floor remains discoverable, schema-loadable and callable without a toolset", async () => enabled(async () => {
  const catalog = host(); const entries = catalog.catalogState().entries;
  for (const name of ["memory_lookup", "memory_note", "cyberboss_reminder", "cyberboss_diary_append", "cyberboss_system_send", "cyberboss_time"]) {
    const entry = entries.find((item) => item.id === name); assert.ok(entry);
    const loaded = await catalog.invokeTool("cyberboss_catalog", { handle: entry.schema_handle });
    assert.deepEqual(loaded.data.inputSchema, PROJECT_TOOLS.find((tool) => tool.name === name).inputSchema);
  }
  await catalog.invokeTool("memory_lookup", { query: "test", trigger: "user_pull", reason: "test" }); await catalog.invokeTool("memory_note", { text: "test" });
  await catalog.invokeTool("cyberboss_reminder", { command: "create", text: "test", delayMinutes: 1 }); await catalog.invokeTool("cyberboss_diary_append", { text: "test" });
  await catalog.invokeTool("cyberboss_system_send", { text: "test" }); await catalog.invokeTool("cyberboss_time", {});
}));

test("T08 A8 expired lease keeps both catalog levels visible but schema and call double-reject", async () => withEnv({
  CYBERBOSS_TOOL_CATALOG_ENABLED: "true",
  CYBERBOSS_ROUTE2_GATE_ENABLED: "true",
}, async () => {
  const expired = new ProjectToolHost({
    services: services(),
    runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
    route2Lease: {
      id: "lease-expired-fake",
      status: "revoked",
      expiresAt: Date.now() - 1,
      toolNames: ["cyberboss_time"],
    },
  });
  const levelOne = await expired.invokeTool("cyberboss_catalog", {});
  const levelTwo = await expired.invokeTool("cyberboss_catalog", { theme: "感知" });
  assert.equal(levelOne.data.some((entry) => entry.name === "感知"), true);
  assert.equal(levelTwo.data.some((entry) => entry.id === "cyberboss_time"), true);
  await assert.rejects(
    () => expired.invokeTool("cyberboss_catalog", { handle: "tool/cyberboss_time" }),
    (error) => assertCode(error, "capability_lease_expired"),
  );
  await assert.rejects(
    () => expired.invokeTool("cyberboss_time", {}),
    (error) => assertCode(error, "capability_lease_expired"),
  );
}));

test("T08 A14 Route 2 flag off leaves schema and invocation behavior identical despite lease input", async () => withEnv({
  CYBERBOSS_TOOL_CATALOG_ENABLED: "true",
  CYBERBOSS_ROUTE2_GATE_ENABLED: undefined,
}, async () => {
  const disabled = new ProjectToolHost({
    services: services(),
    runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
    route2Lease: { status: "revoked", expiresAt: 1, toolNames: ["cyberboss_time"] },
  });
  const schema = await disabled.invokeTool("cyberboss_catalog", { handle: "tool/cyberboss_time" });
  const call = await disabled.invokeTool("cyberboss_time", {});
  assert.equal(schema.data.entry.id, "cyberboss_time");
  assert.ok(call.text);
}));

test("B1 signing gate off omits submit from legacy surface, themed catalog, and stdio", async () => enabled(async () => {
  assert.equal(host().catalogState().entries.some((entry) => entry.id === "memory_candidate_submit"), false);
  const memory = await host().invokeTool("cyberboss_catalog", { theme: "记忆" }); assert.equal(memory.data.some((entry) => entry.id === "memory_candidate_submit"), false);
  assert.equal(mcp([{ id: 1, method: "tools/list" }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "false" })[0].result.tools.some((tool) => tool.name === "memory_candidate_submit"), false);
}));

test("B2/B4 signing gate on keeps the model schema narrow; synthetic stdio only proves broker result/error relay", async () => signingEnabled(async () => {
  assert.equal(host().catalogState().entries.find((entry) => entry.id === "memory_candidate_submit")?.theme, "记忆");
  const loaded = await host().invokeTool("cyberboss_catalog", { handle: "memory/memory_candidate_submit" });
  assert.deepEqual(loaded.data.inputSchema, PROJECT_TOOLS.find((tool) => tool.name === "memory_candidate_submit").inputSchema);
  // No source_ref: provenance comes from the turn, not the model.
  const args = { type: "episode", body: "这一刻由我自己留下。", origin: "live_subject" };
  const rpc = mcp([
    { id: 1, method: "tools/call", params: { name: "memory_candidate_submit", arguments: args } },
    { id: 2, method: "tools/call", params: { name: "memory_candidate_submit", arguments: { ...args, body: "第二次不该通过。" } } },
  ], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_SUBJECT_SIGNING_ENABLED: "true" });
  assert.equal(rpc[0].result.isError, undefined); assert.match(rpc[0].result.content[0].text, /Memory candidate created/);
  assert.equal(rpc[1].result.isError, true); assert.match(rpc[1].result.content[0].text, /^capability_expired:/);
  assert.deepEqual(Object.keys(PROJECT_TOOLS.find((tool) => tool.name === "memory_candidate_submit").inputSchema.properties).sort(), ["body", "material_pack", "material_pack_id", "origin", "rewrite_handoff_id", "rewrite_of_decision_id", "supersedes_candidate_id", "type"]);
  assert.equal(PROJECT_TOOLS.find((tool) => tool.name === "memory_candidate_submit").inputSchema.additionalProperties, false);
  // A child that still tries to assert its own provenance is rejected by the
  // schema rather than having the field quietly ignored.
  const forged = mcp([
    { id: 1, method: "tools/call", params: { name: "memory_candidate_submit", arguments: { ...args, source_ref: { content_sha256: "a".repeat(64) } } } },
  ], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_SUBJECT_SIGNING_ENABLED: "true" });
  assert.equal(forged[0].result.isError, true);
}));
test("B3 handler has no local writable fallback and relays the broker's explicit code", async () => signingEnabled(async () => {
  const args = { type: "episode", body: "候选正文", origin: "live_subject" };
  await assert.rejects(() => host().invokeTool("memory_candidate_submit", args), (error) => assertCode(error, "subject_signing_broker_unavailable"));
  const expired = host("", { services: { subjectSigningBroker: { submit: async () => { const error = new Error("capability_expired"); error.code = "capability_expired"; throw error; } } } });
  await assert.rejects(() => expired.invokeTool("memory_candidate_submit", args), (error) => assertCode(error, "capability_expired"));
}));

test("A1 CLI rejects toolset while catalog flag is off", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cli-"));
  try {
    const env = { ...process.env, CYBERBOSS_CHANNEL: "telegram", CYBERBOSS_RUNTIME: "claudecode", CYBERBOSS_TELEGRAM_BOT_TOKEN: "fake-token", CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS: "1", CYBERBOSS_TOOL_CATALOG_ENABLED: "false", CYBERBOSS_STATE_DIR: path.join(temp, "state"), CYBERBOSS_MEMORY_DIR: path.join(temp, "memory"), CYBERBOSS_WORKSPACE: path.join(temp, "workspace"), CYBERBOSS_CONFIG_DIR: path.join(temp, "config"), CYBERBOSS_CONTINUITY_DIR: path.join(temp, "continuity"), CYBERBOSS_PROMPT_FILE: path.join(temp, "prompt.md") };
    for (const dir of [env.CYBERBOSS_STATE_DIR, env.CYBERBOSS_MEMORY_DIR, env.CYBERBOSS_WORKSPACE, env.CYBERBOSS_CONFIG_DIR, env.CYBERBOSS_CONTINUITY_DIR]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(env.CYBERBOSS_PROMPT_FILE, "test", "utf8");
    const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/cyberboss.js"), "tool-mcp-server", "--workspace-root", temp, "--toolset", "chat-core@1"], { encoding: "utf8", env });
    assertFailedClosed(result, "disabled catalog must reject --toolset"); assert.match(`${result.stderr}${result.stdout}`, /catalog_disabled_toolset_not_accepted/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("deployment form =1 is honoured by every reader, in-process and across the MCP boundary", () => {
  // 2026-08-05 首轮 canary 的病：telegram.env 写 `=1`（仓库惯例），bridge 判开
  // 并往子进程转发字符串 "true"，子进程 loadEnv(override) 又把它换回 `1`，
  // 而子进程这一侧当时用的是 `=== "true"` —— 同一个开关，两套真值口径，
  // memory_candidate_submit 因此永远注册不上。
  withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "1", CYBERBOSS_SUBJECT_SIGNING_ENABLED: "1", CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined }, () => {
    assert.equal(catalogEnabled(), true, "catalog must be on for the deployment's =1 form");
    assert.equal(registeredProjectTools().some((tool) => tool.name === "memory_candidate_submit"), true);
    assert.deepEqual(
      manifest().filter((entry) => entry.theme === "记忆" && !entry.alias_of).map((entry) => entry.id).sort(),
      ["episode_annotate", "memory_candidate_submit", "memory_lookup", "memory_note"],
    );
  });
  // 真跨进程：与生产同形状（env 写 =1）起一个真的 tool server 问目录
  const on = mcp(
    [{ id: 1, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { theme: "记忆" } } }],
    { CYBERBOSS_TOOL_CATALOG_ENABLED: "1", CYBERBOSS_SUBJECT_SIGNING_ENABLED: "1" },
  );
  assert.equal(JSON.stringify(on).includes("memory_candidate_submit"), true,
    "the signing tool must reach the catalog when the deployment writes =1");
  // 关掉必须真的消失，否则上面那条断言是恒真的
  const off = mcp(
    [{ id: 1, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { theme: "记忆" } } }],
    { CYBERBOSS_TOOL_CATALOG_ENABLED: "1", CYBERBOSS_SUBJECT_SIGNING_ENABLED: "0" },
  );
  assert.equal(JSON.stringify(off).includes("memory_candidate_submit"), false);
  // 口径本身：四种写法都认，其余一律不认（catalogEnabled 曾是同一颗雷——
  // 它只是侥幸没被 env 文件覆盖过）
  for (const value of ["1", "true", "TRUE", " on ", "yes"]) {
    assert.equal(catalogEnabled({ CYBERBOSS_TOOL_CATALOG_ENABLED: value }), true, `catalogEnabled(${value})`);
    assert.equal(subjectSigningEnabled({ CYBERBOSS_SUBJECT_SIGNING_ENABLED: value }), true, `subjectSigningEnabled(${value})`);
  }
  for (const value of ["0", "false", "no", "off", "", "  ", undefined]) {
    assert.equal(catalogEnabled({ CYBERBOSS_TOOL_CATALOG_ENABLED: value }), false, `catalogEnabled(${String(value)})`);
    assert.equal(subjectSigningEnabled({ CYBERBOSS_SUBJECT_SIGNING_ENABLED: value }), false, `subjectSigningEnabled(${String(value)})`);
  }
});

// D34 catalog invoke: MCP only lets the CLI call a tool that tools/list has
// broadcast, and the broadcast surface is three tools with listChanged:false.
// Before this seam every non-resident tool was visible in the catalog and
// permanently unreachable. Each case below re-proves one existing gate still
// binds on the forwarded hop, so the seam adds reach, not authority.
test("T-A invoke reaches resident and non-resident tools through the one broadcast entry", async () => enabled(async () => {
  const catalog = host();
  const time = await catalog.invokeTool("cyberboss_catalog", { handle: "tool/cyberboss_time", arguments: {} });
  assert.match(time.text, /\d{2}:\d{2}:\d{2}/);
  assert.equal(time.data.timezone, resolveAppTimezone());

  // memory_lookup is in chat-core@1 but is not resident: it never appears in
  // tools/list, so this call is only possible through the catalog.
  const restricted = host("chat-core@1");
  assert.equal(restricted.listTools().some((tool) => tool.name === "memory_lookup"), false);
  const lookup = await restricted.invokeTool("cyberboss_catalog", {
    handle: "memory/memory_lookup",
    arguments: { query: "test", trigger: "user_pull", reason: "test" },
  });
  assert.match(lookup.text, /no matching record/);
  assert.deepEqual(lookup.data.hits, []);

  // The forwarded result is passed through untouched, not re-wrapped.
  const direct = await restricted.invokeTool("memory_lookup", { query: "test", trigger: "user_pull", reason: "test" });
  assert.deepEqual(lookup, direct);

  // Argument validation is the target tool's own schema, run server side.
  await assert.rejects(
    () => restricted.invokeTool("cyberboss_catalog", { handle: "memory/memory_lookup", arguments: { trigger: "user_pull", reason: "test" } }),
    /memory_lookup input\.query is required/,
  );
}));

test("T-A invoke keeps the toolset gate and still records self-escalation", async () => enabled(async () => {
  await assert.rejects(
    () => host("chat-core@1").invokeTool("cyberboss_catalog", { handle: "tool/weather", arguments: { command: "raw" } }),
    (error) => assertCode(error, "catalog_tool_not_in_toolset"),
  );

  const escalations = [];
  const escalating = new ProjectToolHost({
    services: services(),
    runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
    toolset: "chat-core@1",
    chatSelfEscalation: true,
    onSelfEscalation: (event) => escalations.push(event),
  });
  const weather = await escalating.invokeTool("cyberboss_catalog", { handle: "tool/weather", arguments: { command: "raw" } });
  assert.equal(weather.data.extensions, "all");
  assert.deepEqual(escalations.map((event) => [event.type, event.toolset, event.tool]), [["toolset_self_escalation", "chat-core@1", "weather"]]);
}));

test("T-A invoke fails closed on lease, request shape, and unknown handles", async () => {
  await withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CYBERBOSS_ROUTE2_GATE_ENABLED: "true" }, async () => {
    const expired = new ProjectToolHost({
      services: services(),
      runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
      route2Lease: { id: "lease-expired-fake", status: "revoked", expiresAt: Date.now() - 1, toolNames: ["cyberboss_time"] },
    });
    await assert.rejects(
      () => expired.invokeTool("cyberboss_catalog", { handle: "tool/cyberboss_time", arguments: {} }),
      (error) => assertCode(error, "capability_lease_expired"),
    );
    // The forwarded tool's own byte budget applies, not the catalog entry's.
    assert.equal(expired.maxResultBytes("cyberboss_catalog", { handle: "tool/cyberboss_time", arguments: {} }), 2048);
    assert.equal(expired.maxResultBytes("cyberboss_catalog", { handle: "tool/cyberboss_time" }), null);
    assert.equal(expired.maxResultBytes("cyberboss_catalog", { theme: "感知" }), null);
  });
  await enabled(async () => {
    const catalog = host();
    for (const args of [{ theme: "感知", arguments: {} }, { arguments: {} }]) {
      await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", args), (error) => assertCode(error, "catalog_invalid_request"));
    }
    await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "tool/missing", arguments: {} }), (error) => assertCode(error, "catalog_unknown_handle"));
    await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "not-a-handle", arguments: {} }), (error) => assertCode(error, "catalog_invalid_handle"));
    // A tool is reachable only under its own category prefix.
    await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "tool/memory_lookup", arguments: {} }), (error) => assertCode(error, "catalog_unknown_handle"));
    await assert.rejects(() => catalog.invokeTool("cyberboss_catalog", { handle: "tool/cyberboss_time", arguments: [] }), /cyberboss_catalog input\.arguments must be an object/);
  });
});

test("T-A real stdio calls a never-broadcast tool through the catalog and keeps the surface at three", () => {
  // Responses are indexed by id: forwarded calls resolve asynchronously, so the
  // server may answer a later message first.
  const rpc = new Map(mcp([
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { handle: "memory/memory_lookup", arguments: { query: "test", trigger: "user_pull", reason: "test" } } } },
    { id: 3, method: "tools/call", params: { name: "cyberboss_catalog", arguments: { handle: "tool/weather", arguments: { command: "raw" } } } },
    { id: 4, method: "tools/list" },
  ], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", TEST_TOOLSET: "chat-core@1" }).map((message) => [message.id, message]));
  assert.deepEqual(rpc.get(1).result.tools.map((tool) => tool.name), ["cyberboss_catalog", "cyberboss_system_send", "cyberboss_time"]);
  assert.equal(rpc.get(2).result.isError, undefined);
  assert.match(rpc.get(2).result.content[0].text, /no matching record/);
  assert.equal(rpc.get(3).result.isError, true);
  assert.match(rpc.get(3).result.content[0].text, /^catalog_tool_not_in_toolset:/);
  // listChanged:false stays honest — invoking never mutates the broadcast list.
  assert.deepEqual(rpc.get(4).result.tools, rpc.get(1).result.tools);
});

// T-B: the context swing that motivated the catalog. It doubles as the D34
// regression judge — invoke must add reach without growing the resident surface.
test("T-B catalog on/off context swing stays at three broadcast tools", () => {
  const off = withEnv({ CYBERBOSS_TOOL_CATALOG_ENABLED: undefined, CYBERBOSS_TOOL_CATALOG_TOOLSET: undefined, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, () => host().listTools());
  const on = enabled(() => host().listTools());
  assert.equal(on.length, 3);
  assert.ok(off.length >= 17, `legacy surface collapsed to ${off.length} tools`);
  const chars = (tools) => JSON.stringify(tools).length;
  assert.ok(chars(on) <= 1200, `resident surface grew to ${chars(on)} chars`);
  // 门槛随能力面走：2026-08-06 移除时间线工具包带走了 8 个大 schema，传统面由
  // 12k+ 降到 9.2k。这条测试真正的判据是下面那个摆幅倍数，绝对字数只是"传统面确实
  // 是一大片"的粗证。
  assert.ok(chars(off) >= 9000, `legacy surface shrank to ${chars(off)} chars`);
  assert.ok(chars(off) / chars(on) >= 10, `swing collapsed to ${(chars(off) / chars(on)).toFixed(1)}x`);
  const resident = buildResidentCatalog();
  assert.equal(resident.totals.resident_item_count, 3);
  assert.equal(resident.totals.resident_schema_chars, 373);
  // 15810 -> 12962：移除时间线工具包后的全量面。
  // 12962 -> 13459：日记补上 read/edit 两个工具（她此前只能写、读不回来）。
  // 13459 -> 13675：episode_annotate 附注工具加入全量面（batch/episode-md）。
  // 13675 -> 13917：合流 batch/lookup-uncap，再加 cyberboss_voice_retranscribe
  //（本机小模型转糊时换云端重听一遍）；两侧各自 +1 工具，合并后全量面 45 项。
  // 常驻面本身（3 项 / 373 字）未变——这正是目录化要守住的那个数。
  // 13917 -> 13889：把工具描述里遗留的「WeChat」字样改成通道中性（Telegram build
  // 上那是误导），四处各减 7 字。常驻面不变。
  assert.equal(resident.full_surface.schema_chars, 13889);
});

test("manifest policy and privacy canary are explicit and private-text-free", () => withEnv({ CATALOG_TEST_SECRET: plantedValue, CYBERBOSS_SUBJECT_SIGNING_ENABLED: undefined }, () => {
  const entries = manifest(); const t01 = buildCatalog().items;
  assert.deepEqual(entries.map((entry) => [entry.id, entry.category, entry.theme]), t01.map((entry) => [entry.name, entry.category, entry.theme]));
  assert.equal(Object.keys(TOOL_RISKS).length, PROJECT_TOOLS.length + 5); assert.equal(Object.keys(TOOL_THEMES).length, PROJECT_TOOLS.length + 5);
  for (const entry of entries) { assert.ok(TOOL_RISKS[entry.alias_of || entry.id]); assert.ok(TOOL_THEMES[entry.alias_of || entry.id]); }
  assert.throws(() => buildManifest({ projectTools: [{ name: "unclassified-test", topics: [], inputSchema: {} }] }), (error) => assertCode(error, "catalog_unclassified_entry"));
  const values = [entries, mcp([{ id: 1, method: "tools/list" }, { id: 2, method: "resources/list" }], { CYBERBOSS_TOOL_CATALOG_ENABLED: "true", CATALOG_TEST_SECRET: plantedValue }), buildCatalog(), fs.readFileSync(path.join(__dirname, "fixtures/catalog-metering-resident.json"), "utf8")];
  for (const value of values) assertNoPrivateText(value);
}));
