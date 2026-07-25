"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  WorkspaceLockError,
  WorkspaceLockManager,
  canonicalWorkspaceKey,
  normalizeAccessMode,
} = require("../src/core/workspace-lock");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("access mode is an explicit enum defaulting to write", () => {
  assert.equal(normalizeAccessMode(undefined), "write");
  assert.equal(normalizeAccessMode(null), "write");
  assert.equal(normalizeAccessMode(""), "write");
  assert.equal(normalizeAccessMode("read"), "read");
  assert.equal(normalizeAccessMode("write"), "write");
  for (const bad of ["rw", "READ", "readonly", 1, true, {}]) {
    assert.throws(() => normalizeAccessMode(bad), WorkspaceLockError);
  }
});

test("readers run concurrently", async () => {
  const locks = new WorkspaceLockManager();
  const a = await locks.acquire("/ws", "read");
  const b = await locks.acquire("/ws", "read");
  const c = await locks.acquire("/ws", "read");

  assert.equal(locks.describe().readers, 3);
  a.release();
  b.release();
  c.release();
  assert.equal(locks.describe().keys, 0, "the lock state is dropped once idle");
});

test("a writer excludes readers and other writers", async () => {
  const locks = new WorkspaceLockManager();
  const order = [];
  const writer = await locks.acquire("/ws", "write");
  order.push("writer:acquired");

  let readerDone = false;
  let secondWriterDone = false;
  const reader = locks.acquire("/ws", "read").then((handle) => {
    readerDone = true;
    order.push("reader:acquired");
    return handle;
  });
  const secondWriter = locks.acquire("/ws", "write").then((handle) => {
    secondWriterDone = true;
    order.push("writer2:acquired");
    return handle;
  });

  await tick();
  assert.equal(readerDone, false, "read waits behind the writer");
  assert.equal(secondWriterDone, false, "write waits behind the writer");

  writer.release();
  const readerHandle = await reader;
  readerHandle.release();
  const secondHandle = await secondWriter;
  secondHandle.release();

  assert.deepEqual(order, [
    "writer:acquired", "reader:acquired", "writer2:acquired",
  ], "waiters are served first in, first out");
});

test("a stream of readers cannot starve a queued writer", async () => {
  const locks = new WorkspaceLockManager();
  const first = await locks.acquire("/ws", "read");

  let writerAcquired = false;
  const writer = locks.acquire("/ws", "write").then((handle) => {
    writerAcquired = true;
    return handle;
  });
  await tick();

  let lateReaderAcquired = false;
  const lateReader = locks.acquire("/ws", "read").then((handle) => {
    lateReaderAcquired = true;
    return handle;
  });
  await tick();

  assert.equal(writerAcquired, false);
  assert.equal(lateReaderAcquired, false, "a new reader does not overtake the queued writer");

  first.release();
  (await writer).release();
  (await lateReader).release();
  assert.equal(locks.describe().keys, 0);
});

test("different workspaces never contend", async () => {
  const locks = new WorkspaceLockManager();
  const a = await locks.acquire("/ws-a", "write");
  const b = await locks.acquire("/ws-b", "write");
  assert.equal(locks.describe().writers, 2);
  a.release();
  b.release();
});

test("the same workspace reached by different text paths is one lock", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wslock-")));
  const nested = path.join(base, "inner");
  fs.mkdirSync(nested, { recursive: true });

  const viaDotDot = path.join(nested, "..", "inner");
  assert.equal(canonicalWorkspaceKey(nested), canonicalWorkspaceKey(viaDotDot));

  const locks = new WorkspaceLockManager();
  const held = await locks.acquire(nested, "write");
  let second = false;
  const waiting = locks.acquire(viaDotDot, "write").then((handle) => {
    second = true;
    return handle;
  });
  await tick();
  assert.equal(second, false, "the .. form contends with the canonical form");
  held.release();
  (await waiting).release();
});

test("a symlinked workspace canonicalizes to its target", { skip: process.platform === "win32" ? "posix symlinks" : false }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-wslink-")));
  const real = path.join(base, "real");
  const link = path.join(base, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, "dir");

  assert.equal(canonicalWorkspaceKey(link), canonicalWorkspaceKey(real));

  const locks = new WorkspaceLockManager();
  const held = await locks.acquire(real, "write");
  let acquired = false;
  const waiting = locks.acquire(link, "write").then((handle) => {
    acquired = true;
    return handle;
  });
  await tick();
  assert.equal(acquired, false);
  held.release();
  (await waiting).release();
});

test("release is idempotent and does not corrupt the counter", async () => {
  const locks = new WorkspaceLockManager();
  const held = await locks.acquire("/ws", "read");
  held.release();
  held.release();
  held.release();
  assert.equal(locks.describe().readers, 0);

  const writer = await locks.acquire("/ws", "write");
  assert.equal(locks.describe().writers, 1);
  writer.release();
  assert.equal(locks.describe().keys, 0);
});

test("a waiter that times out is removed and does not block the queue", async () => {
  const locks = new WorkspaceLockManager({ timeoutMs: 20 });
  const held = await locks.acquire("/ws", "write");

  await assert.rejects(
    () => locks.acquire("/ws", "write"),
    (error) => {
      assert.ok(error instanceof WorkspaceLockError);
      assert.equal(error.code, "workspace_lock_timeout");
      return true;
    },
  );

  held.release();
  // The timed-out waiter left no ghost entry behind.
  const next = await locks.acquire("/ws", "write", { timeoutMs: 200 });
  next.release();
  assert.equal(locks.describe().keys, 0);
});

test("an unidentifiable workspace yields a no-op handle rather than a global lock", async () => {
  const locks = new WorkspaceLockManager();
  const handle = await locks.acquire("", "write");
  assert.equal(handle.key, "");
  const other = await locks.acquire("", "write");
  assert.equal(other.key, "");
  handle.release();
  other.release();
});
