"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readConfig } = require("../src/core/config");

// 聊天资产基座（批次 B）。她的东西——日记、聊天原文、表情包、收到的媒体——
// 此前和机器状态（pid、会话槽、轮询游标、writer 锁）同居 stateDir。这一层只做
// 一件事：让那四类能整体指向别处，而不设置时与改动前逐字节一致。
const KEYS = ["diaryDir", "conversationDir", "voiceMediaDir", "photoMediaDir", "stickersDir"];
const ENV_KEYS = ["CYBERBOSS_STATE_DIR", "CYBERBOSS_CHAT_ASSETS_DIR", "CYBERBOSS_DIARY_DIR"];

function withEnv(values, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("不设 CHAT_ASSETS_DIR 时，五条路径与它存在之前逐字节一致", () => {
  const stateDir = tempDir("cb-chat-assets-off-");
  const resolved = withEnv({ CYBERBOSS_STATE_DIR: stateDir }, () => {
    const config = readConfig();
    return Object.fromEntries(KEYS.map((key) => [key, config[key]]));
  });

  // 这五条正是改动前 joinIfBase(stateDir, ...) 的结果，一个字符都不能差。
  assert.equal(resolved.diaryDir, path.join(stateDir, "diary"));
  assert.equal(resolved.conversationDir, path.join(stateDir, "conversations"));
  assert.equal(resolved.voiceMediaDir, path.join(stateDir, "media", "voice"));
  assert.equal(resolved.photoMediaDir, path.join(stateDir, "media", "photos"));
  assert.equal(resolved.stickersDir, path.join(stateDir, "stickers"));

  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("设一行就整体搬走，而机器状态仍留在 stateDir", () => {
  const stateDir = tempDir("cb-chat-assets-state-");
  const assetsDir = tempDir("cb-chat-assets-new-");
  const config = withEnv(
    { CYBERBOSS_STATE_DIR: stateDir, CYBERBOSS_CHAT_ASSETS_DIR: assetsDir },
    () => readConfig(),
  );

  for (const key of KEYS) {
    assert.equal(
      config[key].startsWith(assetsDir),
      true,
      `${key} 应落在资产区，实际是 ${config[key]}`,
    );
  }

  // 反面同样重要：机器状态不许被一起搬走（D1 —— runtime 是机器状态，不跨机同步；
  // 而且这些文件被在跑的进程实时持有，搬走等于当场拔线）。
  for (const key of ["telegramStateFile", "activityPauseFile", "systemMessageQueueFile", "projectToolContextFile"]) {
    assert.equal(
      config[key].startsWith(stateDir),
      true,
      `${key} 是机器状态，必须留在 stateDir，实际是 ${config[key]}`,
    );
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

test("CYBERBOSS_DIARY_DIR 仍然单独压过基座", () => {
  const stateDir = tempDir("cb-chat-assets-diary-");
  const assetsDir = tempDir("cb-chat-assets-diarybase-");
  const diaryDir = tempDir("cb-chat-assets-diaryown-");
  const config = withEnv(
    {
      CYBERBOSS_STATE_DIR: stateDir,
      CYBERBOSS_CHAT_ASSETS_DIR: assetsDir,
      CYBERBOSS_DIARY_DIR: diaryDir,
    },
    () => readConfig(),
  );

  // manifest 记的 diary 迁移方式就是这一行 env，基座不得把它盖掉。
  assert.equal(config.diaryDir, diaryDir);
  assert.equal(config.conversationDir, path.join(assetsDir, "conversations"));

  for (const dir of [stateDir, assetsDir, diaryDir]) fs.rmSync(dir, { recursive: true, force: true });
});
