const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ContextTraceRecorder } = require("../src/core/context-trace");
const { MemoryLookupService, MAX_NON_WHITESPACE_CHARS } = require("../src/services/memory-lookup-service");
const { ProjectToolHost, listProjectToolNames } = require("../src/tools/tool-host");
const { buildCodexMcpConfigArgs } = require("../src/adapters/runtime/codex/mcp-config");

function fixture(rows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase5a-"));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "episodes.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  return { root, service: new MemoryLookupService({ continuityDir: root }) };
}

function context(overrides = {}) {
  return { provider: "telegram", accountId: "account-1", threadId: "thread-1", ...overrides };
}

test("empty lookup is honest and only documented triggers are accepted", () => {
  const { root, service } = fixture([{ ep_id: "ep-1", ts: "now", body: "only a different memory" }]);
  const empty = service.lookup({ query: "missing", trigger: "user_pull", reason: "explicit question" }, context());
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.empty, true);
  assert.equal(empty.budget_left, null);
  assert.deepEqual(service.lookup({ query: "memory", trigger: "unknown", reason: "not allowed" }, context()), { error: "invalid_trigger" });
  const logs = readJsonl(path.join(root, "recall_log.jsonl"));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].trigger, "user_pull");
});

test("memory lookup is uncapped for every trigger and survives restart (D39)", () => {
  const { root, service } = fixture([{ ep_id: "ep-1", body: "resonant old thread" }]);
  for (const trigger of ["resonance", "stakes", "repair", "user_pull"]) {
    assert.equal(service.lookup({ query: "resonant", trigger, reason: "fixture" }, context()).error, undefined);
  }
  for (let index = 0; index < 10; index += 1) {
    assert.equal(service.lookup({ query: "resonant", trigger: "repair", reason: "fixture" }, context()).error, undefined);
  }
  const restarted = new MemoryLookupService({ continuityDir: root });
  assert.equal(restarted.lookup({ query: "resonant", trigger: "resonance", reason: "fixture" }, context()).error, undefined);
  assert.deepEqual(readJsonl(path.join(root, "recall_log.jsonl")).slice(0, 2).map((row) => row.trigger), ["resonance", "stakes"]);
});

test("lookup searches relationship timeline and topic aliases without reading hidden archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase5a-sources-"));
  fs.writeFileSync(path.join(root, "episodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "relationship_timeline.md"), "# 关系年表\n\n我们一起在雨里走过老桥。\n", "utf8");
  fs.writeFileSync(path.join(root, "topics.md"), "散步: 老桥, 雨里\n", "utf8");
  fs.writeFileSync(path.join(root, "rereadings.md"), "不应被读取", "utf8");
  fs.writeFileSync(path.join(root, "ai_self_notes.md"), "也不应被读取", "utf8");
  const service = new MemoryLookupService({ continuityDir: root });
  const result = service.lookup({ query: "散步", trigger: "user_pull", reason: "fixture" }, context());
  assert.equal(result.hits[0].ep_id, "timeline-2");
  assert.match(result.hits[0].body, /老桥/u);
});

test("user_pull lookups never exhaust, across restart and scopes (D39)", () => {
  const { root, service } = fixture([]);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(service.lookup({ query: "none", trigger: "user_pull", reason: "fixture" }, context()).error, undefined);
  }
  const restarted = new MemoryLookupService({ continuityDir: root });
  assert.equal(restarted.lookup({ query: "none", trigger: "user_pull", reason: "fixture" }, context()).error, undefined);
  assert.equal(restarted.lookup({ query: "none", trigger: "user_pull", reason: "fixture" }, context({ provider: "weixin" })).error, undefined);
});

