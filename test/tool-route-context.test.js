"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RuntimeContextStore } = require("../src/tools/runtime-context-store");
const { createTelegramSendService } = require("../src/services/telegram-service");
const {
  buildClaudeProjectMcpServerConfig,
  ensureRouteScopedMcpConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-toolctx-"));
  return new RuntimeContextStore({ filePath: path.join(dir, "context.json") });
}

// Two concurrent topics, each with its own session slot / route token.
const TOPIC_A = {
  workspaceRoot: "/workspace",
  runtimeId: "claudecode",
  provider: "telegram",
  accountId: "telegram",
  senderId: "500",
  chatId: "500",
  bindingKey: "default:telegram:500",
  threadId: "session-a",
  routeToken: "a".repeat(64),
  messageThreadId: null,
};
const TOPIC_B = {
  ...TOPIC_A,
  threadId: "session-b",
  routeToken: "b".repeat(64),
  messageThreadId: "9",
};

function captureSends(run) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = String(url).split("/").pop().split("?")[0];
    let body = null;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body);
    } else if (init.body && typeof init.body.get === "function") {
      body = Object.fromEntries([...init.body.keys()].map((key) => [key, init.body.get(key)]));
    }
    calls.push({ endpoint, body });
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, result: {} }; },
      async text() { return JSON.stringify({ ok: true, result: {} }); },
    };
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("a route token resolves exactly its own lane, never the most recent one", () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_A);
  store.setActiveContext(TOPIC_B);

  // B wrote last. Under the old workspace singleton, A's token would now read
  // back B's topic.
  assert.equal(store.resolveActiveContext({ routeToken: TOPIC_A.routeToken }).telegramMessageThreadId, null);
  assert.equal(store.resolveActiveContext({ routeToken: TOPIC_B.routeToken }).telegramMessageThreadId, "9");
});

test("an unknown route token resolves to nothing rather than another lane", () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_A);
  assert.equal(store.resolveActiveContext({ routeToken: "c".repeat(64) }), null);
});

test("without a token, two lanes mid-turn report as ambiguous", () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_A);
  store.setActiveContext(TOPIC_B);

  const resolved = store.resolveActiveContext({ workspaceRoot: "/workspace", runtimeId: "claudecode" });
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.activeLaneCount, 2);

  // Once one lane's turn ends, the remaining one is unambiguous again.
  store.clearActiveTurn(TOPIC_B.routeToken);
  const single = store.resolveActiveContext({ workspaceRoot: "/workspace", runtimeId: "claudecode" });
  assert.equal(single.ambiguous, undefined);
  assert.equal(single.threadId, "session-a");
});

test("two topics sending concurrently each land in their own topic", async () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_A);
  store.setActiveContext(TOPIC_B);

  const service = createTelegramSendService({
    config: { telegramBotToken: "test-token" },
    runtimeContextStore: store,
  });

  await captureSends(async (calls) => {
    // Each tool call arrives with the route token of the child that made it.
    await service.sendText(
      { text: "reply for the default lane" },
      { workspaceRoot: "/workspace", runtimeId: "claudecode", routeToken: TOPIC_A.routeToken },
    );
    await service.sendText(
      { text: "reply for topic 9" },
      { workspaceRoot: "/workspace", runtimeId: "claudecode", routeToken: TOPIC_B.routeToken },
    );

    assert.equal(calls.length, 2);
    const [toDefault, toTopic] = calls;
    assert.equal(toDefault.body.text, "reply for the default lane");
    assert.equal(Object.hasOwn(toDefault.body, "message_thread_id"), false, "default lane carries no topic");
    assert.equal(toTopic.body.text, "reply for topic 9");
    assert.equal(toTopic.body.message_thread_id, 9, "topic 9's reply carried its topic");
  });
});

