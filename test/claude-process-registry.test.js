"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ProcessRegistry,
  buildProcessKey,
} = require("../src/adapters/runtime/claudecode/process-registry");
const { buildSessionSlotKey } = require("../src/adapters/runtime/claudecode/session-slot");
const { buildTelegramRouteLane } = require("../src/core/route-lane");

const slotFor = (chatId, messageThreadId, profileFingerprint = "legacy") => buildSessionSlotKey({
  workspaceRoot: "/w",
  laneKey: buildTelegramRouteLane({ accountId: "telegram", chatId, messageThreadId }).laneKey,
  profileFingerprint,
});

function fakeClient({ alive = true, pendingTurnId = "", sessionId = "" } = {}) {
  return {
    alive,
    pendingTurnId,
    sessionId,
    resumeSessionId: "",
    activeThreadId: "",
    closed: 0,
    async close() {
      this.closed += 1;
      this.alive = false;
    },
  };
}

test("process identity separates lanes, profiles, cwds and config identities", () => {
  const laneA = slotFor(1, null);
  const laneB = slotFor(1, 7);
  const keys = new Set([
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "legacy", cwd: "/c", configIdentity: "x" }),
    buildProcessKey({ sessionSlotKey: laneB, launchFingerprint: "legacy", cwd: "/c", configIdentity: "x" }),
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "fp-1", cwd: "/c", configIdentity: "x" }),
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "legacy", cwd: "/other", configIdentity: "x" }),
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "legacy", cwd: "/c", configIdentity: "y" }),
  ]);
  assert.equal(keys.size, 5);

  // Identical inputs are stable.
  assert.equal(
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "legacy", cwd: "/c", configIdentity: "x" }),
    buildProcessKey({ sessionSlotKey: laneA, launchFingerprint: "legacy", cwd: "/c", configIdentity: "x" }),
  );
  assert.equal(buildProcessKey({ sessionSlotKey: "" }), "");
});

test("the per-key lock serializes work and different keys stay independent", async () => {
  const registry = new ProcessRegistry();
  const order = [];
  const defer = () => new Promise((resolve) => setTimeout(resolve, 5));

  const a1 = registry.withLock("key-a", async () => {
    order.push("a1:start");
    await defer();
    order.push("a1:end");
  });
  const a2 = registry.withLock("key-a", async () => {
    order.push("a2:start");
    order.push("a2:end");
  });
  const b1 = registry.withLock("key-b", async () => {
    order.push("b1:start");
    order.push("b1:end");
  });

  await Promise.all([a1, a2, b1]);

  // Same key never interleaves.
  assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"));
  // A different key does not have to wait for the slow one to finish.
  assert.ok(order.indexOf("b1:end") < order.indexOf("a1:end"));
});

test("a failed critical section does not poison later work on the same key", async () => {
  const registry = new ProcessRegistry();
  await assert.rejects(
    registry.withLock("key", async () => {
      throw new Error("launch failed");
    }),
    /launch failed/,
  );
  assert.equal(await registry.withLock("key", async () => "recovered"), "recovered");
});

test("closing one lane's process leaves every other lane untouched", async () => {
  const registry = new ProcessRegistry();
  const clientA = fakeClient({ sessionId: "sess-a" });
  const clientB = fakeClient({ sessionId: "sess-b" });
  const keyA = buildProcessKey({ sessionSlotKey: slotFor(1, null), cwd: "/c" });
  const keyB = buildProcessKey({ sessionSlotKey: slotFor(1, 7), cwd: "/c" });
  registry.set(keyA, { client: clientA, sessionSlotKey: slotFor(1, null), laneKey: "a" });
  registry.set(keyB, { client: clientB, sessionSlotKey: slotFor(1, 7), laneKey: "b" });

  const removed = registry.delete(keyA);
  await removed.client.close();

  assert.equal(clientA.alive, false);
  assert.equal(clientB.alive, true);
  assert.equal(clientB.closed, 0);
  assert.equal(registry.size(), 1);
});

