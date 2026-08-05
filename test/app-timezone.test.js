const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  capDelayAtSleepBoundary,
  isSleepWindow,
  nextWakeTimestamp,
} = require("../src/app/system-checkin-poller");
const { resolveAppTimezone } = require("../src/utils/app-timezone");
const { DEFAULT_SLEEP_WINDOW, SleepWindowStore } = require("../src/core/sleep-window-store");
const { formatAppDateTime } = require("../src/utils/app-time");
const { describeAppTimezone } = require("../src/utils/app-timezone");

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
});

// The host fallback is legitimate but silent: without this the machine's own
// setting decides what "local time" means and nothing ever says so.
test("timezone resolution reports whether it was declared or inherited from the host", () => {
  assert.deepEqual(
    describeAppTimezone({ env: { CYBERBOSS_TIMEZONE: "Australia/Sydney" }, localTimezone: "Pacific/Auckland" }),
    { timezone: "Australia/Sydney", source: "CYBERBOSS_TIMEZONE" },
  );
  assert.deepEqual(
    describeAppTimezone({ env: {}, localTimezone: "Pacific/Auckland" }),
    { timezone: "Pacific/Auckland", source: "host" },
  );
});

test("sleep window observes cross-midnight boundaries in the specified timezone", () => {
  const timezone = "Australia/Sydney";

  assert.equal(isSleepWindow("2026-07-11T13:59:59.000Z", timezone), false);
  assert.equal(isSleepWindow("2026-07-11T14:00:00.000Z", timezone), true);
  assert.equal(isSleepWindow("2026-07-11T19:59:59.000Z", timezone), true);
  assert.equal(isSleepWindow("2026-07-11T20:00:00.000Z", timezone), false);
  assert.equal(
    new Date(nextWakeTimestamp("2026-07-11T14:15:00.000Z", timezone)).toISOString(),
    "2026-07-11T20:00:00.000Z",
  );
  assert.equal(
    capDelayAtSleepBoundary(12 * 60 * 60_000, Date.parse("2026-07-11T14:15:00.000Z"), timezone),
    5.75 * 60 * 60_000,
  );
});

test("sleep window store fails open without writing and reloads each call", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sleep-window-"));
  const filePath = path.join(root, "sleep-window.json");
  const store = new SleepWindowStore({ filePath });
  try {
    assert.deepEqual(store.getWindow(), DEFAULT_SLEEP_WINDOW);
    assert.equal(fs.existsSync(filePath), false);

    const invalidValues = [
      "{broken",
      JSON.stringify({ start: "23:30" }),
      JSON.stringify({ start: "24:00", end: "05:00" }),
      JSON.stringify({ start: "05:00", end: "05:00" }),
    ];
    for (const raw of invalidValues) {
      fs.writeFileSync(filePath, raw, "utf8");
      assert.deepEqual(store.getWindow(), DEFAULT_SLEEP_WINDOW);
      assert.equal(fs.readFileSync(filePath, "utf8"), raw);
    }

    fs.writeFileSync(filePath, JSON.stringify({ start: "23:30", end: "05:00" }), "utf8");
    assert.deepEqual(store.getWindow(), { start: "23:30", end: "05:00" });
    fs.writeFileSync(filePath, JSON.stringify({ start: "21:15", end: "04:45" }), "utf8");
    assert.deepEqual(store.getWindow(), { start: "21:15", end: "04:45" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured cross-midnight window, timezone, wake, and cap boundaries stay exact", () => {
  const timezone = "Australia/Sydney";
  const sleepWindow = { start: "23:30", end: "05:00" };

  assert.equal(isSleepWindow("2026-07-11T13:29:00.000Z", timezone, sleepWindow), false);
  assert.equal(isSleepWindow("2026-07-11T13:30:00.000Z", timezone, sleepWindow), true);
  assert.equal(isSleepWindow("2026-07-11T18:59:00.000Z", timezone, sleepWindow), true);
  assert.equal(isSleepWindow("2026-07-11T19:00:00.000Z", timezone, sleepWindow), false);
  assert.equal(
    new Date(nextWakeTimestamp("2026-07-11T14:00:00.000Z", timezone, sleepWindow)).toISOString(),
    "2026-07-11T19:00:00.000Z",
  );
  assert.equal(
    new Date(nextWakeTimestamp("2026-07-11T20:00:00.000Z", timezone, sleepWindow)).toISOString(),
    "2026-07-12T19:00:00.000Z",
  );
  assert.equal(
    capDelayAtSleepBoundary(12 * 60 * 60_000, Date.parse("2026-07-11T14:00:00.000Z"), timezone, sleepWindow),
    5 * 60 * 60_000,
  );
  assert.equal(
    capDelayAtSleepBoundary(12 * 60 * 60_000, Date.parse("2026-07-11T20:00:00.000Z"), timezone, sleepWindow),
    12 * 60 * 60_000,
  );
});
