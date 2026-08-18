const test = require("node:test");
const assert = require("node:assert/strict");

const { createWeatherService, describeWeatherCode } = require("../src/services/weather-service");

const originalFetch = global.fetch;

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

function forecastPayload(overrides = {}) {
  return {
    timezone: "Australia/Sydney",
    current: {
      time: "2026-08-18T18:00",
      temperature_2m: 17.2,
      relative_humidity_2m: 60,
      apparent_temperature: 16.1,
      weather_code: 3,
      wind_speed_10m: 12,
    },
    daily: {
      time: [
        "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
        "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
        "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
        "2026-08-23", "2026-08-24", "2026-08-25",
      ],
      temperature_2m_max: [20, 21, 20, 22, 21, 20, 19, 19, 18, 19, 20, 21, 20, 19, 18],
      temperature_2m_min: [12, 12, 11, 13, 12, 11, 10, 10, 9, 10, 11, 12, 11, 10, 9],
      apparent_temperature_max: [19, 20, 19, 21, 20, 19, 18, 18, 17, 18, 19, 20, 19, 18, 17],
      precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 5, 30, 40, 10, 0, 0, 5, 10],
      precipitation_sum: [0, 0, 0, 0.2, 0, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 0],
      weather_code: [1, 1, 0, 61, 2, 1, 0, 3, 61, 63, 2, 0, 0, 1, 2],
      ...overrides,
    },
  };
}

function installFetch({ geocode, forecast } = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("geocoding-api.open-meteo.com")) {
      return geocode || jsonResponse({
        results: [{
          latitude: -33.8688, longitude: 151.2093, name: "Sydney",
          country_code: "AU", timezone: "Australia/Sydney",
        }],
      });
    }
    if (href.includes("api.open-meteo.com/v1/forecast")) {
      return forecast || jsonResponse(forecastPayload());
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return calls;
}

test.afterEach(() => { global.fetch = originalFetch; });

test("describeWeatherCode maps WMO codes to text", () => {
  assert.equal(describeWeatherCode(0), "Clear");
  assert.equal(describeWeatherCode(61), "Light rain");
  assert.equal(describeWeatherCode(95), "Thunderstorm");
  assert.equal(describeWeatherCode(null), "");
});

test("getCurrent geocodes the city then reads current conditions", async () => {
  const calls = installFetch();
  const svc = createWeatherService({ config: { weatherProvider: "open_meteo", weatherCity: "Sydney" } });
  const res = await svc.getCurrent();
  assert.equal(res.provider, "open_meteo");
  assert.equal(res.current.temperatureC, 17.2);
  assert.equal(res.current.weather, "Overcast");
  assert.equal(res.location.city, "Sydney");
  assert.ok(calls.some((u) => u.includes("geocoding-api")));
  assert.ok(calls.some((u) => u.includes("/v1/forecast")));
});

test("explicit lat/lon skips geocoding", async () => {
  const calls = installFetch();
  const svc = createWeatherService({
    config: { weatherProvider: "open_meteo", weatherLat: "-33.87", weatherLon: "151.21" },
  });
  await svc.getCurrent();
  assert.equal(calls.some((u) => u.includes("geocoding-api")), false);
  assert.ok(calls.some((u) => u.includes("latitude=-33.87")));
});

test("getForecast resolves today and tomorrow by date", async () => {
  installFetch();
  const svc = createWeatherService({ config: { weatherProvider: "open_meteo", weatherCity: "Sydney" } });
  const today = await svc.getForecast({ day: "today" });
  assert.equal(today.forecast.date, "2026-08-18");
  assert.equal(today.forecast.highC, 19);
  const tomorrow = await svc.getForecast({ day: "tomorrow" });
  assert.equal(tomorrow.forecast.date, "2026-08-19");
  assert.equal(tomorrow.forecast.rainProbPercent, 30);
});

test("getDailyBrief returns alert + 7d/7d retention", async () => {
  installFetch({
    forecast: jsonResponse(forecastPayload({
      // today (idx of 2026-08-18) high jumps +7 vs yesterday -> temp_swing
      temperature_2m_max: [20, 21, 20, 22, 21, 20, 19, 26, 18, 19, 20, 21, 20, 19, 18],
      precipitation_probability_max: [10, 5, 0, 20, 15, 10, 5, 80, 30, 40, 10, 0, 0, 5, 10],
    })),
  });
  const svc = createWeatherService({ config: { weatherProvider: "open_meteo", weatherCity: "Sydney" } });
  const brief = await svc.getDailyBrief();
  assert.equal(brief.todayISO, "2026-08-18");
  assert.equal(brief.alert.hasAlert, true);
  assert.ok(brief.alert.reasons.includes("rain"));
  assert.ok(brief.alert.reasons.includes("temp_swing"));
  assert.equal(brief.retention.observed.length, 7);
  assert.equal(brief.retention.observed[6].date, "2026-08-17");
  assert.equal(brief.retention.forecast[0].date, "2026-08-18");
  assert.equal(brief.retention.forecast.length, 7);
});

test("getDailyBrief on a calm day has no alert", async () => {
  installFetch();
  const svc = createWeatherService({ config: { weatherProvider: "open_meteo", weatherCity: "Sydney" } });
  const brief = await svc.getDailyBrief();
  assert.equal(brief.alert.hasAlert, false);
});

test("missing city and lat/lon throws not-configured error", async () => {
  installFetch();
  const svc = createWeatherService({ config: { weatherProvider: "open_meteo" } });
  await assert.rejects(() => svc.getCurrent(), /required for open_meteo/);
});

test("amap remains the default provider and is untouched", async () => {
  const svc = createWeatherService({ config: {} });
  // amap requires a key; with none configured it fails the amap path, proving no open_meteo hijack.
  await assert.rejects(() => svc.getCurrent(), /AMAP|amap|required/i);
});

module.exports = {};