test("a session id only ever resolves to the process that owns it", () => {
  const registry = new ProcessRegistry();
  const clientA = fakeClient({ sessionId: "sess-a" });
  const clientB = fakeClient({ sessionId: "sess-b" });
  registry.set("key-a", { client: clientA, sessionSlotKey: "slot-a", laneKey: "lane-a" });
  registry.set("key-b", { client: clientB, sessionSlotKey: "slot-b", laneKey: "lane-b" });

  assert.equal(registry.findEntryByThreadId("sess-a").processKey, "key-a");
  assert.equal(registry.findEntryByThreadId("sess-b").processKey, "key-b");
  assert.equal(registry.findEntryByThreadId("sess-unknown"), null);
  assert.equal(registry.findEntryByThreadId(""), null);
});

test("approvals are routed back to the process that raised them", async () => {
  const registry = new ProcessRegistry();
  registry.set("key-a", { client: fakeClient(), sessionSlotKey: "slot-a", laneKey: "lane-a" });
  registry.set("key-b", { client: fakeClient(), sessionSlotKey: "slot-b", laneKey: "lane-b" });
  registry.rememberApproval("req-1", { processKey: "key-a", sessionSlotKey: "slot-a", laneKey: "lane-a" });
  registry.rememberApproval("req-2", { processKey: "key-b", sessionSlotKey: "slot-b", laneKey: "lane-b" });

  assert.equal(registry.resolveApproval("req-1").processKey, "key-a");
  assert.equal(registry.resolveApproval("req-2").processKey, "key-b");

  // Retiring one process forgets only its own pending approvals.
  registry.delete("key-a");
  assert.equal(registry.resolveApproval("req-1"), null);
  assert.equal(registry.resolveApproval("req-2").processKey, "key-b");
});

test("a stale process for a slot is only retired when it is idle", () => {
  const registry = new ProcessRegistry();
  const busy = fakeClient({ pendingTurnId: "turn-1" });
  const idle = fakeClient();
  registry.set("old-busy", { client: busy, sessionSlotKey: "slot-1", laneKey: "lane-1" });
  registry.set("old-idle", { client: idle, sessionSlotKey: "slot-1", laneKey: "lane-1" });
  registry.set("current", { client: fakeClient(), sessionSlotKey: "slot-1", laneKey: "lane-1" });

  const stale = registry.listStaleEntriesForSlot("slot-1", "current");
  assert.deepEqual(stale.map((entry) => entry.processKey).sort(), ["old-busy", "old-idle"]);
  assert.equal(ProcessRegistry.isEntryBusy(registry.get("old-busy")), true);
  assert.equal(ProcessRegistry.isEntryBusy(registry.get("old-idle")), false);
});

test("capacity eviction never selects a process that is mid-turn", () => {
  const registry = new ProcessRegistry({ maxProcesses: 2 });
  registry.set("busy-1", { client: fakeClient({ pendingTurnId: "t" }), sessionSlotKey: "s1", laneKey: "l1" });
  registry.set("busy-2", { client: fakeClient({ pendingTurnId: "t" }), sessionSlotKey: "s2", laneKey: "l2" });
  registry.set("idle-1", { client: fakeClient(), sessionSlotKey: "s3", laneKey: "l3" });
  registry.set("idle-2", { client: fakeClient(), sessionSlotKey: "s4", laneKey: "l4" });

  const evictable = registry.pickEvictableEntries().map((entry) => entry.processKey);
  assert.equal(evictable.length, 2);
  assert.equal(evictable.includes("busy-1"), false);
  assert.equal(evictable.includes("busy-2"), false);
});

test("concurrent attaches on one key run one at a time", async () => {
  const registry = new ProcessRegistry();
  let concurrent = 0;
  let peak = 0;
  const attach = () => registry.withLock("key", async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 2));
    concurrent -= 1;
  });

  await Promise.all(Array.from({ length: 8 }, attach));
  assert.equal(peak, 1);
});