test("lookup is capped, truncates bodies, and returns superseding corrections together", () => {
  const longBody = `anchor ${"字".repeat(MAX_NON_WHITESPACE_CHARS + 20)}`;
  const { service } = fixture([
    { ep_id: "ep-old", ts: "t1", body: longBody },
    { ep_id: "ep-fix", ts: "t2", type: "correction", supersedes: "ep-old", body: "corrected account" },
    { ep_id: "ep-2", ts: "t3", body: "anchor second" },
    { ep_id: "ep-3", ts: "t4", body: "anchor third" },
  ]);
  const result = service.lookup({ query: "anchor", trigger: "user_pull", reason: "user asked about before" }, context());
  assert.equal(result.hits.length, 3);
  assert.equal(result.hits[0].ep_id, "ep-old");
  assert.equal(result.hits[0].superseded_by, "ep-fix");
  assert.match(result.hits[0].body, /\[截断,完整条目 ep-old\]$/u);
  assert.equal(result.hits[1].ep_id, "ep-fix");
  assert.ok(result.hits.every((hit) => hit.register === "lookup"));
});

test("lookup tokenizes multi-word queries and ranks all-token hits first", () => {
  const { service } = fixture([
    { ep_id: "ep-a", ts: "t1", body: "她说我说话太慢太完美，要有呼吸感" },
    { ep_id: "ep-b", ts: "t2", body: "呼吸感这个词后来又出现过一次" },
    { ep_id: "ep-c", ts: "t3", body: "完全无关的一条" },
  ]);
  const result = service.lookup({ query: "完美 呼吸感", trigger: "user_pull", reason: "她在找旧事" }, context());
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].ep_id, "ep-a");
  assert.equal(result.hits[1].ep_id, "ep-b");
});

test("lookup failure is fail-open and the tool host returns a normal result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-phase5a-fail-"));
  const service = new MemoryLookupService({ continuityDir: root, readEpisodes() { throw new Error("offline"); } });
  const host = new ProjectToolHost({
    services: { memoryLookup: service },
    runtimeContextStore: { resolveActiveContext: () => context() },
  });
  const result = await host.invokeTool("memory.lookup", { query: "old", trigger: "user_pull", reason: "explicit" });
  assert.equal(result.data.error, "lookup_failed");
  assert.deepEqual(result.data.hits, []);
});

test("recall_log and the same turn Trace agree without storing hit bodies", async () => {
  const { root, service } = fixture([{ ep_id: "ep-1", ts: "t1", body: "anchor SECRET FULL BODY" }]);
  const traceFile = path.join(root, "trace", "context_trace.jsonl");
  const recorder = new ContextTraceRecorder({ filePath: traceFile });
  await recorder.record({ threadId: "thread-1", turnId: "turn-1", opening: false });
  const result = service.lookup({ query: "anchor", trigger: "user_pull", reason: "explicit" }, context());
  const recall = readJsonl(path.join(root, "recall_log.jsonl"));
  await recorder.mergeRecallCalls({
    threadId: "thread-1", turnId: "turn-1",
    recallCalls: recall.map((row) => ({ trigger: row.trigger, results_count: row.hit_ids.length })),
  });
  const trace = readJsonl(traceFile);
  assert.equal(trace.length, 1);
  assert.deepEqual(trace[0].recall_calls, [{ trigger: "user_pull", results_count: result.hits.length }]);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "recall_log.jsonl"), "utf8"), /SECRET FULL BODY/u);
  assert.doesNotMatch(fs.readFileSync(traceFile, "utf8"), /SECRET FULL BODY/u);
});

test("tool registration is auto-approved and builders contain no automatic lookup call", () => {
  assert.ok(listProjectToolNames().includes("memory_lookup"));
  const args = buildCodexMcpConfigArgs({ name: "cyberboss_tools", command: "/node", args: ["server"] });
  assert.match(args.join("\n"), /tools\.memory_lookup\.approval_mode="auto"/u);
  for (const relative of ["src/core/hard-context.js", "src/adapters/runtime/shared-instructions.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.doesNotMatch(source, /memory(?:\.|_)lookup\s*\(/iu);
  }
  const config = fs.readFileSync(path.join(__dirname, "../src/core/config.js"), "utf8");
  assert.doesNotMatch(config, /softRetrieval\s*:\s*true/iu);
});

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