test("interleaved sends do not overwrite each other's target", async () => {
  const store = makeStore();
  const service = createTelegramSendService({
    config: { telegramBotToken: "test-token" },
    runtimeContextStore: store,
  });

  await captureSends(async (calls) => {
    store.setActiveContext(TOPIC_A);
    const first = service.sendText({ text: "a1" }, { workspaceRoot: "/workspace", routeToken: TOPIC_A.routeToken });
    // B's turn starts while A's send is still in flight.
    store.setActiveContext(TOPIC_B);
    const second = service.sendText({ text: "b1" }, { workspaceRoot: "/workspace", routeToken: TOPIC_B.routeToken });
    const third = service.sendText({ text: "a2" }, { workspaceRoot: "/workspace", routeToken: TOPIC_A.routeToken });
    await Promise.all([first, second, third]);

    const byText = new Map(calls.map((call) => [call.body.text, call.body]));
    assert.equal(Object.hasOwn(byText.get("a1"), "message_thread_id"), false);
    assert.equal(Object.hasOwn(byText.get("a2"), "message_thread_id"), false);
    assert.equal(byText.get("b1").message_thread_id, 9);
  });
});

test("an untokened send refuses while several lanes are active", async () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_A);
  store.setActiveContext(TOPIC_B);
  const service = createTelegramSendService({
    config: { telegramBotToken: "test-token" },
    runtimeContextStore: store,
  });

  await captureSends(async (calls) => {
    await assert.rejects(
      () => service.sendText({ text: "which topic?" }, { workspaceRoot: "/workspace" }),
      /ambiguous/,
    );
    assert.equal(calls.length, 0, "nothing was delivered to a guessed lane");
  });
});

test("a single active lane still works without a token", async () => {
  const store = makeStore();
  store.setActiveContext(TOPIC_B);
  const service = createTelegramSendService({
    config: { telegramBotToken: "test-token" },
    runtimeContextStore: store,
  });

  await captureSends(async (calls) => {
    await service.sendText({ text: "only lane" }, { workspaceRoot: "/workspace" });
    assert.equal(calls[0].body.message_thread_id, 9);
  });
});

test("the tool server is launched with its own route token", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-mcpcfg-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "cyberboss.js"), "");

  const token = "d".repeat(64);
  const entry = buildClaudeProjectMcpServerConfig({
    workspaceRoot: dir, cyberbossHome: home, routeToken: token,
  });
  assert.equal(entry.args.includes("--route-token"), true);
  assert.equal(entry.args[entry.args.indexOf("--route-token") + 1], token);
  assert.equal(entry.env.CYBERBOSS_ROUTE_TOKEN, token);

  const written = ensureRouteScopedMcpConfig({
    workspaceRoot: dir, cyberbossHome: home, routeToken: token, configDir: path.join(dir, "mcp"),
  });
  assert.match(written.configPath, /route-d{16}\.json$/);
  const parsed = JSON.parse(fs.readFileSync(written.configPath, "utf8"));
  assert.equal(parsed.mcpServers.cyberboss_tools.env.CYBERBOSS_ROUTE_TOKEN, token);

  // Two lanes get two distinct config files.
  const other = ensureRouteScopedMcpConfig({
    workspaceRoot: dir, cyberbossHome: home, routeToken: "e".repeat(64), configDir: path.join(dir, "mcp"),
  });
  assert.notEqual(other.configPath, written.configPath);

  // A non-opaque token is refused rather than written into a file path.
  assert.throws(
    () => ensureRouteScopedMcpConfig({
      workspaceRoot: dir, cyberbossHome: home, routeToken: "../escape", configDir: path.join(dir, "mcp"),
    }),
    /opaque lowercase hex/,
  );
});

test("route contexts never grow without bound", () => {
  const store = makeStore();
  for (let i = 0; i < 200; i += 1) {
    store.setActiveContext({ ...TOPIC_A, routeToken: String(i).padStart(64, "0"), threadId: `s${i}` });
  }
  assert.ok(Object.keys(store.state.contextsByRouteToken).length <= 128);
});

test("a polluting route token is ignored", () => {
  const store = makeStore();
  store.setActiveContext({ ...TOPIC_A, routeToken: "__proto__" });
  assert.equal({}.telegramChatId, undefined);
  assert.equal(store.resolveActiveContext({ routeToken: "__proto__" }), null);
});
