const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeWeatherAlert,
  buildRetention,
} = require("../src/services/weather-brief");

// 8 rows: 2026-08-11 .. 2026-08-18(today). yesterday=08-17, today=08-18.
function sampleDaily(overrides = {}) {
  return {
    time: [
      "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
      "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
    ],
    temperature_2m_max: [20, 21, 20, 22, 21, 20, 19, 19],
    temperature_2m_min: [12, 12, 11, 13, 12, 11, 10, 10],
    precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 5],
    precipitation_sum: [0, 0, 0, 0.2, 0, 0, 0, 0],
    weather_code: [1, 1, 0, 61, 2, 1, 0, 0],
    ...overrides,
  };
}

test("no alert on a calm day", () => {
  const res = computeWeatherAlert({ daily: sampleDaily(), todayISO: "2026-08-18" });
  assert.equal(res.hasAlert, false);
  assert.deepEqual(res.reasons, []);
});

test("rain alert fires on high probability", () => {
  const daily = sampleDaily({ precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 75] });
  const res = computeWeatherAlert({ daily, todayISO: "2026-08-18" });
  assert.equal(res.hasAlert, true);
  assert.ok(res.reasons.includes("rain"));
  assert.equal(res.rain.probPct, 75);
});

test("rain alert fires when precipitation is present even below prob threshold", () => {
  const daily = sampleDaily({
    precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 40],
    precipitation_sum: [0, 0, 0, 0, 0, 0, 0, 3.4],
  });
  const res = computeWeatherAlert({ daily, todayISO: "2026-08-18" });
  assert.equal(res.hasAlert, true);
  assert.ok(res.reasons.includes("rain"));
  assert.equal(res.rain.precipMm, 3.4);
});

test("temp swing alert fires on >=6C high jump vs yesterday", () => {
  const daily = sampleDaily({ temperature_2m_max: [20, 21, 20, 22, 21, 20, 19, 26] });
  const res = computeWeatherAlert({ daily, todayISO: "2026-08-18" });
  assert.equal(res.hasAlert, true);
  assert.ok(res.reasons.includes("temp_swing"));
  assert.equal(res.tempSwing.highDeltaC, 7);
});

test("temp swing respects a custom threshold", () => {
  const daily = sampleDaily({ temperature_2m_max: [20, 21, 20, 22, 21, 20, 19, 23] });
  const strict = computeWeatherAlert({ daily, todayISO: "2026-08-18", thresholds: { tempDeltaC: 6 } });
  assert.equal(strict.hasAlert, false);
  const loose = computeWeatherAlert({ daily, todayISO: "2026-08-18", thresholds: { tempDeltaC: 3 } });
  assert.equal(loose.hasAlert, true);
});

test("custom rain threshold changes the verdict", () => {
  const daily = sampleDaily({ precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 50] });
  const def = computeWeatherAlert({ daily, todayISO: "2026-08-18" });
  assert.equal(def.hasAlert, false);
  const loose = computeWeatherAlert({ daily, todayISO: "2026-08-18", thresholds: { rainProbPct: 45 } });
  assert.equal(loose.hasAlert, true);
});

test("missing today row yields no alert, no throw", () => {
  const res = computeWeatherAlert({ daily: sampleDaily(), todayISO: "2026-09-01" });
  assert.equal(res.hasAlert, false);
  assert.equal(res.today, null);
});

test("retention splits observed (past, <=7) and forecast (today+future, <=7)", () => {
  const daily = {
    time: [
      "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
      "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
      "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
    ],
    temperature_2m_max: new Array(15).fill(20),
    temperature_2m_min: new Array(15).fill(10),
    precipitation_probability_max: new Array(15).fill(0),
    precipitation_sum: new Array(15).fill(0),
    weather_code: new Array(15).fill(1),
  };
  const { observed, forecast } = buildRetention({ daily, todayISO: "2026-08-18" });
  assert.equal(observed.length, 7);
  assert.equal(observed[observed.length - 1].date, "2026-08-17");
  assert.equal(forecast.length, 6);
  assert.equal(forecast[0].date, "2026-08-18");
});

module.exports = {};
