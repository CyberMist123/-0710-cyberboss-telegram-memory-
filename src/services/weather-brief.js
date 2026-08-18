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
  const len = Array.isArray(daily?.time) ? daily.time.length : 0;
  if (i == null || i < 0 || i >= len) return null;
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

// Tomorrow's outlook + whether it is notable (rain, or a big temp change vs today).
function computeTomorrow({ daily, todayISO, thresholds } = {}) {
  const rainProbPct = toFiniteNumber(thresholds?.rainProbPct) ?? DEFAULT_RAIN_PROB_PCT;
  const tempDeltaC = toFiniteNumber(thresholds?.tempDeltaC) ?? DEFAULT_TEMP_DELTA_C;
  const byDate = indexByDate(daily);
  const todayIdx = byDate.has(String(todayISO)) ? byDate.get(String(todayISO)) : null;
  if (todayIdx == null) return { available: false, notable: false };
  const tomorrow = dayRecord(daily, todayIdx + 1);
  if (!tomorrow) return { available: false, notable: false };
  const today = dayRecord(daily, todayIdx);

  const willRain =
    (tomorrow.precipMm != null && tomorrow.precipMm > 0) ||
    (tomorrow.rainProbPct != null && tomorrow.rainProbPct >= rainProbPct);
  const highDelta =
    tomorrow.highC != null && today?.highC != null ? tomorrow.highC - today.highC : null;
  const bigTempChange = highDelta != null && Math.abs(highDelta) >= tempDeltaC;

  return {
    available: true,
    date: tomorrow.date,
    highC: tomorrow.highC,
    lowC: tomorrow.lowC,
    rainProbPct: tomorrow.rainProbPct,
    precipMm: tomorrow.precipMm,
    weatherCode: tomorrow.weatherCode,
    willRain,
    highDeltaVsTodayC: highDelta,
    bigTempChange,
    notable: willRain || bigTempChange,
  };
}

// Rain timeline for one day, using hourly rows. A rainy hour = precipitation > 0
// or probability >= threshold. Returns the span (first→last rainy hour) plus the
// peak probability and its hour. For the current day it starts from the current
// hour (`nowISO`); for a future `targetDate` it covers that whole day.
function computeHourlyRain({ hourly, nowISO, targetDate, thresholds } = {}) {
  const rainProbPct = toFiniteNumber(thresholds?.rainProbPct) ?? DEFAULT_RAIN_PROB_PCT;
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const probs = Array.isArray(hourly?.precipitation_probability) ? hourly.precipitation_probability : [];
  const precs = Array.isArray(hourly?.precipitation) ? hourly.precipitation : [];
  const now = String(nowISO || "");
  const nowDay = now.slice(0, 10);
  const date = String(targetDate || nowDay);
  const isToday = date === nowDay;
  const nowHour = now.slice(0, 13); // "YYYY-MM-DDTHH"

  const rainy = [];
  times.forEach((t, i) => {
    const iso = String(t);
    if (iso.slice(0, 10) !== date) return;            // the target day only
    if (isToday && iso.slice(0, 13) < nowHour) return; // today: from the current hour onward
    const prob = toFiniteNumber(probs[i]);
    const mm = toFiniteNumber(precs[i]);
    const isRain = (mm != null && mm > 0) || (prob != null && prob >= rainProbPct);
    if (isRain) rainy.push({ hour: iso.slice(11, 16), hourNum: Number(iso.slice(11, 13)), prob, mm });
  });
  if (!rainy.length) return { hasRain: false };

  let peak = rainy[0];
  for (const r of rainy) {
    if ((r.prob ?? -1) > (peak.prob ?? -1)) peak = r;
  }
  const lastNum = rainy[rainy.length - 1].hourNum;
  const endLabel = `${String(Math.min(24, lastNum + 1)).padStart(2, "0")}:00`;
  return {
    hasRain: true,
    startHour: rainy[0].hour,
    endHour: endLabel,
    peakProbPct: peak.prob,
    peakHour: peak.hour,
    rainyHours: rainy.length,
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
  computeTomorrow,
  computeHourlyRain,
  buildRetention,
  DEFAULT_RAIN_PROB_PCT,
  DEFAULT_TEMP_DELTA_C,
  OBSERVED_DAYS,
  FORECAST_DAYS,
};
