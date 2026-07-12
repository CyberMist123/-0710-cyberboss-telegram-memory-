const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { acquireWriterLease, clearStaleWriterLease, releaseWriterLease } = require("../src/orchestration/writer-lease");

const details = {
  writer: "fixture-writer",
  model: "fixture-model",
  phase: "phase1",
  branch: "fixture-branch",
  worktree: "C:\\fixture",
  base_sha: "a".repeat(40),
};

test("writer lease is exclusive and owner can release it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-lease-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  const lease = acquireWriterLease(file, details);
  assert.throws(() => acquireWriterLease(file, details), /already held/);
  assert.throws(() => releaseWriterLease(file, "wrong"), /identity mismatch/);
  releaseWriterLease(file, lease.lease_id);
  assert.equal(fs.existsSync(file), false);
});

test("stale lease cleanup is manual, archived, and refuses a live owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-stale-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  const archiveDir = path.join(root, "archive");
  acquireWriterLease(file, details);
  assert.throws(() => clearStaleWriterLease(file, { isProcessAlive: () => false }), /confirm=true/);
  assert.throws(() => clearStaleWriterLease(file, { confirm: true, isProcessAlive: () => true }), /still alive/);
  const cleared = clearStaleWriterLease(file, { confirm: true, isProcessAlive: () => false, archiveDir });
  assert.equal(fs.existsSync(file), false);
  assert.equal(cleared.writer, details.writer);
  const archived = fs.readdirSync(archiveDir);
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archiveDir, archived[0]), "utf8")).lease_id, cleared.lease_id);
});

test("acquire can recover a dead owner and keeps the stale lease as audit evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recover-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  const archiveDir = path.join(root, "archive");
  const stale = acquireWriterLease(file, { ...details, owner_pid: 424242 });
  const fresh = acquireWriterLease(file, details, {
    recoverStale: true,
    isProcessAlive: () => false,
    staleArchiveDir: archiveDir,
  });
  assert.notEqual(fresh.lease_id, stale.lease_id);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).lease_id, fresh.lease_id);
  const archived = fs.readdirSync(archiveDir);
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archiveDir, archived[0]), "utf8")).lease_id, stale.lease_id);
  releaseWriterLease(file, fresh.lease_id);
});

test("automatic recovery never steals a lease whose owner is alive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-live-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  const live = acquireWriterLease(file, details);
  assert.throws(() => acquireWriterLease(file, details, {
    recoverStale: true,
    isProcessAlive: () => true,
  }), /already held/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).lease_id, live.lease_id);
  releaseWriterLease(file, live.lease_id);
});

test("automatic recovery refuses an unreadable or malformed lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-corrupt-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  fs.writeFileSync(file, "{broken", "utf8");
  assert.throws(() => acquireWriterLease(file, details, {
    recoverStale: true,
    isProcessAlive: () => false,
  }), /unreadable; refusing stale recovery/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
