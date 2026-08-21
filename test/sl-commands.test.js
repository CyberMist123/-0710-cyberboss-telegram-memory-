"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { CyberbossApp } = require("../src/core/app");
const { saveArchive } = require("../src/services/sl-archive");
const { stripConversationArtifacts } = require("../src/continuity/conversation-purity");
const { buildTelegramBotCommands, buildWeixinHelpText, listCommandGroups } = require("../src/core/command-registry");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sl-cmd-"));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFixtures(root) {
  const convDir = path.join(root, "06-raw");
  const slDir = path.join(root, "08-sl");
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(slDir, { recursive: true });
  fs.writeFileSync(
    path.join(convDir, "2026-08-20.jsonl"),
    [
      { type: "user", timestamp: "2026-08-20T00:10:00Z", text: "起点 first line" },
      { type: "runtime.turn.completed", timestamp: "2026-08-20T00:11:00Z", text: "答 a reply" },
      { type: "user", timestamp: "2026-08-20T00:12:00Z", text: "终点 the last line here" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(slDir, "sl-index.md"),
    ["# SL 存档目录", "", "| sl_id | 剧情时间 | 备注摘要 | 建档日 | 读档次数 |", "|---|---|---|---|---|", ""].join("\n"),
    "utf8",
  );
  return { convDir, slDir };
}

function makeApp(config) {
  const sent = [];
  const app = Object.create(CyberbossApp.prototype);
  app.config = config;
  app.channelAdapter = {
    async sendText(payload) {
      sent.push(payload);
    },
  };
  app.slLoadPending = new Map();
  return { app, sent };
}

const NORMALIZED = { senderId: "user-1", contextToken: "telegram:user-1", messageThreadId: null };

test("/sl_save captures a segment, replies, and lands in /sl_list", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    const config = {
      slDir,
      conversationDir: convDir,
      automationTimezone: "Australia/Sydney",
      slUserLabel: "她",
      slAiLabel: "fable",
    };
    const { app, sent } = makeApp(config);

    await app.handleSlSaveCommand(NORMALIZED, {
      name: "sl_save",
      args: "藏歌 末句：「the last line here」 备注：命令通路测试",
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已存档 SL-20260820-藏歌/);
    const saved = fs.readFileSync(path.join(slDir, "SL-20260820-藏歌.md"), "utf8");
    assert.match(saved, /她的备注: 命令通路测试/);
    assert.match(saved, /\*\*10:12 她\*\*：终点 the last line here/);

    await app.handleSlListCommand(NORMALIZED);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /SL-20260820-藏歌/);
    assert.match(sent[1].text, /读档 0 次/);
  } finally {
    cleanup(root);
  }
});

test("/sl_save cleans a messy name (angle brackets/spaces) instead of rejecting it", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    const { app, sent } = makeApp({ slDir, conversationDir: convDir, automationTimezone: "Australia/Sydney", slUserLabel: "她", slAiLabel: "fable" });
    await app.handleSlSaveCommand(NORMALIZED, { name: "sl_save", args: "<藏歌 二> 末句：「the last line here」" });
    assert.equal(sent.length, 1);
    // "<藏歌 二>" -> stripped of brackets and space -> "藏歌二"
    assert.match(sent[0].text, /已存档 SL-20260820-藏歌二/);
    assert.ok(fs.existsSync(path.join(slDir, "SL-20260820-藏歌二.md")));
  } finally {
    cleanup(root);
  }
});

test("/sl_save with no name derives one from the end anchor", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    const { app, sent } = makeApp({ slDir, conversationDir: convDir, automationTimezone: "Australia/Sydney", slUserLabel: "她", slAiLabel: "fable" });
    await app.handleSlSaveCommand(NORMALIZED, { name: "sl_save", args: "末句：「the last line here」" });
    assert.equal(sent.length, 1);
    // No name given -> derived from the anchor's first words (spaces stripped).
    assert.match(sent[0].text, /已存档 SL-20260820-thelastlinehere/);
  } finally {
    cleanup(root);
  }
});

test("/sl_save with no end anchor auto-saves up to the latest line", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    const { app, sent } = makeApp({ slDir, conversationDir: convDir, automationTimezone: "Australia/Sydney", slUserLabel: "她", slAiLabel: "fable" });

    // Just a name, no 末句 -> saves the recent conversation up to its last line.
    await app.handleSlSaveCommand(NORMALIZED, { name: "sl_save", args: "只有档名" });
    assert.match(sent[0].text, /已存档 SL-.*-只有档名/);
    assert.ok(fs.readdirSync(slDir).some((f) => /^SL-.*-只有档名\.md$/.test(f)));
  } finally {
    cleanup(root);
  }
});

test("SL commands report an unset SL dir instead of failing silently", async () => {
  const { app, sent } = makeApp({ slDir: "", conversationDir: "/x", automationTimezone: "Australia/Sydney" });
  await app.handleSlSaveCommand(NORMALIZED, { name: "sl_save", args: "x 末句：「y」" });
  await app.handleSlListCommand(NORMALIZED);
  assert.match(sent[0].text, /SL 存档没配置/);
  assert.match(sent[1].text, /SL 存档没配置/);
});

test("/sl_save /sl_load /sl_list are registered and surface in the Telegram menu (underscore names)", () => {
  const commands = buildTelegramBotCommands().map((c) => c.command);
  for (const name of ["sl_save", "sl_load", "sl_list"]) {
    assert.ok(commands.includes(name), `${name} should appear in the Telegram menu`);
  }

  const help = buildWeixinHelpText();
  assert.match(help, /\/sl_save/);
  assert.match(help, /\/sl_load/);
  assert.match(help, /\/sl_list/);

  const group = listCommandGroups().find((g) => g.id === "sl");
  assert.ok(group, "expected an SL command group");
  assert.deepEqual(group.actions.map((a) => a.action), ["sl.save", "sl.load", "sl.list"]);
});

