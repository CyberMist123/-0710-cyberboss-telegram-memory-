"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const {
  SessionSlotStore,
  buildSessionSlotKey,
} = require("../src/adapters/runtime/claudecode/session-slot");
const { buildTelegramRouteLane, buildSystemRouteLane } = require("../src/core/route-lane");
const { validateLaunchProfile } = require("../src/adapters/runtime/claudecode/launch-profile");

const FAKE_CLI = path.join(__dirname, "helpers", "fake-claude-cli.js");

function makeAdapter() {
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-slot-")));
  const workspaceRoot = path.join(tempDir, "workspace");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const launchLog = path.join(tempDir, "launches.jsonl");
  const counterFile = path.join(tempDir, "counter");
  fs.writeFileSync(launchLog, "");

  process.env.CB_FAKE_LAUNCH_LOG = launchLog;
  process.env.CB_FAKE_COUNTER = counterFile;

  const adapter = createClaudeCodeRuntimeAdapter({
    stateDir,
    sessionsFile: path.join(tempDir, "sessions.json"),
    claudeSessionSlotsFile: path.join(stateDir, "claude-session-slots.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [FAKE_CLI],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: tempDir,
  });

  return {
    adapter,
    tempDir,
    workspaceRoot,
    stateDir,
    readLaunches() {
      return fs.readFileSync(launchLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    // A resumed turn resolves as soon as the parent knows the session id, which
    // can be before the freshly spawned child has flushed its launch record.
    // Wait for the record rather than racing it.
    async waitForLaunches(expected, timeoutMs = 5000) {
      const startedAt = Date.now();
      for (;;) {
        const launches = fs.readFileSync(launchLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (launches.length >= expected) {
          return launches;
        }
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`timed out waiting for ${expected} launches, saw ${launches.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

const laneFor = (chatId, messageThreadId) =>
  buildTelegramRouteLane({ accountId: "telegram", chatId, messageThreadId });

async function turn(adapter, { workspaceRoot, lane, launchProfile = null, text = "hi" }) {
  return adapter.sendTurn({
    bindingKey: "default:telegram:user-1",
    workspaceRoot,
    lane,
    launchProfile,
    text,
  });
}

test("topic A / profile A and topic B / profile B get different Claude sessions, and A -> B -> A restores session A", async () => {
  const { adapter, tempDir, workspaceRoot, waitForLaunches } = makeAdapter();
  const profileA = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });
  const profileB = validateLaunchProfile({ profileId: "wide", effort: "high" }, { baseDir: tempDir });
  const laneA = laneFor(500, null);
  const laneB = laneFor(500, 7);

  try {
    const first = await turn(adapter, { workspaceRoot, lane: laneA, launchProfile: profileA });
    const second = await turn(adapter, { workspaceRoot, lane: laneB, launchProfile: profileB });
    const third = await turn(adapter, { workspaceRoot, lane: laneA, launchProfile: profileA });

    // 1. A and B are different sessions.
    assert.notEqual(first.threadId, second.threadId);
    // 2. Returning to A restores A's session rather than opening a third one.
    assert.equal(third.threadId, first.threadId);
    // 3. They are different session slots.
    assert.notEqual(first.sessionSlotKey, second.sessionSlotKey);
    assert.equal(third.sessionSlotKey, first.sessionSlotKey);
    // 4. And different processes.
    assert.notEqual(first.processKey, second.processKey);

    const launches = await waitForLaunches(3);
    assert.equal(launches.length, 3);
    // The first two launches open new sessions; only the third resumes.
    assert.equal(launches[0].resumeSessionId, "");
    assert.equal(launches[1].resumeSessionId, "");
    assert.equal(launches[2].resumeSessionId, first.threadId);

    // 5. Lane B never carried lane A's session id on its command line.
    const laneBLaunch = launches[1];
    assert.equal(laneBLaunch.argv.includes(first.threadId), false);
    assert.equal(laneBLaunch.argv.includes("--resume"), false);

    // 6. Each launch carried its own profile's effort.
    assert.equal(launches[0].argv[launches[0].argv.indexOf("--effort") + 1], "low");
    assert.equal(launches[1].argv[launches[1].argv.indexOf("--effort") + 1], "high");
    assert.equal(launches[2].argv[launches[2].argv.indexOf("--effort") + 1], "low");
  } finally {
    await adapter.close();
  }
});

test("the same profile in two different topics still gets isolated sessions", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches } = makeAdapter();
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });

  try {
    const topicOne = await turn(adapter, { workspaceRoot, lane: laneFor(500, 11), launchProfile: profile });
    const topicTwo = await turn(adapter, { workspaceRoot, lane: laneFor(500, 12), launchProfile: profile });

    assert.notEqual(topicOne.threadId, topicTwo.threadId);
    assert.notEqual(topicOne.sessionSlotKey, topicTwo.sessionSlotKey);
    assert.notEqual(topicOne.processKey, topicTwo.processKey);
    assert.deepEqual(readLaunches().map((entry) => entry.resumeSessionId), ["", ""]);
  } finally {
    await adapter.close();
  }
});

test("the same topic and the same profile keeps resuming one session", async () => {
  const { adapter, tempDir, workspaceRoot, waitForLaunches } = makeAdapter();
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });
  const lane = laneFor(500, 3);

  try {
    const first = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });
    const second = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });
    const third = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });

    assert.equal(second.threadId, first.threadId);
    assert.equal(third.threadId, first.threadId);
    assert.equal(second.sessionSlotKey, first.sessionSlotKey);
    assert.equal(third.sessionSlotKey, first.sessionSlotKey);

    // The fixture exits after one turn, so a relaunch happens; a real CLI would
    // simply keep serving the same session. Either way exactly one session id
    // exists for this lane, and every relaunch resumes it rather than opening a
    // second transcript.
    const launches = await waitForLaunches(2);
    assert.equal(new Set(launches.map((entry) => entry.sessionId)).size, 1);
    assert.equal(launches[0].resumeSessionId, "");
    for (const entry of launches.slice(1)) {
      assert.equal(entry.resumeSessionId, first.threadId);
    }
  } finally {
    await adapter.close();
  }
});

test("changing only the profile in one topic opens a new session instead of resuming the old one", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches } = makeAdapter();
  const lane = laneFor(500, null);
  const safe = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });
  const wide = validateLaunchProfile({ profileId: "wide", effort: "high" }, { baseDir: tempDir });

  try {
    const withSafe = await turn(adapter, { workspaceRoot, lane, launchProfile: safe });
    const withWide = await turn(adapter, { workspaceRoot, lane, launchProfile: wide });
    const backToSafe = await turn(adapter, { workspaceRoot, lane, launchProfile: safe });

    assert.notEqual(withWide.threadId, withSafe.threadId);
    assert.equal(backToSafe.threadId, withSafe.threadId);

    const launches = readLaunches();
    // The restrictive profile's transcript is never handed to the wide profile.
    assert.equal(launches[1].resumeSessionId, "");
    assert.equal(launches[1].argv.includes(withSafe.threadId), false);
  } finally {
    await adapter.close();
  }
});

test("concurrent turns in different lanes do not close each other's process", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches } = makeAdapter();
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });

  try {
    const results = await Promise.all([
      turn(adapter, { workspaceRoot, lane: laneFor(500, 21), launchProfile: profile }),
      turn(adapter, { workspaceRoot, lane: laneFor(500, 22), launchProfile: profile }),
      turn(adapter, { workspaceRoot, lane: laneFor(500, 23), launchProfile: profile }),
    ]);

    const sessions = new Set(results.map((result) => result.threadId));
    const processes = new Set(results.map((result) => result.processKey));
    assert.equal(sessions.size, 3, "each lane kept its own session");
    assert.equal(processes.size, 3, "each lane kept its own process");
    // Three launches, none of them a resume: no lane restarted another's work.
    assert.equal(readLaunches().length, 3);
    assert.deepEqual(readLaunches().map((entry) => entry.resumeSessionId), ["", "", ""]);
  } finally {
    await adapter.close();
  }
});

test("concurrent turns in one lane serialize onto a single process and session", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches } = makeAdapter();
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });
  const lane = laneFor(500, 31);

  try {
    const first = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });
    const rest = await Promise.all([
      turn(adapter, { workspaceRoot, lane, launchProfile: profile }),
      turn(adapter, { workspaceRoot, lane, launchProfile: profile }),
      turn(adapter, { workspaceRoot, lane, launchProfile: profile }),
    ]);

    // One lane, one slot, one process key, one session -- the per-key lock kept
    // the concurrent attaches from forking a second child for this slot.
    for (const result of rest) {
      assert.equal(result.threadId, first.threadId);
      assert.equal(result.sessionSlotKey, first.sessionSlotKey);
      assert.equal(result.processKey, first.processKey);
    }
    assert.equal(new Set(readLaunches().map((entry) => entry.sessionId)).size, 1);
  } finally {
    await adapter.close();
  }
});

test("a background turn is isolated: no profile, no slot, no resumable session", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches, waitForLaunches } = makeAdapter();
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });
  const lane = laneFor(500, null);

  try {
    const foreground = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });
    const slotCountBefore = adapter.describeRouting().slotCount;

    await adapter.runBackgroundTurn({ workspaceRoot, text: "closeout" });

    assert.equal(adapter.describeRouting().slotCount, slotCountBefore, "background turn created no session slot");

    const launches = await waitForLaunches(2);
    const backgroundLaunch = launches[launches.length - 1];
    // No profile flags and no resume of the interactive session.
    assert.equal(backgroundLaunch.argv.includes("--effort"), false);
    assert.equal(backgroundLaunch.resumeSessionId, "");
    assert.equal(backgroundLaunch.argv.includes(foreground.threadId), false);

    // Returning to the foreground lane still restores its own session.
    const again = await turn(adapter, { workspaceRoot, lane, launchProfile: profile });
    assert.equal(again.threadId, foreground.threadId);
  } finally {
    await adapter.close();
  }
});

test("a system-message lane never shares a slot with the Telegram lane it runs beside", () => {
  const telegramSlot = buildSessionSlotKey({
    workspaceRoot: "/w",
    laneKey: laneFor(500, null).laneKey,
    profileFingerprint: "legacy",
  });
  const systemSlot = buildSessionSlotKey({
    workspaceRoot: "/w",
    laneKey: buildSystemRouteLane("system-message").laneKey,
    profileFingerprint: "legacy",
  });
  const closeoutSlot = buildSessionSlotKey({
    workspaceRoot: "/w",
    laneKey: buildSystemRouteLane("closeout").laneKey,
    profileFingerprint: "legacy",
  });
  assert.equal(new Set([telegramSlot, systemSlot, closeoutSlot]).size, 3);
});

test("the profile-free lane seeds itself from the pre-v2 session store exactly once", async () => {
  const { adapter, workspaceRoot, waitForLaunches } = makeAdapter();
  const legacySessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const lane = laneFor(500, null);

  try {
    // Simulate an upgrade: sessions.json already holds a session for this
    // binding and workspace, recorded before session slots existed.
    adapter.getSessionStore().setThreadIdForWorkspace(
      "default:telegram:user-1", workspaceRoot, legacySessionId,
    );

    const resumed = await turn(adapter, { workspaceRoot, lane, launchProfile: null });
    assert.equal(resumed.threadId, legacySessionId);
    assert.equal((await waitForLaunches(1))[0].resumeSessionId, legacySessionId);
  } finally {
    await adapter.close();
  }
});

test("a profiled lane does NOT inherit the pre-v2 session of its binding", async () => {
  const { adapter, tempDir, workspaceRoot, readLaunches } = makeAdapter();
  const legacySessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const profile = validateLaunchProfile({ profileId: "safe", effort: "low" }, { baseDir: tempDir });

  try {
    adapter.getSessionStore().setThreadIdForWorkspace(
      "default:telegram:user-1", workspaceRoot, legacySessionId,
    );
    const result = await turn(adapter, { workspaceRoot, lane: laneFor(500, null), launchProfile: profile });

    assert.notEqual(result.threadId, legacySessionId);
    assert.equal(readLaunches()[0].resumeSessionId, "");
    assert.equal(readLaunches()[0].argv.includes(legacySessionId), false);
  } finally {
    await adapter.close();
  }
});

test("the slot store keeps session ids opaque on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-slotstore-"));
  const filePath = path.join(dir, "slots.json");
  const store = new SessionSlotStore({ filePath });
  const slotKey = buildSessionSlotKey({
    workspaceRoot: "/secret/workspace",
    laneKey: laneFor(987654321, 42).laneKey,
    profileFingerprint: "legacy",
  });

  store.setThreadId(slotKey, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  store.setContextFingerprint(slotKey, "fp-1");

  const onDisk = fs.readFileSync(filePath, "utf8");
  assert.equal(onDisk.includes("987654321"), false, "chat id must not be stored in plaintext");
  assert.equal(onDisk.includes("/secret/workspace"), false, "workspace path must not be stored in plaintext");

  const reloaded = new SessionSlotStore({ filePath });
  assert.equal(reloaded.getThreadId(slotKey), "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(reloaded.getContextFingerprint(slotKey), "fp-1");

  reloaded.clear(slotKey);
  assert.equal(reloaded.getThreadId(slotKey), "");
});

test("the slot store ignores polluting keys when loading state from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-slotstore-proto-"));
  const filePath = path.join(dir, "slots.json");
  fs.writeFileSync(filePath, JSON.stringify({
    version: 2,
    slots: JSON.parse('{"__proto__":{"threadId":"x"},"real":{"threadId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}}'),
  }));
  const store = new SessionSlotStore({ filePath });
  assert.equal(store.getThreadId("real"), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  assert.equal({}.threadId, undefined);
});
