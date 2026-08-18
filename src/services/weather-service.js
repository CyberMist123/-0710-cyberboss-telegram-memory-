const AMAP_WEATHER_URL = "https://restapi.amap.com/v3/weather/weatherInfo";
const OPEN_METEO_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "cyberboss-weather/0.1.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
const DAY_INDEX_BY_NAME = {
  today: 0,
  tomorrow: 1,
  day_after_tomorrow: 2,
};

const { computeWeatherAlert, computeTomorrow, computeHourlyRain, buildRetention } = require("./weather-brief");

function resolveProvider(config) {
  return normalizeText(config?.weatherProvider || "amap").toLowerCase();
}

function createWeatherService({ config }) {
  const resolvedConfig = config || {};
  const isOpenMeteo = () => resolveProvider(resolvedConfig) === "open_meteo";

  return {
    async getCurrent() {
      if (isOpenMeteo()) {
        return buildOpenMeteoCurrent(await fetchOpenMeteoForecast({ config: resolvedConfig }));
      }
      const response = await fetchAmapWeather({ config: resolvedConfig, extensions: "base" });
      return buildCurrentWeatherResult(response);
    },
    async getForecast(options = {}) {
      if (isOpenMeteo()) {
        return buildOpenMeteoForecast(await fetchOpenMeteoForecast({ config: resolvedConfig }), options);
      }
      const response = await fetchAmapWeather({ config: resolvedConfig, extensions: "all" });
      return buildForecastWeatherResult(response, options);
    },
    async getSummary(options = {}) {
      const day = normalizeDay(options.day);
      if (isOpenMeteo()) {
        const response = await fetchOpenMeteoForecast({ config: resolvedConfig });
        return {
          provider: response.provider,
          location: buildOpenMeteoLocation(response),
          addressNote: response.addressNote,
          day,
          current: buildOpenMeteoCurrent(response).current,
          forecast: buildOpenMeteoForecast(response, { day }).forecast,
        };
      }
      const [currentResponse, forecastResponse] = await Promise.all([
        fetchAmapWeather({ config: resolvedConfig, extensions: "base" }),
        fetchAmapWeather({ config: resolvedConfig, extensions: "all" }),
      ]);
      return buildSummaryWeatherResult({
        currentResponse,
        forecastResponse,
        day,
      });
    },
    async getRaw(options = {}) {
      if (isOpenMeteo()) {
        return fetchOpenMeteoForecast({ config: resolvedConfig });
      }
      const extensions = normalizeExtensions(options.extensions);
      return fetchAmapWeather({ config: resolvedConfig, extensions });
    },
    // Daily brief = alert (rain / temp swing vs yesterday) + 7d observed / 7d forecast.
    // Open-Meteo only (needs daily past+future rows). On-demand, nothing persisted here.
    async getDailyBrief() {
      if (!isOpenMeteo()) {
        throw new Error("getDailyBrief requires the open_meteo provider.");
      }
      const response = await fetchOpenMeteoForecast({ config: resolvedConfig });
      const daily = response.payload?.daily || {};
      const hourly = response.payload?.hourly || {};
      const nowISO = normalizeText(response.payload?.current?.time);
      const todayISO = nowISO.slice(0, 10);
      const thresholds = {
        rainProbPct: normalizeNumber(resolvedConfig.weatherRainProbPct),
        tempDeltaC: normalizeNumber(resolvedConfig.weatherTempDeltaC),
      };
      const alert = computeWeatherAlert({ daily, todayISO, thresholds });
      const tomorrowRaw = computeTomorrow({ daily, todayISO, thresholds });
      const tomorrow = tomorrowRaw.available
        ? {
            ...tomorrowRaw,
            weather: describeWeatherCode(tomorrowRaw.weatherCode),
            hourlyRain: computeHourlyRain({ hourly, nowISO, targetDate: tomorrowRaw.date, thresholds }),
          }
        : tomorrowRaw;
      return {
        provider: response.provider,
        location: buildOpenMeteoLocation(response),
        todayISO,
        current: buildOpenMeteoCurrent(response).current,
        alert,
        hourlyRain: computeHourlyRain({ hourly, nowISO, thresholds }),
        tomorrow,
        notable: Boolean(alert.hasAlert || tomorrow.notable),
        retention: buildRetention({ daily, todayISO }),
      };
    },
  };
}

async function fetchAmapWeather({ config, extensions }) {
  const provider = normalizeText(config.weatherProvider || "amap").toLowerCase();
  if (provider !== "amap") {
    throw new Error(`Unsupported weather provider: ${provider || "unknown"}`);
  }

  const key = normalizeText(config.amapWeatherKey);
  if (!key) {
    throw new Error("CYBERBOSS_AMAP_WEATHER_KEY is required.");
  }

  const query = resolveWeatherQuery(config);
  const normalizedExtensions = normalizeExtensions(extensions);
  const url = new URL(AMAP_WEATHER_URL);
  url.searchParams.set("key", key);
  url.searchParams.set("city", query.value);
  url.searchParams.set("extensions", normalizedExtensions);
  url.searchParams.set("output", "JSON");

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "cyberboss-weather/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Amap weather request failed: ${response.status}`);
  }

  const payload = await response.json();
  if (String(payload?.status || "") !== "1" || String(payload?.infocode || "") !== "10000") {
    const info = normalizeText(payload?.info) || "unknown_error";
    const infocode = normalizeText(payload?.infocode);
    throw new Error(`Amap weather request failed: ${info}${infocode ? ` (${infocode})` : ""}`);
  }

  return {
    provider,
    query,
    extensions: normalizedExtensions,
    addressNote: normalizeText(config.weatherAddress),
    payload,
  };
}

