function createPlaceResolver({ geocoder, knownPlaces = [], placeRadiusMeters = 150 } = {}) {
  const normalizedKnownPlaces = normalizeKnownPlaces(knownPlaces, placeRadiusMeters);
  return {
    async resolvePoint({ latitude, longitude, isGcj02 = false, address = "", placeTag = "", notes = "" } = {}) {
      const lat = normalizeFiniteNumber(latitude);
      const lng = normalizeFiniteNumber(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return createFallbackPlaceResult({ address, placeTag, notes });
      }
      const matchedPlace = matchKnownPlace({ latitude: lat, longitude: lng }, normalizedKnownPlaces);
      const geocoderResult = geocoder && typeof geocoder.reverseGeocode === "function"
        ? await geocoder.reverseGeocode({ latitude: lat, longitude: lng, isGcj02 })
        : null;
      const poiItems = geocoder && typeof geocoder.searchNearbyPoi === "function"
        ? await geocoder.searchNearbyPoi({ latitude: lat, longitude: lng, isGcj02, radiusMeters: 300 })
        : [];
      const topPoi = pickTopPoi(geocoderResult?.pois, poiItems);
      const resolvedPlaceTag = resolvePlaceTag({
        explicitTag: placeTag,
        matchedPlace,
        poi: topPoi,
        geocoderResult,
        address,
        notes,
      });
      const resolvedAddress = normalizeText(geocoderResult?.formattedAddress) || normalizeText(address);
      const resolvedCity = normalizeText(geocoderResult?.city);
      const resolvedDistrict = normalizeText(geocoderResult?.district);
      const resolvedPoiName = normalizeText(topPoi?.name) || normalizeText(geocoderResult?.poi);
      const placeSource = resolvePlaceSource({ explicitTag: placeTag, matchedPlace, poi: topPoi, geocoderResult, resolvedAddress });
      return {
        placeName: buildPlaceName({
          placeTag: resolvedPlaceTag,
          knownPlaceName: matchedPlace?.name,
          poi: resolvedPoiName,
          district: resolvedDistrict,
          city: resolvedCity,
          formattedAddress: resolvedAddress,
          notes,
        }),
        district: resolvedDistrict,
        city: resolvedCity,
        poi: resolvedPoiName,
        placeTag: resolvedPlaceTag,
        placeCategory: classifyPlaceCategory(resolvedPlaceTag),
        placeSource,
        poiType: normalizeText(topPoi?.type),
        formattedAddress: resolvedAddress,
        adcode: normalizeText(geocoderResult?.adcode),
      };
    },
  };
}

function createFallbackPlaceResult({ address = "", placeTag = "", notes = "" } = {}) {
  const normalizedAddress = normalizeText(address);
  const normalizedPlaceTag = normalizeText(placeTag);
  return {
    placeName: normalizedPlaceTag || normalizedAddress || normalizeText(notes) || "unknown",
    district: "",
    city: "",
    poi: "",
    placeTag: canonicalizePlaceTag(normalizedPlaceTag) || "unknown",
    placeCategory: classifyPlaceCategory(normalizedPlaceTag),
    placeSource: "fallback",
    poiType: "",
    formattedAddress: normalizedAddress,
    adcode: "",
  };
}

function pickTopPoi(primaryPois, fallbackPois) {
  const primary = Array.isArray(primaryPois) ? primaryPois.find((item) => normalizeText(item?.name)) : null;
  if (primary) {
    return primary;
  }
  return Array.isArray(fallbackPois) ? fallbackPois.find((item) => normalizeText(item?.name)) || null : null;
}

function buildPlaceName({ placeTag = "", knownPlaceName = "", poi = "", district = "", city = "", formattedAddress = "", notes = "" } = {}) {
  if (normalizeText(knownPlaceName)) {
    return knownPlaceName;
  }
  if (normalizeText(placeTag) === "home") {
    return "家附近";
  }
  if (normalizeText(placeTag) === "office") {
    return "公司附近";
  }
  if (normalizeText(placeTag) === "residential") {
    return "住宅区附近";
  }
  if (normalizeText(placeTag) === "transit") {
    return "交通枢纽附近";
  }
  if (normalizeText(placeTag) === "retail") {
    return "商圈附近";
  }
  if (normalizeText(placeTag) === "food") {
    return "餐饮区附近";
  }
  if (normalizeText(placeTag) === "recreation") {
    return "休闲场所附近";
  }
  if (normalizeText(poi)) {
    return poi;
  }
  if (normalizeText(district) && normalizeText(city)) {
    return `${city}${district}`;
  }
  return normalizeText(formattedAddress) || normalizeText(notes) || normalizeText(placeTag) || "unknown";
}

function normalizeKnownPlaces(knownPlaces, radiusMeters) {
  if (!Array.isArray(knownPlaces)) {
    return [];
  }
  return knownPlaces
    .map((item) => normalizeKnownPlace(item, radiusMeters))
    .filter(Boolean);
}

