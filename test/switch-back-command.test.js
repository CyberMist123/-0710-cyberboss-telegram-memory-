"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { CyberbossApp } = require("../src/core/app");

function tempSessionsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-switch-back-"));
  return { dir, file: path.join(dir, "sessions.json") };
}

const KEY = "binding-1";
const WS = "/workspace/a";

test("SessionStore records the previous thread and toggles on return", () => {
  const { dir, file } = tempSessionsFile();
  try {
    const store = new SessionStore({ filePath: file, runtimeId: "claudecode" });

    // No previous pointer at the start.
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "");

    store.setThreadIdForWorkspace(KEY, WS, "thread-A");
    // Nothing was active before the first set, so still no previous.
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "");
    assert.equal(store.getThreadIdForWorkspace(KEY, WS), "thread-A");

    store.setThreadIdForWorkspace(KEY, WS, "thread-B");
    // Switching away from A records A as previous.
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-A");
    assert.equal(store.getThreadIdForWorkspace(KEY, WS), "thread-B");

    // Returning to A (what /switch back does) records B as the new previous.
    store.setThreadIdForWorkspace(KEY, WS, "thread-A");
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-B");
    assert.equal(store.getThreadIdForWorkspace(KEY, WS), "thread-A");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStore leaves the previous pointer untouched on a same-value write", () => {
  const { dir, file } = tempSessionsFile();
  try {
    const store = new SessionStore({ filePath: file, runtimeId: "claudecode" });
    store.setThreadIdForWorkspace(KEY, WS, "thread-A");
    store.setThreadIdForWorkspace(KEY, WS, "thread-B");
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-A");
    // Re-writing the same active thread must not clobber the previous pointer.
    store.setThreadIdForWorkspace(KEY, WS, "thread-B");
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-A");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing the thread (/new) records the outgoing thread as previous", () => {
  const { dir, file } = tempSessionsFile();
  try {
    const store = new SessionStore({ filePath: file, runtimeId: "claudecode" });
    store.setThreadIdForWorkspace(KEY, WS, "thread-A");
    store.clearThreadIdForWorkspace(KEY, WS);
    assert.equal(store.getThreadIdForWorkspace(KEY, WS), "");
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-A");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("previous pointer is persisted and survives a fresh reader off the same file", () => {
  const { dir, file } = tempSessionsFile();
  try {
    let store = new SessionStore({ filePath: file, runtimeId: "claudecode" });
    store.setThreadIdForWorkspace(KEY, WS, "thread-A");
    store.setThreadIdForWorkspace(KEY, WS, "thread-B");
    store = new SessionStore({ filePath: file, runtimeId: "claudecode" });
    assert.equal(store.getPreviousThreadIdForWorkspace(KEY, WS), "thread-A");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/switch back with no previous thread reports it honestly instead of failing", async () => {
  const { dir, file } = tempSessionsFile();
  const sent = [];
  try {
    const store = new SessionStore({ filePath: file, runtimeId: "claudecode" });
    store.buildBindingKey = () => KEY;
    const app = Object.create(CyberbossApp.prototype);
    app.runtimeAdapter = { getSessionStore: () => store };
    app.resolveWorkspaceRoot = () => WS;
    app.channelAdapter = { async sendText(payload) { sent.push(payload); } };

    await app.handleSwitchCommand(
      { senderId: "u1", workspaceId: "default", accountId: "telegram", contextToken: "telegram:u1" },
      { args: "back" },
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /No previous thread to return to/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