async function fetchWithRetry(url, options, label = "Amap weather") {
  let lastError = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options, DEFAULT_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt >= DEFAULT_MAX_ATTEMPTS) {
        break;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  const detail = formatFetchError(lastError);
  throw new Error(`${label} fetch failed after ${DEFAULT_MAX_ATTEMPTS} attempts: ${detail}`);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  } finally {
    clearTimeout(timer);
  }
}

function buildCurrentWeatherResult(response) {
  const live = getLiveRecord(response?.payload);
  return {
    provider: response.provider,
    query: response.query,
    extensions: response.extensions,
    addressNote: response.addressNote,
    location: {
      province: normalizeText(live.province),
      city: normalizeText(live.city),
      adcode: normalizeText(live.adcode),
    },
    current: {
      weather: normalizeText(live.weather),
      temperatureC: normalizeNumber(live.temperature),
      humidityPercent: normalizeNumber(live.humidity),
      windDirection: normalizeText(live.winddirection),
      windPower: normalizeText(live.windpower),
      reportTime: normalizeText(live.reporttime),
    },
  };
}

function buildForecastWeatherResult(response, options = {}) {
  const day = normalizeDay(options.day);
  const forecast = getForecastRecord(response?.payload);
  const casts = Array.isArray(forecast.casts) ? forecast.casts : [];
  const dayIndex = resolveDayIndex(day, casts.length);
  const cast = casts[dayIndex] || {};
  return {
    provider: response.provider,
    query: response.query,
    extensions: response.extensions,
    addressNote: response.addressNote,
    day,
    dayIndex,
    location: {
      province: normalizeText(forecast.province),
      city: normalizeText(forecast.city),
      adcode: normalizeText(forecast.adcode),
    },
    forecast: {
      date: normalizeText(cast.date),
      week: normalizeText(cast.week),
      dayWeather: normalizeText(cast.dayweather),
      nightWeather: normalizeText(cast.nightweather),
      highC: normalizeNumber(cast.daytemp),
      lowC: normalizeNumber(cast.nighttemp),
      dayWind: normalizeText(cast.daywind),
      nightWind: normalizeText(cast.nightwind),
      dayPower: normalizeText(cast.daypower),
      nightPower: normalizeText(cast.nightpower),
      reportTime: normalizeText(forecast.reporttime),
    },
  };
}

function buildSummaryWeatherResult({ currentResponse, forecastResponse, day }) {
  const current = buildCurrentWeatherResult(currentResponse);
  const forecast = buildForecastWeatherResult(forecastResponse, { day });
  return {
    provider: current.provider,
    query: current.query,
    addressNote: current.addressNote || forecast.addressNote,
    day: forecast.day,
    location: current.location.city || current.location.adcode ? current.location : forecast.location,
    current: current.current,
    forecast: forecast.forecast,
  };
}

function getLiveRecord(payload) {
  return Array.isArray(payload?.lives) ? payload.lives[0] || {} : {};
}

function getForecastRecord(payload) {
  if (Array.isArray(payload?.forecasts)) {
    return payload.forecasts[0] || {};
  }
  if (payload?.forecast && typeof payload.forecast === "object") {
    return payload.forecast;
  }
  return {};
}

function normalizeExtensions(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "base" ? "base" : "all";
}

function normalizeDay(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "today";
  }
  if (Object.prototype.hasOwnProperty.call(DAY_INDEX_BY_NAME, normalized)) {
    return normalized;
  }
  throw new Error(`Unsupported forecast day: ${value}`);
}

function resolveDayIndex(day, castLength) {
  const fallbackIndex = DAY_INDEX_BY_NAME[day] ?? 0;
  if (!Number.isFinite(castLength) || castLength <= 0) {
    return fallbackIndex;
  }
  return Math.max(0, Math.min(castLength - 1, fallbackIndex));
}

function resolveWeatherQuery(config) {
  const adcode = normalizeText(config.weatherAdcode);
  if (adcode) {
    return { type: "adcode", value: adcode };
  }

  const city = normalizeText(config.weatherCity);
  if (city) {
    return { type: "city", value: city };
  }

  throw new Error("CYBERBOSS_WEATHER_ADCODE or CYBERBOSS_WEATHER_CITY is required.");
}

function formatFetchError(error) {
  const message = normalizeText(error?.message);
  const causeMessage = normalizeText(error?.cause?.message);
  const causeCode = normalizeText(error?.cause?.code);
  if (causeMessage && causeCode) {
    return `${causeMessage} (${causeCode})`;
  }
  if (causeMessage) {
    return causeMessage;
  }
  if (message) {
    return message;
  }
  return "unknown fetch error";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number.parseFloat(String(value).trim());
  return Number.isFinite(numeric) ? numeric : null;
}

