"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { buildTelegramBotCommands, buildWeixinHelpText } = require("../src/core/command-registry");

const CATALOG_ENTRIES = [
  { id: "mem_read", category: "memory", purpose: "read memory", risk: "read", alias_of: null, hidden: false, deprecated: false },
  { id: "send_message", category: "tool", purpose: "send a message", risk: "send", alias_of: null, hidden: false, deprecated: false },
  { id: "hidden_tool", category: "tool", purpose: "x", risk: "read", alias_of: null, hidden: true, deprecated: false },
  { id: "alias_tool", category: "tool", purpose: "x", risk: "read", alias_of: "send_message", hidden: false, deprecated: false },
  { id: "dep_tool", category: "tool", purpose: "x", risk: "read", alias_of: null, hidden: false, deprecated: true },
  { id: "whereabouts_x", category: "mcp", purpose: "x", risk: "read", alias_of: null, hidden: false, deprecated: true },
];

function makeApp() {
  const sent = [];
  const app = Object.create(CyberbossApp.prototype);
  app.projectToolHost = { catalogState: () => ({ entries: CATALOG_ENTRIES }) };
  app.channelAdapter = { async sendText(payload) { sent.push(payload.text); } };
  return { app, sent };
}

const NORMALIZED = { senderId: "u1", contextToken: "telegram:u1" };

test("/ai_profile lists mcp, tool, skill segments", async () => {
  const prev = process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
  delete process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
  const prevMusic = process.env.CYBERBOSS_MUSIC_MCP_COMMAND;
  delete process.env.CYBERBOSS_MUSIC_MCP_COMMAND;
  try {
    const { app, sent } = makeApp();
    await app.handleAiProfileCommand(NORMALIZED);
    const text = sent[0];

    assert.match(text, /AI-Profile/);
    assert.match(text, /【mcp】/);
    assert.match(text, /【tool】/);
    assert.match(text, /【skill】/);

    // No external MCP servers configured -> honest empty state.
    assert.match(text, /暂无外部 MCP 服务器/);

    // tool + memory categories shown; aliases/hidden/deprecated dropped.
    assert.match(text, /send_message — send a message \[send\]/);
    assert.match(text, /mem_read — read memory \[read\]/);
    assert.doesNotMatch(text, /hidden_tool/);
    assert.doesNotMatch(text, /alias_tool/);
    assert.doesNotMatch(text, /dep_tool/);
    // deprecated in-process mcp tool is not listed either.
    assert.doesNotMatch(text, /whereabouts_x/);

    // skill has no enumerator -> honest 暂缺.
    assert.match(text, /【skill】\n\s+暂缺/);
  } finally {
    if (prev !== undefined) process.env.CYBERBOSS_EXTRA_MCP_SERVERS = prev;
    if (prevMusic !== undefined) process.env.CYBERBOSS_MUSIC_MCP_COMMAND = prevMusic;
  }
});

test("/ai_profile lists configured external MCP servers by name", async () => {
  const prev = process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
  process.env.CYBERBOSS_EXTRA_MCP_SERVERS = JSON.stringify([{ name: "test_mcp", command: "node" }]);
  try {
    const { app, sent } = makeApp();
    await app.handleAiProfileCommand(NORMALIZED);
    assert.match(sent[0], /· test_mcp — node/);
    assert.doesNotMatch(sent[0], /暂无外部 MCP 服务器/);
  } finally {
    if (prev === undefined) delete process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
    else process.env.CYBERBOSS_EXTRA_MCP_SERVERS = prev;
  }
});

test("/ai_profile is hidden: never in the Telegram menu or /help", () => {
  const menuNames = new Set(buildTelegramBotCommands().map((c) => c.command));
  assert.ok(!menuNames.has("ai_profile"), "expected /ai_profile hidden from the Telegram menu");
  assert.doesNotMatch(buildWeixinHelpText(), /\/ai_profile/);
});

test("/ai_profile fails open when the tool host is unavailable", async () => {
  const sent = [];
  const app = Object.create(CyberbossApp.prototype);
  app.projectToolHost = null;
  app.channelAdapter = { async sendText(payload) { sent.push(payload.text); } };
  const prev = process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
  delete process.env.CYBERBOSS_EXTRA_MCP_SERVERS;
  try {
    await app.handleAiProfileCommand(NORMALIZED);
    assert.match(sent[0], /【tool】\n\s+（暂无工具）/);
    assert.match(sent[0], /【skill】/);
  } finally {
    if (prev !== undefined) process.env.CYBERBOSS_EXTRA_MCP_SERVERS = prev;
  }
});
