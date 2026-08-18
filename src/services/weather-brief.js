// Pure weather-brief computation: alert detection + 7d/7d retention split.
// No I/O, no writer, no network — deterministic functions over parsed daily data.
// Consumed on demand (SYSTEM_OVERVIEW 第四节 第三档「完全按需」); nothing is persisted here.

const DEFAULT_RAIN_PROB_PCT = 60;
const DEFAULT_TEMP_DELTA_C = 6;
const OBSERVED_DAYS = 7;
const FORECAST_DAYS = 7;

function toFiniteNumber(value) {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}

// daily: { time:[isoDate...], temperature_2m_max:[], temperature_2m_min:[],
//          precipitation_probability_max:[], precipitation_sum:[], weather_code:[] }
// Rows are ordered oldest→newest and include past_days + today + forecast.
function indexByDate(daily) {
  const times = Array.isArray(daily?.time) ? daily.time : [];
  const map = new Map();
  times.forEach((iso, i) => map.set(String(iso), i));
  return map;
}

function dayRecord(daily, i) {
  if (i == null || i < 0) return null;
  return {
    date: String(daily.time[i]),
    highC: toFiniteNumber(daily.temperature_2m_max?.[i]),
    lowC: toFiniteNumber(daily.temperature_2m_min?.[i]),
    rainProbPct: toFiniteNumber(daily.precipitation_probability_max?.[i]),
    precipMm: toFiniteNumber(daily.precipitation_sum?.[i]),
    weatherCode: toFiniteNumber(daily.weather_code?.[i]),
  };
}

function computeWeatherAlert({ daily, todayISO, thresholds } = {}) {
  const rainProbPct = toFiniteNumber(thresholds?.rainProbPct) ?? DEFAULT_RAIN_PROB_PCT;
  const tempDeltaC = toFiniteNumber(thresholds?.tempDeltaC) ?? DEFAULT_TEMP_DELTA_C;
  const byDate = indexByDate(daily);
  const todayIdx = byDate.has(String(todayISO)) ? byDate.get(String(todayISO)) : null;
  const today = dayRecord(daily, todayIdx);
  const yesterday = todayIdx != null ? dayRecord(daily, todayIdx - 1) : null;

  const reasons = [];
  let rain = null;
  let tempSwing = null;

  if (today) {
    const willRain =
      (today.rainProbPct != null && today.rainProbPct >= rainProbPct) ||
      (today.precipMm != null && today.precipMm > 0);
    if (willRain) {
      rain = { probPct: today.rainProbPct, precipMm: today.precipMm };
      reasons.push("rain");
    }
    if (yesterday) {
      const highDelta =
        today.highC != null && yesterday.highC != null ? today.highC - yesterday.highC : null;
      const lowDelta =
        today.lowC != null && yesterday.lowC != null ? today.lowC - yesterday.lowC : null;
      const swung =
        (highDelta != null && Math.abs(highDelta) >= tempDeltaC) ||
        (lowDelta != null && Math.abs(lowDelta) >= tempDeltaC);
      if (swung) {
        tempSwing = {
          highDeltaC: highDelta,
          lowDeltaC: lowDelta,
          todayHighC: today.highC,
          todayLowC: today.lowC,
          yesterdayHighC: yesterday.highC,
          yesterdayLowC: yesterday.lowC,
        };
        reasons.push("temp_swing");
      }
    }
  }

  return {
    hasAlert: reasons.length > 0,
    reasons,
    thresholds: { rainProbPct, tempDeltaC },
    today,
    rain,
    tempSwing,
  };
}

// Split the daily rows into recent observed (strictly before today, newest last, up to 7)
// and forecast (today plus future, up to 7).
function buildRetention({ daily, todayISO } = {}) {
  const times = Array.isArray(daily?.time) ? daily.time : [];
  const observed = [];
  const forecast = [];
  times.forEach((iso, i) => {
    const rec = dayRecord(daily, i);
    if (!rec) return;
    if (String(iso) < String(todayISO)) observed.push(rec);
    else forecast.push(rec);
  });
  return {
    observed: observed.slice(-OBSERVED_DAYS),
    forecast: forecast.slice(0, FORECAST_DAYS),
  };
}

module.exports = {
  computeWeatherAlert,
  buildRetention,
  DEFAULT_RAIN_PROB_PCT,
  DEFAULT_TEMP_DELTA_C,
  OBSERVED_DAYS,
  FORECAST_DAYS,
};