test("/sl_load injects the archived segment via the system queue (never into 06-raw) and bumps the read count", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    saveArchive({
      slDir,
      conversationDir: convDir,
      conversationsDir: convDir,
      name: "藏歌",
      note: "读档测试",
      endAnchor: "the last line here",
      timezone: "Australia/Sydney",
      now: new Date("2026-08-20T05:00:00Z"),
    });

    const queued = [];
    const { app, sent } = makeApp({
      slDir,
      conversationDir: convDir,
      automationTimezone: "Australia/Sydney",
      slUserLabel: "她",
      slAiLabel: "fable",
    });
    app.automationTargets = { accountId: "telegram", senderId: "user-1", workspaceRoot: root };
    app.systemMessageQueue = { enqueue: (m) => queued.push(m) };

    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "藏歌 备注：第一次回档" });

    assert.equal(queued.length, 1, "load must enqueue exactly one system turn");
    assert.equal(queued[0].sourceType, "system");
    assert.match(queued[0].text, /SL 读档 · SL-20260820-藏歌/);
    assert.match(queued[0].text, /SL-QUOTE-BEGIN/); // re-wrapped for the pipeline strip
    assert.match(queued[0].text, /the last line here/); // the archived excerpt is present
    assert.match(sent[0].text, /读档 SL-20260820-藏歌（第 1 次读档）/);

    const saved = fs.readFileSync(path.join(slDir, "SL-20260820-藏歌.md"), "utf8");
    assert.match(saved, /- 第1次 .*：第一次回档/);
  } finally {
    cleanup(root);
  }
});

function makeLoadApp(root, convDir, slDir) {
  const queued = [];
  const { app, sent } = makeApp({ slDir, conversationDir: convDir, automationTimezone: "Australia/Sydney", slUserLabel: "她", slAiLabel: "fable" });
  app.automationTargets = { accountId: "telegram", senderId: "user-1", workspaceRoot: root };
  app.systemMessageQueue = { enqueue: (m) => queued.push(m) };
  return { app, sent, queued };
}

test("/sl_load with no name shows a numbered roster and arms a bare-number selection", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    saveArchive({ slDir, conversationsDir: convDir, name: "藏歌", endAnchor: "the last line here", timezone: "Australia/Sydney", now: new Date("2026-08-20T05:00:00Z") });
    const { app, sent } = makeLoadApp(root, convDir, slDir);

    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "" });
    assert.match(sent[0].text, /1\. SL-20260820-藏歌/);
    assert.match(sent[0].text, /回数字/);
    assert.equal(app.slLoadPending.size, 1, "a selection is armed");
  } finally {
    cleanup(root);
  }
});

test("a bare-number reply after /sl_load loads that archive; a non-number cancels", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    saveArchive({ slDir, conversationsDir: convDir, name: "藏歌", endAnchor: "the last line here", timezone: "Australia/Sydney", now: new Date("2026-08-20T05:00:00Z") });
    const { app, sent, queued } = makeLoadApp(root, convDir, slDir);

    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "" });
    // a non-number message cancels and is not consumed
    const passed = await app.tryConsumeSlLoadSelection({ ...NORMALIZED, text: "在吗" });
    assert.equal(passed, false, "a normal message is not consumed");
    assert.equal(app.slLoadPending.size, 0, "pending cleared by the non-number");

    // re-arm, then a bare number loads
    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "" });
    const consumed = await app.tryConsumeSlLoadSelection({ ...NORMALIZED, text: "1" });
    assert.equal(consumed, true, "the number is consumed as a selection");
    assert.equal(queued.length, 1, "the selected archive was injected");
    assert.match(sent[sent.length - 1].text, /读档 SL-20260820-藏歌/);
  } finally {
    cleanup(root);
  }
});

test("/sl_load with a number loads by position", async () => {
  const root = tempRoot();
  try {
    const { convDir, slDir } = writeFixtures(root);
    saveArchive({ slDir, conversationsDir: convDir, name: "藏歌", endAnchor: "the last line here", timezone: "Australia/Sydney", now: new Date("2026-08-20T05:00:00Z") });
    const { app, sent, queued } = makeLoadApp(root, convDir, slDir);

    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "1" });
    assert.equal(queued.length, 1);
    assert.match(sent[0].text, /读档 SL-20260820-藏歌/);

    await app.handleSlLoadCommand(NORMALIZED, { name: "sl_load", args: "9" });
    assert.match(sent[sent.length - 1].text, /没有第 9 个/);
  } finally {
    cleanup(root);
  }
});

test("digestion filter strips an SL-QUOTE span so re-injected history can't be re-ingested", () => {
  const cleaned = stripConversationArtifacts(
    "真实的一句话。\n<!-- SL-QUOTE-BEGIN：逐字摘录，消化跳过 -->\n**00:07 她**：旧对话不该重入账\n<!-- SL-QUOTE-END -->\n又一句真实的话。",
  );
  assert.ok(!cleaned.includes("旧对话不该重入账"), "quoted history inside SL-QUOTE must be stripped");
  assert.ok(!cleaned.includes("SL-QUOTE"), "the markers themselves must be gone");
  assert.match(cleaned, /真实的一句话/);
  assert.match(cleaned, /又一句真实的话/);
});
