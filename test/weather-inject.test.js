const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runHourlyDesireTick,
  buildDesireTriggerText,
  decideWeatherLine,
  formatWeatherLine,
  readWeatherDeliveredDate,
  writeWeatherDeliveredDate,
} = require("../src/app/hourly-desire-poller");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-weather-inject-"));
}

function alertBrief(overrides = {}) {
  return {
    location: { city: "Waterloo" },
    todayISO: "2026-08-18",
    notable: true,
    alert: {
      hasAlert: true,
      reasons: ["rain", "temp_swing"],
      rain: { probPct: 80 },
      tempSwing: { todayHighC: 26, yesterdayHighC: 19 },
    },
    hourlyRain: { hasRain: true, startHour: "14:00", endHour: "17:00", peakProbPct: 70, peakHour: "15:00" },
    tomorrow: {
      available: true, notable: true, lowC: 12, highC: 20, willRain: true, rainProbPct: 65, weather: "Light rain",
      hourlyRain: { hasRain: true, startHour: "08:00", endHour: "11:00", peakProbPct: 80, peakHour: "09:00" },
    },
    ...overrides,
  };
}

const daySchedule = {
  enabled: true,
  intervalMinutes: 55,
  nightSkipEnabled: false,
  nightStart: "22:00",
  nightEnd: "06:00",
  timezone: "Australia/Sydney",
};

function tickConfig(root, overrides = {}) {
  return {
    activityPauseFile: path.join(root, "activity-pause.json"),
    desireActiveFile: "",
    desireLoopMinimalEnabled: false,
    weatherInjectEnabled: true,
    weatherInjectStateFile: path.join(root, "weather-inject-state.json"),
    ...overrides,
  };
}

function runTick(config, weatherBrief) {
  const queued = [];
  const res = runHourlyDesireTick({
    config,
    schedule: daySchedule,
    tickTime: Date.parse("2026-08-18T02:00:00Z"),
    accountId: "telegram",
    senderId: "user-1",
    workspaceRoot: "/tmp/ws",
    weatherBrief,
    queue: {
      hasPendingForAccount() { return false; },
      enqueue(message) { queued.push(message); return message; },
    },
  });
  return { res, queued };
}

test("decideWeatherLine: off by default yields no line", () => {
  const out = decideWeatherLine({ config: { weatherInjectEnabled: false }, weatherBrief: alertBrief() });
  assert.equal(out.line, "");
});

test("decideWeatherLine: enabled but nothing notable yields no line", () => {
  const brief = alertBrief({
    notable: false,
    alert: { hasAlert: false, reasons: [] },
    hourlyRain: { hasRain: false },
    tomorrow: { available: true, notable: false, lowC: 12, highC: 20, willRain: false, weather: "Clear" },
  });
  const out = decideWeatherLine({ config: { weatherInjectEnabled: true, weatherInjectStateFile: "" }, weatherBrief: brief });
  assert.equal(out.line, "");
});

test("decideWeatherLine: enabled + notable + first today yields a line", () => {
  const out = decideWeatherLine({
    config: { weatherInjectEnabled: true, weatherInjectStateFile: "" },
    weatherBrief: alertBrief(),
  });
  assert.ok(out.line.includes("Waterloo"));
  assert.equal(out.today, "2026-08-18");
});

test("decideWeatherLine fires when only tomorrow is notable (today calm)", () => {
  const brief = alertBrief({
    notable: true,
    alert: { hasAlert: false, reasons: [] },
    hourlyRain: { hasRain: false },
  });
  const out = decideWeatherLine({
    config: { weatherInjectEnabled: true, weatherInjectStateFile: "" },
    weatherBrief: brief,
  });
  assert.ok(out.line.includes("明天"));
});

test("formatWeatherLine renders today timeline, temp swing, and tomorrow", () => {
  const line = formatWeatherLine(alertBrief());
  assert.ok(line.startsWith("[今明天气·可提醒她]"));
  assert.ok(line.includes("14:00–17:00 有雨"));
  assert.ok(line.includes("19→26℃"));
  assert.ok(line.includes("明天"));
  assert.ok(line.includes("08:00–11:00 有雨"));
});

test("delivered-date guard roundtrips", () => {
  const root = tempRoot();
  const file = path.join(root, "weather-inject-state.json");
  assert.equal(readWeatherDeliveredDate(file), "");
  writeWeatherDeliveredDate(file, "2026-08-18");
  assert.equal(readWeatherDeliveredDate(file), "2026-08-18");
});

test("tick appends the weather line and marks delivered; second tick same day does not repeat", () => {
  const root = tempRoot();
  const config = tickConfig(root);

  const first = runTick(config, alertBrief());
  assert.equal(first.res.status, "queued");
  assert.ok(first.queued[0].text.includes("[今明天气·可提醒她]"));
  assert.equal(readWeatherDeliveredDate(config.weatherInjectStateFile), "2026-08-18");

  // 首次 gate：同一天第二次 tick 不再缝天气行。
  const second = runTick(config, alertBrief());
  assert.equal(second.res.status, "queued");
  assert.equal(second.queued[0].text.includes("[今明天气"), false);
});

test("tick with the feature off is byte-identical to the plain trigger text", () => {
  const root = tempRoot();
  const config = tickConfig(root, { weatherInjectEnabled: false });
  const { queued } = runTick(config, alertBrief());
  assert.equal(queued[0].text, buildDesireTriggerText(config));
});

test("tick with no brief leaves the trigger text unchanged even when enabled", () => {
  const root = tempRoot();
  const config = tickConfig(root);
  const { queued } = runTick(config, null);
  assert.equal(queued[0].text, buildDesireTriggerText(config));
  assert.equal(readWeatherDeliveredDate(config.weatherInjectStateFile), "");
});

module.exports = {};
