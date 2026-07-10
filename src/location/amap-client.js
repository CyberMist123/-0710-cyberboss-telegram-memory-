const AMAP_REVERSE_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/regeo";
const AMAP_POI_AROUND_URL = "https://restapi.amap.com/v3/place/around";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REVERSE_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_POI_CACHE_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 800;

function createAmapClient({
  key = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  reverseCacheTtlMs = DEFAULT_REVERSE_CACHE_TTL_MS,
  poiCacheTtlMs = DEFAULT_POI_CACHE_TTL_MS,
} = {}) {
  const normalizedKey = normalizeText(key);
  const reverseCache = new Map();
  const poiCache = new Map();
  return {
    async reverseGeocode({ latitude, longitude, isGcj02 = false } = {}) {
      const coords = normalizeCoordinates({ latitude, longitude });
      if (!coords) {
        return createEmptyReverseGeocodeResult();
      }
      if (!normalizedKey) {
        return createEmptyReverseGeocodeResult();
      }
      const cacheKey = `regeo:${roundCoord(coords.latitude)}:${roundCoord(coords.longitude)}:${isGcj02 ? "gcj" : "wgs"}`;
      const cached = getFreshCacheValue(reverseCache, cacheKey, reverseCacheTtlMs);
      if (cached) {
        return cached;
      }
      const url = new URL(AMAP_REVERSE_GEOCODE_URL);
      url.searchParams.set("key", normalizedKey);
      url.searchParams.set("location", `${coords.longitude},${coords.latitude}`);
      url.searchParams.set("extensions", "all");
      url.searchParams.set("radius", "200");
      url.searchParams.set("roadlevel", "1");
      url.searchParams.set("output", "JSON");
      try {
        const response = await fetchAmapJson(url, {
          timeoutMs,
          maxAttempts,
          userAgent: "cyberboss-location/0.1.0",
        });
        const result = buildReverseGeocodeResult(response);
        reverseCache.set(cacheKey, { expiresAt: Date.now() + reverseCacheTtlMs, value: result });
        return result;
      } catch {
        return createEmptyReverseGeocodeResult();
      }
    },

    async searchNearbyPoi({ latitude, longitude, radiusMeters = 300, keywords = "", types = "", isGcj02 = false } = {}) {
      const coords = normalizeCoordinates({ latitude, longitude });
      if (!coords) {
        return [];
      }
      if (!normalizedKey) {
        return [];
      }
      const radius = normalizePositiveInt(radiusMeters, 300);
      const normalizedKeywords = normalizeText(keywords);
      const normalizedTypes = normalizeText(types);
      const cacheKey = [
        "poi",
        roundCoord(coords.latitude),
        roundCoord(coords.longitude),
        radius,
        normalizedKeywords,
        normalizedTypes,
        isGcj02 ? "gcj" : "wgs",
      ].join(":");
      const cached = getFreshCacheValue(poiCache, cacheKey, poiCacheTtlMs);
      if (cached) {
        return cached;
      }
      const url = new URL(AMAP_POI_AROUND_URL);
      url.searchParams.set("key", normalizedKey);
      url.searchParams.set("location", `${coords.longitude},${coords.latitude}`);
      url.searchParams.set("radius", String(radius));
      url.searchParams.set("offset", "10");
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "base");
      url.searchParams.set("sortrule", "distance");
      url.searchParams.set("output", "JSON");
      if (normalizedKeywords) {
        url.searchParams.set("keywords", normalizedKeywords);
      }
      if (normalizedTypes) {
        url.searchParams.set("types", normalizedTypes);
      }
      try {
        const response = await fetchAmapJson(url, {
          timeoutMs,
          maxAttempts,
          userAgent: "cyberboss-location/0.1.0",
        });
        const result = buildPoiResult(response);
        poiCache.set(cacheKey, { expiresAt: Date.now() + poiCacheTtlMs, value: result });
        return result;
      } catch {
        return [];
      }
    },
  };
}

async function fetchAmapJson(url, { timeoutMs, maxAttempts, userAgent } = {}) {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": normalizeText(userAgent) || "cyberboss-location/0.1.0",
    },
  }, timeoutMs, maxAttempts);
  if (!response.ok) {
    throw new Error(`Amap request failed: ${response.status}`);
  }
  const payload = await response.json();
  if (String(payload?.status || "") !== "1" || String(payload?.infocode || "") !== "10000") {
    const info = normalizeText(payload?.info) || "unknown_error";
    const infocode = normalizeText(payload?.infocode);
    throw new Error(`Amap request failed: ${info}${infocode ? ` (${infocode})` : ""}`);
  }
  return payload;
}

async function fetchWithRetry(url, options, timeoutMs, maxAttempts) {
  let lastError = null;
  const attempts = normalizePositiveInt(maxAttempts, DEFAULT_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("unknown fetch error");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const resolvedTimeoutMs = normalizePositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${resolvedTimeoutMs}ms`)), resolvedTimeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildReverseGeocodeResult(payload) {
  const regeocode = payload?.regeocode && typeof payload.regeocode === "object"
    ? payload.regeocode
    : {};
  const addressComponent = regeocode?.addressComponent && typeof regeocode.addressComponent === "object"
    ? regeocode.addressComponent
    : {};
  const pois = Array.isArray(regeocode?.pois) ? regeocode.pois : [];
  const topPoi = buildPoiEntry(pois[0]);
  return {
    formattedAddress: normalizeText(regeocode?.formatted_address),
    city: normalizeCityValue(addressComponent?.city),
    district: normalizeText(addressComponent?.district),
    poi: topPoi?.name || "",
    placeTag: "",
    province: normalizeText(addressComponent?.province),
    township: normalizeText(addressComponent?.township),
    adcode: normalizeText(addressComponent?.adcode),
    pois: pois.map(buildPoiEntry).filter(Boolean),
  };
}

function buildPoiResult(payload) {
  const pois = Array.isArray(payload?.pois) ? payload.pois : [];
  return pois.map(buildPoiEntry).filter(Boolean);
}

function buildPoiEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = normalizeText(value.name);
  if (!name) {
    return null;
  }
  return {
    name,
    type: normalizeText(value.type),
    address: normalizeText(value.address),
    distanceMeters: normalizeFiniteNumber(value.distance),
    location: normalizeText(value.location),
  };
}

function createEmptyReverseGeocodeResult() {
  return {
    formattedAddress: "",
    city: "",
    district: "",
    poi: "",
    placeTag: "",
    province: "",
    township: "",
    adcode: "",
    pois: [],
  };
}

function getFreshCacheValue(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function normalizeCoordinates({ latitude, longitude } = {}) {
  const lat = normalizeFiniteNumber(latitude);
  const lng = normalizeFiniteNumber(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { latitude: lat, longitude: lng };
}

function normalizeCityValue(value) {
  if (Array.isArray(value)) {
    return normalizeText(value[0]);
  }
  return normalizeText(value);
}

function roundCoord(value) {
  const numeric = normalizeFiniteNumber(value);
  return Number.isFinite(numeric) ? numeric.toFixed(4) : "";
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createAmapClient,
};