function normalizeKnownPlace(value, radiusMeters) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const latitude = normalizeFiniteNumber(value.latitude);
  const longitude = normalizeFiniteNumber(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return {
    tag: canonicalizePlaceTag(value.tag),
    name: normalizeText(value.name) || normalizeText(value.label),
    latitude,
    longitude,
    radiusMeters: normalizePositiveInt(value.radiusMeters, radiusMeters),
  };
}

function resolvePlaceTag({ explicitTag = "", matchedPlace = null, poi = null, geocoderResult = null, address = "", notes = "" } = {}) {
  const explicit = canonicalizePlaceTag(explicitTag);
  if (explicit) {
    return explicit;
  }
  const matched = canonicalizePlaceTag(matchedPlace?.tag);
  if (matched) {
    return matched;
  }
  const poiTag = classifyPlaceTagFromText([
    normalizeText(poi?.name),
    normalizeText(poi?.type),
    normalizeText(poi?.address),
  ].filter(Boolean).join(" "));
  if (poiTag) {
    return poiTag;
  }
  const addressTag = classifyPlaceTagFromText([
    normalizeText(geocoderResult?.formattedAddress),
    normalizeText(address),
    normalizeText(notes),
  ].filter(Boolean).join(" "));
  return addressTag || "unknown";
}

function resolvePlaceSource({ explicitTag = "", matchedPlace = null, poi = null, geocoderResult = null, resolvedAddress = "" } = {}) {
  if (canonicalizePlaceTag(explicitTag)) {
    return "explicit";
  }
  if (matchedPlace) {
    return "known_place";
  }
  if (normalizeText(poi?.name)) {
    return "poi";
  }
  if (normalizeText(geocoderResult?.formattedAddress) || normalizeText(resolvedAddress)) {
    return "geocode";
  }
  return "fallback";
}

function classifyPlaceCategory(placeTag) {
  const normalized = canonicalizePlaceTag(placeTag) || "unknown";
  if (normalized === "home" || normalized === "residential") {
    return "residential";
  }
  if (normalized === "office" || normalized === "education" || normalized === "healthcare") {
    return "structured";
  }
  if (normalized === "retail" || normalized === "food" || normalized === "hotel") {
    return "commercial";
  }
  if (normalized === "transit") {
    return "transit";
  }
  if (normalized === "recreation") {
    return "leisure";
  }
  return "unknown";
}

function canonicalizePlaceTag(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (["home", "house", "family"].includes(normalized)) {
    return "home";
  }
  if (["work", "office", "company", "workplace"].includes(normalized)) {
    return "office";
  }
  if (["residential", "residence", "apartment", "community"].includes(normalized)) {
    return "residential";
  }
  if (["transit", "station", "airport", "subway"].includes(normalized)) {
    return "transit";
  }
  if (["retail", "mall", "shopping", "store", "supermarket"].includes(normalized)) {
    return "retail";
  }
  if (["food", "restaurant", "cafe"].includes(normalized)) {
    return "food";
  }
  if (["recreation", "park", "gym", "stadium"].includes(normalized)) {
    return "recreation";
  }
  if (["healthcare", "hospital", "clinic"].includes(normalized)) {
    return "healthcare";
  }
  if (["education", "school", "campus", "university"].includes(normalized)) {
    return "education";
  }
  if (["hotel", "lodging"].includes(normalized)) {
    return "hotel";
  }
  if (normalized === "unknown") {
    return "unknown";
  }
  return normalized;
}

function classifyPlaceTagFromText(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return "";
  }
  if (containsAny(text, ["地铁", "公交", "火车站", "高铁", "机场", "航站楼", "车站", "subway", "station", "airport"])) {
    return "transit";
  }
  if (containsAny(text, ["医院", "诊所", "clinic", "hospital"])) {
    return "healthcare";
  }
  if (containsAny(text, ["学校", "大学", "学院", "campus", "school", "university"])) {
    return "education";
  }
  if (containsAny(text, ["商场", "购物", "超市", "便利店", "mall", "store", "supermarket"])) {
    return "retail";
  }
  if (containsAny(text, ["餐厅", "咖啡", "奶茶", "饭店", "restaurant", "cafe", "coffee", "tea"])) {
    return "food";
  }
  if (containsAny(text, ["公园", "健身", "体育", "球馆", "gym", "park", "stadium"])) {
    return "recreation";
  }
  if (containsAny(text, ["写字楼", "大厦", "办公", "公司", "office", "company"])) {
    return "office";
  }
  if (containsAny(text, ["小区", "公寓", "花园", "住宅", "residential", "apartment"])) {
    return "residential";
  }
  if (containsAny(text, ["酒店", "宾馆", "hotel"])) {
    return "hotel";
  }
  return "";
}

function containsAny(text, needles) {
  return Array.isArray(needles) && needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

function matchKnownPlace(coords, knownPlaces) {
  for (const place of knownPlaces) {
    const distanceMeters = computeDistanceMeters(coords.latitude, coords.longitude, place.latitude, place.longitude);
    if (distanceMeters <= place.radiusMeters) {
      return place;
    }
  }
  return null;
}

function computeDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dphi = toRadians(lat2 - lat1);
  const dlambda = toRadians(lng2 - lng1);
  const a = Math.sin(dphi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return value * (Math.PI / 180);
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

module.exports = {
  createPlaceResolver,
};
