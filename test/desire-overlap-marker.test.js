const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tryAcquireActiveMarker, releaseActiveMarker, markerIsFresh } = require("../src/app/hourly-desire-poller");
const { acquireWriterLease, releaseWriterLease } = require("../src/orchestration/writer-lease");

test("overlap marker is exclusive and stale owner cannot remove replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desire-marker-"));
  const markerFile = path.join(dir, "active.json");
  const first = { owner: "process-a:event-a", eventId: "event-a", startedAt: Date.now() };
  const second = { owner: "process-b:event-b", eventId: "event-b", startedAt: Date.now() };
  try {
    assert.equal(tryAcquireActiveMarker(markerFile, first), true);
    assert.equal(tryAcquireActiveMarker(markerFile, second), false);
    assert.equal(releaseActiveMarker(markerFile, second), false);
    assert.equal(releaseActiveMarker(markerFile, first), true);
    assert.equal(tryAcquireActiveMarker(markerFile, second), true);
    assert.equal(releaseActiveMarker(markerFile, first), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), second);
    assert.equal(releaseActiveMarker(markerFile, second), true);
    assert.equal(fs.existsSync(`${markerFile}.lease`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale marker recovery is serialized and preserves replacement ownership", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desire-marker-stale-"));
  const markerFile = path.join(dir, "active.json");
  const now = Date.now();
  const stale = { owner: "dead-process:old", eventId: "old", startedAt: now - 3 * 60 * 60 * 1000 };
  const replacement = { owner: "live-process:new", eventId: "new", startedAt: now };
  try {
    fs.writeFileSync(markerFile, JSON.stringify(stale), "utf8");
    assert.equal(tryAcquireActiveMarker(markerFile, replacement, now), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), replacement);
    assert.equal(releaseActiveMarker(markerFile, stale), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), replacement);
    assert.equal(releaseActiveMarker(markerFile, replacement), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live marker lease prevents concurrent stale cleanup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desire-marker-lease-"));
  const markerFile = path.join(dir, "active.json");
  const leaseFile = `${markerFile}.lease`;
  const marker = { owner: "process-a:event-a", eventId: "event-a", startedAt: Date.now() };
  let lease;
  try {
    lease = acquireWriterLease(leaseFile, {
      writer: "fixture",
      model: "fixture",
      phase: "active-marker",
      branch: "fixture",
      worktree: dir,
      base_sha: "fixture",
    });
    assert.equal(tryAcquireActiveMarker(markerFile, marker), false);
    assert.equal(fs.existsSync(markerFile), false);
  } finally {
    if (lease) releaseWriterLease(leaseFile, lease.lease_id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh pid-owned marker is reclaimable when its owner is dead, but not when alive or indeterminate", () => {
  const now = Date.now();
  const marker = { owner: "4242:fixture", eventId: "event", startedAt: now };
  assert.equal(markerIsFresh(marker, now, { isProcessAlive: () => false }), false);
  assert.equal(markerIsFresh(marker, now, { isProcessAlive: () => true }), true);
  assert.equal(markerIsFresh(marker, now, { isProcessAlive: () => null }), true);
});
