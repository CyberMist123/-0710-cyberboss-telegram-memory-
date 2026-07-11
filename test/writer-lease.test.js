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

test("stale lease cleanup is manual and refuses a live owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-stale-"));
  const file = path.join(root, "MEMORY_WRITER_LEASE.json");
  acquireWriterLease(file, details);
  assert.throws(() => clearStaleWriterLease(file, { isProcessAlive: () => false }), /confirm=true/);
  assert.throws(() => clearStaleWriterLease(file, { confirm: true, isProcessAlive: () => true }), /still alive/);
  clearStaleWriterLease(file, { confirm: true, isProcessAlive: () => false });
  assert.equal(fs.existsSync(file), false);
});