// ---- Open-Meteo provider (key-free REST; suits Sydney/overseas) ----

const WMO_WEATHER_TEXT = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
  85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};

function describeWeatherCode(code) {
  const numeric = normalizeNumber(code);
  if (numeric == null) return "";
  return WMO_WEATHER_TEXT[numeric] || `code ${numeric}`;
}

async function resolveOpenMeteoLocation({ config }) {
  const lat = normalizeNumber(config.weatherLat);
  const lon = normalizeNumber(config.weatherLon);
  if (lat != null && lon != null) {
    return {
      latitude: lat,
      longitude: lon,
      name: normalizeText(config.weatherCity),
      country: normalizeText(config.weatherCountry),
    };
  }

  const city = normalizeText(config.weatherCity);
  if (!city) {
    throw new Error("CYBERBOSS_WEATHER_CITY or CYBERBOSS_WEATHER_LAT/LON is required for open_meteo.");
  }
  const url = new URL(OPEN_METEO_GEOCODE_URL);
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetchWithRetry(
    url,
    { method: "GET", headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    "Open-Meteo geocoding",
  );
  if (!response.ok) {
    throw new Error(`Open-Meteo geocoding request failed: ${response.status}`);
  }
  const payload = await response.json();
  const hit = Array.isArray(payload?.results) ? payload.results[0] : null;
  if (!hit) {
    throw new Error(`Open-Meteo geocoding: no match for "${city}".`);
  }
  return {
    latitude: normalizeNumber(hit.latitude),
    longitude: normalizeNumber(hit.longitude),
    name: normalizeText(hit.name) || city,
    country: normalizeText(hit.country_code),
    timezone: normalizeText(hit.timezone),
  };
}

async function fetchOpenMeteoForecast({ config }) {
  const location = await resolveOpenMeteoLocation({ config });
  const url = new URL(OPEN_METEO_FORECAST_URL);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,precipitation_sum,weather_code",
  );
  url.searchParams.set("hourly", "precipitation,precipitation_probability");
  url.searchParams.set("past_days", "7");
  url.searchParams.set("forecast_days", "8");
  url.searchParams.set("timezone", "auto");

  const response = await fetchWithRetry(
    url,
    { method: "GET", headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
    "Open-Meteo forecast",
  );
  if (!response.ok) {
    throw new Error(`Open-Meteo forecast request failed: ${response.status}`);
  }
  const payload = await response.json();
  return {
    provider: "open_meteo",
    location,
    addressNote: normalizeText(config.weatherAddress),
    payload,
  };
}

function buildOpenMeteoLocation(response) {
  const loc = response?.location || {};
  return {
    city: normalizeText(loc.name),
    country: normalizeText(loc.country),
    latitude: normalizeNumber(loc.latitude),
    longitude: normalizeNumber(loc.longitude),
    timezone: normalizeText(loc.timezone) || normalizeText(response?.payload?.timezone),
  };
}

function buildOpenMeteoCurrent(response) {
  const current = response?.payload?.current || {};
  return {
    provider: response.provider,
    location: buildOpenMeteoLocation(response),
    addressNote: response.addressNote,
    current: {
      weather: describeWeatherCode(current.weather_code),
      temperatureC: normalizeNumber(current.temperature_2m),
      apparentTemperatureC: normalizeNumber(current.apparent_temperature),
      humidityPercent: normalizeNumber(current.relative_humidity_2m),
      windSpeed: normalizeNumber(current.wind_speed_10m),
      reportTime: normalizeText(current.time),
    },
  };
}

function buildOpenMeteoForecast(response, options = {}) {
  const day = normalizeDay(options.day);
  const daily = response?.payload?.daily || {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  const todayISO = normalizeText(response?.payload?.current?.time).slice(0, 10);
  const todayIdx = times.indexOf(todayISO);
  const baseIdx = todayIdx >= 0 ? todayIdx : 0;
  const offset = DAY_INDEX_BY_NAME[day] ?? 0;
  const idx = Math.max(0, Math.min(times.length - 1, baseIdx + offset));
  return {
    provider: response.provider,
    location: buildOpenMeteoLocation(response),
    addressNote: response.addressNote,
    day,
    dayIndex: offset,
    forecast: {
      date: normalizeText(times[idx]),
      dayWeather: describeWeatherCode(daily.weather_code?.[idx]),
      highC: normalizeNumber(daily.temperature_2m_max?.[idx]),
      lowC: normalizeNumber(daily.temperature_2m_min?.[idx]),
      apparentHighC: normalizeNumber(daily.apparent_temperature_max?.[idx]),
      rainProbPercent: normalizeNumber(daily.precipitation_probability_max?.[idx]),
      precipitationMm: normalizeNumber(daily.precipitation_sum?.[idx]),
    },
  };
}

module.exports = {
  createWeatherService,
  describeWeatherCode,
};
