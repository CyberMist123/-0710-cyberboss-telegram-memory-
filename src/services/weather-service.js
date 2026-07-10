const AMAP_WEATHER_URL = "https://restapi.amap.com/v3/weather/weatherInfo";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
const DAY_INDEX_BY_NAME = {
  today: 0,
  tomorrow: 1,
  day_after_tomorrow: 2,
};

function createWeatherService({ config }) {
  const resolvedConfig = config || {};

  return {
    async getCurrent() {
      const response = await fetchAmapWeather({ config: resolvedConfig, extensions: "base" });
      return buildCurrentWeatherResult(response);
    },
    async getForecast(options = {}) {
      const response = await fetchAmapWeather({ config: resolvedConfig, extensions: "all" });
      return buildForecastWeatherResult(response, options);
    },
    async getSummary(options = {}) {
      const day = normalizeDay(options.day);
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
      const extensions = normalizeExtensions(options.extensions);
      return fetchAmapWeather({ config: resolvedConfig, extensions });
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

async function fetchWithRetry(url, options) {
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
  throw new Error(`Amap weather fetch failed after ${DEFAULT_MAX_ATTEMPTS} attempts: ${detail}`);
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
  const numeric = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = {
  createWeatherService,
};
