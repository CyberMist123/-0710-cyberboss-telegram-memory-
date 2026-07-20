const assert = require("node:assert/strict");
const test = require("node:test");
const { isNightSkipAt, nextPlannedAt, normalizeDesireSchedule, scheduleLocalTime } = require("../src/core/desire-schedule");

test("desire schedule uses fixed 55-minute plan intervals without completion drift", () => {
  const first = Date.parse("2026-07-20T00:00:00Z");
  const planned = nextPlannedAt(first, 55, first + 10 * 60 * 1000);
  assert.equal(planned, first + 55 * 60 * 1000);
  assert.equal(nextPlannedAt(planned, 55, planned + 20 * 60 * 1000), first + 110 * 60 * 1000);
});

test("night interval supports cross-midnight and equal endpoints are inactive", () => {
  const cfg = normalizeDesireSchedule({ timezone: "Australia/Sydney", nightStart: "22:00", nightEnd: "06:00" });
  assert.equal(isNightSkipAt("2026-07-20T12:00:00Z", cfg), true); // 22:00 Sydney
  assert.equal(isNightSkipAt("2026-07-20T20:00:00Z", cfg), false); // 06:00 Sydney
  assert.equal(isNightSkipAt("2026-07-20T16:00:00Z", { ...cfg, nightStart: "01:30", nightEnd: "09:00" }), true);
  assert.equal(isNightSkipAt("2026-07-20T02:00:00Z", { ...cfg, nightStart: "06:00", nightEnd: "06:00" }), false);
});

test("Sydney schedule reports an IANA zone and actual offset", () => {
  const result = scheduleLocalTime("2026-01-15T00:00:00Z", "Australia/Sydney");
  assert.equal(result.timezone, "Australia/Sydney");
  assert.match(result.offset, /GMT\+11:00/);
});
