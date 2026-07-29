const test = require("node:test");
const assert = require("node:assert/strict");

const {
  capDelayAtSleepBoundary,
  isSleepWindow,
  nextWakeTimestamp,
} = require("../src/app/system-checkin-poller");
const { resolveAppTimezone } = require("../src/utils/app-timezone");
const {
  formatAppDateTime,
  formatBeijingDateTime,
} = require("../src/utils/beijing-time");

test("application timezone falls back to the host timezone when unset", () => {
  const hostTimezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;

  assert.equal(resolveAppTimezone({ env: {} }), hostTimezone);
  assert.equal(resolveAppTimezone({
    env: {},
    localTimezone: "Pacific/Auckland",
  }), "Pacific/Auckland");
});

test("CYBERBOSS_TIMEZONE overrides the host timezone", () => {
  assert.equal(resolveAppTimezone({
    env: { CYBERBOSS_TIMEZONE: "Australia/Sydney" },
    localTimezone: "Pacific/Auckland",
  }), "Australia/Sydney");
});

test("invalid CYBERBOSS_TIMEZONE fails closed", () => {
  assert.throws(() => resolveAppTimezone({
    env: { CYBERBOSS_TIMEZONE: "Not/A_Timezone" },
    localTimezone: "Pacific/Auckland",
  }), /Invalid CYBERBOSS_TIMEZONE timezone/u);
});

test("time formatting uses the configured timezone and keeps compatibility exports", () => {
  const options = {
    env: { CYBERBOSS_TIMEZONE: "Australia/Sydney" },
    localTimezone: "Pacific/Auckland",
  };
  const expected = "本地时间 2026-07-12 10:00:00";

  assert.equal(formatAppDateTime("2026-07-12T00:00:00.000Z", options), expected);
  assert.equal(formatBeijingDateTime("2026-07-12T00:00:00.000Z", options), expected);
});

test("sleep window observes cross-midnight boundaries in the specified timezone", () => {
  const timezone = "Australia/Sydney";

  assert.equal(isSleepWindow("2026-07-11T11:59:59.000Z", timezone), false);
  assert.equal(isSleepWindow("2026-07-11T12:00:00.000Z", timezone), true);
  assert.equal(isSleepWindow("2026-07-11T20:29:59.000Z", timezone), true);
  assert.equal(isSleepWindow("2026-07-11T20:30:00.000Z", timezone), false);
  assert.equal(
    new Date(nextWakeTimestamp("2026-07-11T12:15:00.000Z", timezone)).toISOString(),
    "2026-07-11T20:30:00.000Z",
  );
  assert.equal(
    capDelayAtSleepBoundary(12 * 60 * 60_000, Date.parse("2026-07-11T12:15:00.000Z"), timezone),
    8.25 * 60 * 60_000,
  );
});
