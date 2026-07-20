const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tryAcquireActiveMarker, releaseActiveMarker } = require("../src/app/hourly-desire-poller");

test("overlap marker is exclusive and stale owner cannot remove replacement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desire-marker-"));
  const markerFile = path.join(dir, "active.json");
  const first = { owner: "process-a:event-a", eventId: "event-a", startedAt: Date.now() };
  const second = { owner: "process-b:event-b", eventId: "event-b", startedAt: Date.now() };
  assert.equal(tryAcquireActiveMarker(markerFile, first), true);
  assert.equal(tryAcquireActiveMarker(markerFile, second), false);
  assert.equal(releaseActiveMarker(markerFile, second), false);
  assert.equal(releaseActiveMarker(markerFile, first), true);
  assert.equal(tryAcquireActiveMarker(markerFile, second), true);
  assert.equal(releaseActiveMarker(markerFile, first), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, "utf8")), second);
  releaseActiveMarker(markerFile, second);
  fs.rmSync(dir, { recursive: true, force: true });
});
