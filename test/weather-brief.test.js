const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeWeatherAlert,
  computeTomorrow,
  computeHourlyRain,
  buildRetention,
} = require("../src/services/weather-brief");

function twoDayDaily({ maxes, mins, probs, precips, codes } = {}) {
  return {
    time: ["2026-08-17", "2026-08-18", "2026-08-19"],
    temperature_2m_max: maxes ?? [20, 19, 18],
    temperature_2m_min: mins ?? [11, 10, 9],
    precipitation_probability_max: probs ?? [5, 5, 5],
    precipitation_sum: precips ?? [0, 0, 0],
    weather_code: codes ?? [1, 3, 1],
  };
}

function hourlyToday(rain = {}) {
  const time = [];
  const prob = [];
  const precip = [];
  for (let h = 0; h < 24; h += 1) {
    time.push(`2026-08-18T${String(h).padStart(2, "0")}:00`);
    prob.push(rain.prob?.[h] ?? 0);
    precip.push(rain.precip?.[h] ?? 0);
  }
  return { time, precipitation_probability: prob, precipitation: precip };
}

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

test("computeTomorrow flags rain tomorrow as notable", () => {
  const t = computeTomorrow({ daily: twoDayDaily({ probs: [5, 5, 70], precips: [0, 0, 2], codes: [1, 3, 61] }), todayISO: "2026-08-18" });
  assert.equal(t.available, true);
  assert.equal(t.date, "2026-08-19");
  assert.equal(t.willRain, true);
  assert.equal(t.notable, true);
});

test("computeTomorrow flags a big temp change vs today", () => {
  const t = computeTomorrow({ daily: twoDayDaily({ maxes: [20, 19, 27] }), todayISO: "2026-08-18" });
  assert.equal(t.bigTempChange, true);
  assert.equal(t.highDeltaVsTodayC, 8);
  assert.equal(t.notable, true);
});

test("computeTomorrow calm tomorrow is not notable", () => {
  const t = computeTomorrow({ daily: twoDayDaily({ maxes: [20, 19, 20], probs: [5, 5, 10] }), todayISO: "2026-08-18" });
  assert.equal(t.available, true);
  assert.equal(t.notable, false);
});

test("computeTomorrow with no tomorrow row is unavailable", () => {
  const daily = { time: ["2026-08-18"], temperature_2m_max: [19], temperature_2m_min: [10], precipitation_probability_max: [5], precipitation_sum: [0], weather_code: [3] };
  const t = computeTomorrow({ daily, todayISO: "2026-08-18" });
  assert.equal(t.available, false);
  assert.equal(t.notable, false);
});

test("computeHourlyRain finds the upcoming window and peak today", () => {
  const hourly = hourlyToday({ prob: { 14: 65, 15: 80, 16: 70 }, precip: { 14: 0.2, 15: 1.1, 16: 0.4 } });
  const res = computeHourlyRain({ hourly, nowISO: "2026-08-18T10:00" });
  assert.equal(res.hasRain, true);
  assert.equal(res.startHour, "14:00");
  assert.equal(res.endHour, "17:00");
  assert.equal(res.peakProbPct, 80);
  assert.equal(res.peakHour, "15:00");
});

test("computeHourlyRain ignores rain already in the past", () => {
  const hourly = hourlyToday({ prob: { 8: 90, 9: 85 }, precip: { 8: 2, 9: 1 } });
  const res = computeHourlyRain({ hourly, nowISO: "2026-08-18T14:00" });
  assert.equal(res.hasRain, false);
});

test("computeHourlyRain triggers on precipitation even below prob threshold", () => {
  const hourly = hourlyToday({ prob: { 20: 30 }, precip: { 20: 0.6 } });
  const res = computeHourlyRain({ hourly, nowISO: "2026-08-18T18:00" });
  assert.equal(res.hasRain, true);
  assert.equal(res.startHour, "20:00");
});

test("computeHourlyRain for a future targetDate covers the whole day", () => {
  const time = [];
  const prob = [];
  const precip = [];
  for (const d of ["2026-08-18", "2026-08-19"]) {
    for (let h = 0; h < 24; h += 1) {
      time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      prob.push(0);
      precip.push(0);
    }
  }
  const at = (d, h) => (d === "2026-08-19" ? 24 : 0) + h;
  [8, 9, 10].forEach((h) => {
    prob[at("2026-08-19", h)] = h === 9 ? 85 : 60;
    precip[at("2026-08-19", h)] = 1;
  });
  const hourly = { time, precipitation_probability: prob, precipitation: precip };
  const res = computeHourlyRain({ hourly, nowISO: "2026-08-18T18:00", targetDate: "2026-08-19" });
  assert.equal(res.hasRain, true);
  assert.equal(res.startHour, "08:00");
  assert.equal(res.endHour, "11:00");
  assert.equal(res.peakProbPct, 85);
});

module.exports = {};
