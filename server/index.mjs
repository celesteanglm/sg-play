import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractLtaBatchLink, normalizeChargerStations } from "../src/lib/chargers.js";
import { normalizeSearchText } from "../src/lib/search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const samplePath = path.join(rootDir, "public", "data", "sample-chargers.json");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const ltaAccountKey = process.env.LTA_ACCOUNT_KEY;
const configuredCacheTtlMs = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const cacheTtlMs = Number.isFinite(configuredCacheTtlMs) && configuredCacheTtlMs > 0 ? configuredCacheTtlMs : 5 * 60 * 1000;
const configuredLtaFetchTimeoutMs = Number(process.env.LTA_FETCH_TIMEOUT_MS || 15000);
const ltaFetchTimeoutMs =
  Number.isFinite(configuredLtaFetchTimeoutMs) && configuredLtaFetchTimeoutMs > 0 ? configuredLtaFetchTimeoutMs : 15000;
const oneMapBaseUrl = process.env.ONEMAP_BASE_URL || "https://www.onemap.gov.sg";
const oneMapApiToken = process.env.ONEMAP_API_TOKEN || "";
const oneMapEmail = process.env.ONEMAP_EMAIL || "";
const oneMapPassword = process.env.ONEMAP_PASSWORD || "";
const gaMeasurementId = normalizePublicEnvValue(process.env.GA_MEASUREMENT_ID || process.env.VITE_GA_MEASUREMENT_ID);
const weatherBaseUrl = process.env.NEA_WEATHER_BASE_URL || "https://api-open.data.gov.sg/v2/real-time/api";
const openMeteoForecastUrl = process.env.OPEN_METEO_FORECAST_URL || "https://api.open-meteo.com/v1/forecast";
const configuredOneMapCacheTtlMs = Number(process.env.ONEMAP_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const oneMapSearchCacheTtlMs =
  Number.isFinite(configuredOneMapCacheTtlMs) && configuredOneMapCacheTtlMs > 0
    ? configuredOneMapCacheTtlMs
    : 30 * 24 * 60 * 60 * 1000;
const configuredWeatherCacheTtlMs = Number(process.env.WEATHER_CACHE_TTL_MS || 30 * 60 * 1000);
const weatherCacheTtlMs =
  Number.isFinite(configuredWeatherCacheTtlMs) && configuredWeatherCacheTtlMs > 0
    ? configuredWeatherCacheTtlMs
    : 30 * 60 * 1000;
const configuredWeatherFetchTimeoutMs = Number(process.env.WEATHER_FETCH_TIMEOUT_MS || 10000);
const weatherFetchTimeoutMs =
  Number.isFinite(configuredWeatherFetchTimeoutMs) && configuredWeatherFetchTimeoutMs > 0
    ? configuredWeatherFetchTimeoutMs
    : 10000;
const SINGAPORE_WEATHER_POINT = {
  latitude: 1.3521,
  longitude: 103.8198,
};
const OPEN_METEO_DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "uv_index_max",
  "wind_speed_10m_max",
  "wind_direction_10m_dominant",
];

let liveCache = null;
let liveRefreshPromise = null;
let sampleCache = null;
let alignedRefreshTimer = null;
let oneMapTokenCache = null;
let weatherCache = null;
let weatherRefreshPromise = null;
const oneMapSearchCache = new Map();

const app = express();

app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' https://www.googletagmanager.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.tile.openstreetmap.org",
      "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(self), microphone=(), payment=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ltaConfigured: Boolean(ltaAccountKey),
    cache: liveCache ? buildCacheMeta(liveCache.fetchedAtMs) : null,
  });
});

app.get("/api/config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    analytics: {
      gaMeasurementId,
    },
  });
});

app.get("/api/chargers", async (_req, res) => {
  const payload = await getChargersPayload();
  const maxAgeSeconds = getSecondsUntilNextRefreshBoundary();

  res.set("Cache-Control", `public, max-age=${maxAgeSeconds}, stale-while-revalidate=60`);
  res.json(payload);
});

app.get("/api/search-place", async (req, res) => {
  const query = normalizeSearchText(req.query.q);

  if (query.length < 2) {
    res.json({ results: [] });
    return;
  }

  try {
    const payload = await searchOneMapPlace(query);
    const maxAgeSeconds = Math.max(60, Math.round(oneMapSearchCacheTtlMs / 1000));

    res.set("Cache-Control", `public, max-age=${maxAgeSeconds}, stale-while-revalidate=86400`);
    res.json(payload);
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Place search unavailable.";

    res.status(200).json({ results: [], warning });
  }
});

app.get("/api/weather", async (_req, res) => {
  try {
    const payload = await getWeatherPayload();

    res.set("Cache-Control", `public, max-age=${Math.round(weatherCacheTtlMs / 1000)}, stale-while-revalidate=300`);
    res.json(payload);
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Weather forecast unavailable.";

    res.status(200).json({
      ok: false,
      warning,
      sourceLabel: "NEA weather forecast",
      updatedAt: "",
      generatedAt: new Date().toISOString(),
    });
  }
});

app.use(
  express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return;
      }

      if (path.basename(filePath) === "index.html") {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.get(/.*/, (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, host, () => {
  console.log(`BoCharge API listening on http://${host}:${port}`);
  if (ltaAccountKey) scheduleAlignedLiveRefresh();
});

async function readSampleData() {
  if (sampleCache) return sampleCache;

  const raw = await fs.readFile(samplePath, "utf8");
  sampleCache = JSON.parse(raw);

  return sampleCache;
}

async function getChargersPayload() {
  if (!ltaAccountKey) {
    return buildSamplePayload("Add LTA_ACCOUNT_KEY to use the live DataMall EV Charging Points Batch feed.", false);
  }

  if (liveCache && liveCache.refreshSlotMs === getCurrentRefreshSlotMs()) {
    return buildLivePayload(liveCache, "fresh");
  }

  try {
    const refreshedCache = await ensureLiveCacheForCurrentSlot();
    return buildLivePayload(refreshedCache, "refreshed");
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Unable to load LTA charger feed.";
    console.warn(`LTA live refresh failed: ${warning}`);

    if (liveCache) {
      return buildLivePayload(liveCache, "stale");
    }

    return buildSamplePayload(warning, true);
  }
}

async function refreshLiveCache() {
  const metaResponse = await fetch("https://datamall2.mytransport.sg/ltaodataservice/EVCBatch", {
    headers: {
      AccountKey: ltaAccountKey,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(ltaFetchTimeoutMs),
  });

  if (!metaResponse.ok) {
    throw new Error(`DataMall EVCBatch returned ${metaResponse.status}`);
  }

  const metaPayload = await metaResponse.json();
  const downloadLink = extractLtaBatchLink(metaPayload);

  if (!downloadLink) {
    throw new Error("DataMall EVCBatch response did not include a download link.");
  }

  const batchResponse = await fetch(downloadLink, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(ltaFetchTimeoutMs),
  });

  if (!batchResponse.ok) {
    throw new Error(`DataMall batch file returned ${batchResponse.status}`);
  }

  const batchPayload = await batchResponse.json();
  const stations = normalizeChargerStations(batchPayload);
  const ltaLastUpdatedTime = batchPayload.LastUpdatedTime || batchPayload.lastUpdatedTime || "";
  const fetchedAtMs = Date.now();

  liveCache = {
    fetchedAtMs,
    ltaLastUpdatedTime,
    ltaUpdatedAt: normalizeLtaTimestamp(ltaLastUpdatedTime),
    refreshSlotMs: getCurrentRefreshSlotMs(fetchedAtMs),
    stations,
  };

  return liveCache;
}

async function ensureLiveCacheForCurrentSlot() {
  if (liveCache && liveCache.refreshSlotMs === getCurrentRefreshSlotMs()) {
    return liveCache;
  }

  if (!liveRefreshPromise) {
    liveRefreshPromise = refreshLiveCache().finally(() => {
      liveRefreshPromise = null;
    });
  }

  return liveRefreshPromise;
}

async function searchOneMapPlace(query) {
  const cacheKey = normalizeSearchText(query);
  const cached = oneMapSearchCache.get(cacheKey);

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.payload;
  }

  const payload = await fetchOneMapPlaces(cacheKey);

  oneMapSearchCache.set(cacheKey, {
    expiresAtMs: Date.now() + oneMapSearchCacheTtlMs,
    payload,
  });

  return payload;
}

async function getWeatherPayload() {
  if (weatherCache && weatherCache.expiresAtMs > Date.now()) {
    return weatherCache.payload;
  }

  if (!weatherRefreshPromise) {
    weatherRefreshPromise = refreshWeatherPayload().finally(() => {
      weatherRefreshPromise = null;
    });
  }

  return weatherRefreshPromise;
}

async function refreshWeatherPayload() {
  const [dayForecast, fourDayOutlook] = await Promise.all([
    fetchWeatherJson("twenty-four-hr-forecast"),
    fetchWeatherJson("four-day-outlook"),
  ]);
  let weeklyForecast = null;
  let weeklyWarning = "";

  try {
    weeklyForecast = await fetchOpenMeteoForecast();
  } catch (error) {
    weeklyWarning = error instanceof Error ? error.message : "7-day model forecast unavailable.";
    console.warn(`Open-Meteo weather refresh failed: ${weeklyWarning}`);
  }

  const payload = normalizeWeatherPayload(dayForecast, fourDayOutlook, weeklyForecast, weeklyWarning);

  weatherCache = {
    expiresAtMs: Date.now() + weatherCacheTtlMs,
    payload,
  };

  return payload;
}

async function fetchOpenMeteoForecast() {
  const url = new URL(openMeteoForecastUrl);

  url.searchParams.set("latitude", String(SINGAPORE_WEATHER_POINT.latitude));
  url.searchParams.set("longitude", String(SINGAPORE_WEATHER_POINT.longitude));
  url.searchParams.set("timezone", "Asia/Singapore");
  url.searchParams.set("forecast_days", "8");
  url.searchParams.set("daily", OPEN_METEO_DAILY_FIELDS.join(","));

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(weatherFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo forecast returned ${response.status}`);
  }

  const payload = await response.json();

  if (payload?.error) {
    throw new Error(payload.reason || "Open-Meteo forecast returned an error.");
  }

  return payload;
}

async function fetchWeatherJson(pathname) {
  const response = await fetch(new URL(`${weatherBaseUrl.replace(/\/$/, "")}/${pathname}`), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(weatherFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`NEA weather ${pathname} returned ${response.status}`);
  }

  const payload = await response.json();

  if (payload?.code !== 0) {
    throw new Error(payload?.errorMsg || `NEA weather ${pathname} returned an error.`);
  }

  return payload;
}

function normalizeWeatherPayload(dayForecastPayload, fourDayPayload, weeklyForecastPayload = null, weeklyWarning = "") {
  const dayRecord = toArray(dayForecastPayload?.data?.records)[0] || {};
  const general = dayRecord.general || {};
  const outlookRecord = toArray(fourDayPayload?.data?.records)[0] || {};
  const day = normalizeDayForecast(general, dayRecord.periods || []);
  const outlook = toArray(outlookRecord.forecasts).map(normalizeOutlookForecast).filter(Boolean).slice(0, 4);
  const modelOutlook = normalizeOpenMeteoDailyForecasts(weeklyForecastPayload).slice(1, 8);
  const weeklyOutlook = buildWeeklyOutlook(outlook, modelOutlook).slice(0, 7);
  const updatedAt = dayRecord.updatedTimestamp || dayRecord.timestamp || outlookRecord.updatedTimestamp || outlookRecord.timestamp || "";
  const hasSevenDayForecast = weeklyOutlook.length >= 7;

  return {
    ok: true,
    sourceLabel: hasSevenDayForecast ? "NEA + Open-Meteo weather forecast" : "NEA weather forecast",
    sourceUrl: "https://data.gov.sg/datasets?formats=API&page=1&resultId=d_f131f6e343bf8168e4057a04c4326a0a",
    modelSourceUrl: "https://open-meteo.com/en/docs",
    updatedAt,
    generatedAt: new Date().toISOString(),
    day,
    outlook,
    weeklyOutlook,
    outlookLabel: hasSevenDayForecast ? "Next 7 days" : `Next ${outlook.length} days`,
    outlookNote: hasSevenDayForecast
      ? "NEA provides the official 4-day outlook; days 5-7 use Open-Meteo model data."
      : "NEA/data.gov.sg currently provides the official next 4 days.",
    weeklyWarning,
    parentCue: getWeatherParentCue(day),
  };
}

function normalizeDayForecast(general, periods) {
  const temperature = normalizeRange(general.temperature, "C");
  const humidity = normalizeRange(general.relativeHumidity, "%");
  const wind = general.wind || {};
  const validPeriod = general.validPeriod || {};

  return {
    forecastText: cleanOneMapValue(general.forecast?.text || ""),
    forecastCode: cleanOneMapValue(general.forecast?.code || ""),
    validText: cleanOneMapValue(validPeriod.text || ""),
    validStart: cleanOneMapValue(validPeriod.start || ""),
    validEnd: cleanOneMapValue(validPeriod.end || ""),
    temperature,
    humidity,
    wind: {
      direction: cleanOneMapValue(wind.direction || ""),
      speed: normalizeRange(wind.speed, "km/h"),
      label: [cleanOneMapValue(wind.direction || ""), normalizeRange(wind.speed, "km/h").label].filter(Boolean).join(", "),
    },
    periods: normalizeWeatherPeriods(periods, validPeriod),
  };
}

function normalizeWeatherPeriods(periods, validPeriod) {
  const validStartMs = Date.parse(validPeriod?.start || "");
  const validEndMs = Date.parse(validPeriod?.end || "");
  const hasValidWindow = Number.isFinite(validStartMs) && Number.isFinite(validEndMs);

  return toArray(periods)
    .filter((period) => {
      if (!hasValidWindow) return true;

      const startMs = Date.parse(period?.timePeriod?.start || "");
      return Number.isFinite(startMs) && startMs >= validStartMs && startMs <= validEndMs;
    })
    .map((period) => ({
      label: cleanOneMapValue(period?.timePeriod?.text || ""),
      start: cleanOneMapValue(period?.timePeriod?.start || ""),
      end: cleanOneMapValue(period?.timePeriod?.end || ""),
      regions: Object.entries(period?.regions || {}).map(([region, forecast]) => ({
        region: formatRegion(region),
        forecastText: cleanOneMapValue(forecast?.text || ""),
        forecastCode: cleanOneMapValue(forecast?.code || ""),
      })),
    }))
    .filter((period) => period.regions.length > 0)
    .slice(0, 3);
}

function normalizeOutlookForecast(forecast) {
  if (!forecast) return null;
  const wind = forecast.wind || {};

  return {
    day: cleanOneMapValue(forecast.day || ""),
    date: cleanOneMapValue(forecast.timestamp || ""),
    dateKey: getDateKey(forecast.timestamp || ""),
    forecastText: cleanOneMapValue(forecast.forecast?.text || forecast.forecast?.summary || ""),
    summary: cleanOneMapValue(forecast.forecast?.summary || forecast.forecast?.text || ""),
    forecastCode: cleanOneMapValue(forecast.forecast?.code || ""),
    temperature: normalizeRange(forecast.temperature, "C"),
    humidity: normalizeRange(forecast.relativeHumidity, "%"),
    wind: {
      direction: cleanOneMapValue(wind.direction || ""),
      speed: normalizeRange(wind.speed, "km/h"),
      label: [cleanOneMapValue(wind.direction || ""), normalizeRange(wind.speed, "km/h").label].filter(Boolean).join(", "),
    },
    sourceKind: "official",
    sourceLabel: "NEA official outlook",
    sourceNote: "Official NEA 4-day outlook from data.gov.sg.",
  };
}

function normalizeOpenMeteoDailyForecasts(payload) {
  const daily = payload?.daily || {};
  const times = toArray(daily.time);

  return times
    .map((time, index) => {
      const dateKey = getDateKey(time);
      if (!dateKey) return null;

      const weatherCode = toNumber(daily.weather_code?.[index]);
      const forecastText = getOpenMeteoWeatherText(weatherCode);
      const windDirection = toNumber(daily.wind_direction_10m_dominant?.[index]);
      const windDirectionLabel = formatWindDirection(windDirection);
      const windSpeed = normalizeScalar(daily.wind_speed_10m_max?.[index], "km/h", 0);

      return {
        day: getDayNameFromDateKey(dateKey),
        date: dateKey,
        dateKey,
        forecastText,
        summary: forecastText,
        forecastCode: Number.isFinite(weatherCode) ? String(weatherCode) : "",
        temperature: normalizeNumberRange(daily.temperature_2m_min?.[index], daily.temperature_2m_max?.[index], "C"),
        humidity: normalizeRange(null, "%"),
        apparentTemperature: normalizeNumberRange(
          daily.apparent_temperature_min?.[index],
          daily.apparent_temperature_max?.[index],
          "C",
        ),
        precipitation: normalizeScalar(daily.precipitation_sum?.[index], "mm", 1),
        precipitationProbability: normalizeScalar(daily.precipitation_probability_max?.[index], "%", 0),
        uvIndex: normalizeScalar(daily.uv_index_max?.[index], "", 1),
        wind: {
          direction: windDirectionLabel,
          degrees: Number.isFinite(windDirection) ? Math.round(windDirection) : null,
          speed: windSpeed,
          label: [windDirectionLabel, windSpeed.label].filter(Boolean).join(", "),
        },
        sourceKind: "model",
        sourceLabel: "Open-Meteo model",
        sourceNote: "Model forecast from Open-Meteo for Singapore coordinates.",
      };
    })
    .filter(Boolean);
}

function buildWeeklyOutlook(officialOutlook, modelOutlook) {
  if (!modelOutlook.length) return officialOutlook;

  const officialByDate = new Map(officialOutlook.map((forecast) => [forecast.dateKey, forecast]).filter(([dateKey]) => dateKey));

  return modelOutlook.map((modelForecast) => {
    const officialForecast = officialByDate.get(modelForecast.dateKey);
    if (!officialForecast) return modelForecast;

    return {
      ...modelForecast,
      ...officialForecast,
      apparentTemperature: modelForecast.apparentTemperature,
      precipitation: modelForecast.precipitation,
      precipitationProbability: modelForecast.precipitationProbability,
      uvIndex: modelForecast.uvIndex,
      wind: officialForecast.wind?.label ? officialForecast.wind : modelForecast.wind,
      sourceKind: "official+model",
      sourceLabel: "NEA + Open-Meteo",
      sourceNote: "Official NEA summary with model rain, UV, and feels-like details from Open-Meteo.",
    };
  });
}

function normalizeRange(range, fallbackUnit) {
  const low = toNumber(range?.low);
  const high = toNumber(range?.high);
  const unit = normalizeWeatherUnit(range?.unit || fallbackUnit);

  return {
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
    unit,
    label: formatRange(low, high, unit),
  };
}

function normalizeNumberRange(lowValue, highValue, unit) {
  const low = toNumber(lowValue);
  const high = toNumber(highValue);

  return {
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
    unit,
    label: formatRange(low, high, unit),
  };
}

function normalizeScalar(value, unit, precision = 0) {
  const number = toNumber(value);

  return {
    value: Number.isFinite(number) ? number : null,
    unit,
    label: formatScalar(number, unit, precision),
  };
}

function formatRange(low, high, unit) {
  if (Number.isFinite(low) && Number.isFinite(high)) return `${Math.round(low)}-${Math.round(high)}${unit}`;
  if (Number.isFinite(high)) return `up to ${Math.round(high)}${unit}`;
  if (Number.isFinite(low)) return `from ${Math.round(low)}${unit}`;

  return "";
}

function formatScalar(number, unit, precision = 0) {
  if (!Number.isFinite(number)) return "";

  const value = precision > 0 ? Number(number.toFixed(precision)).toString() : Math.round(number).toString();
  return `${value}${unit}`;
}

function normalizeWeatherUnit(unit) {
  if (/celsius/i.test(unit)) return "C";
  if (/percentage|percent/i.test(unit)) return "%";

  return cleanOneMapValue(unit || "");
}

function getDateKey(value) {
  const raw = cleanOneMapValue(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-SG", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Singapore",
    year: "numeric",
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function getDayNameFromDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "long",
  }).format(date);
}

function getOpenMeteoWeatherText(code) {
  const weatherCode = Number(code);
  const labels = new Map([
    [0, "Clear"],
    [1, "Mainly Clear"],
    [2, "Partly Cloudy"],
    [3, "Overcast"],
    [45, "Fog"],
    [48, "Fog"],
    [51, "Light Drizzle"],
    [53, "Drizzle"],
    [55, "Dense Drizzle"],
    [56, "Freezing Drizzle"],
    [57, "Freezing Drizzle"],
    [61, "Light Rain"],
    [63, "Rain"],
    [65, "Heavy Rain"],
    [66, "Freezing Rain"],
    [67, "Freezing Rain"],
    [71, "Light Snow"],
    [73, "Snow"],
    [75, "Heavy Snow"],
    [77, "Snow Grains"],
    [80, "Light Showers"],
    [81, "Showers"],
    [82, "Heavy Showers"],
    [85, "Snow Showers"],
    [86, "Snow Showers"],
    [95, "Thunderstorm"],
    [96, "Thunderstorm"],
    [99, "Thunderstorm"],
  ]);

  return labels.get(weatherCode) || "Forecast";
}

function formatWindDirection(degrees) {
  if (!Number.isFinite(degrees)) return "";

  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % directions.length;
  return directions[index];
}

function getWeatherParentCue(day) {
  const forecast = normalizeSearchText(day.forecastText);
  const high = day.temperature?.high;

  if (/thundery|shower|rain/.test(forecast)) return "Pack a wet-weather backup and check the sky before heading out.";
  if (Number.isFinite(high) && high >= 34) return "Good for shorter outdoor play. Bring water and plan shade breaks.";
  if (/fair|partly cloudy|cloudy/.test(forecast)) return "Good for outdoor play, with water and shade breaks.";

  return "Check the forecast again before leaving home.";
}

function formatRegion(value) {
  const region = cleanOneMapValue(value);
  return region ? region.charAt(0).toUpperCase() + region.slice(1).toLowerCase() : "";
}

async function fetchOneMapPlaces(query) {
  const url = new URL("/api/common/elastic/search", oneMapBaseUrl);
  url.searchParams.set("searchVal", query);
  url.searchParams.set("returnGeom", "Y");
  url.searchParams.set("getAddrDetails", "Y");
  url.searchParams.set("pageNum", "1");

  const authorization = await getOneMapAuthorizationHeader();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    signal: AbortSignal.timeout(ltaFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OneMap search returned ${response.status}`);
  }

  const payload = await response.json();
  const results = toArray(payload.results).map(normalizeOneMapPlace).filter(Boolean).slice(0, 5);
  const warning =
    payload.error && results.length === 0
      ? payload.error
      : !authorization
        ? "OneMap token is not configured; place search may be limited."
        : "";

  return {
    results,
    warning,
  };
}

async function getOneMapAuthorizationHeader() {
  if (oneMapApiToken) return oneMapApiToken;
  if (!oneMapEmail || !oneMapPassword) return "";

  if (oneMapTokenCache && oneMapTokenCache.expiresAtMs > Date.now() + 5 * 60 * 1000) {
    return oneMapTokenCache.token;
  }

  const tokenResponse = await fetch(new URL("/api/auth/post/getToken", oneMapBaseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: oneMapEmail,
      password: oneMapPassword,
    }),
    signal: AbortSignal.timeout(ltaFetchTimeoutMs),
  });

  if (!tokenResponse.ok) {
    throw new Error(`OneMap token request returned ${tokenResponse.status}`);
  }

  const payload = await tokenResponse.json();
  const token = payload.access_token || payload.token || "";

  if (!token) {
    throw new Error("OneMap token response did not include an access token.");
  }

  const expiresAtMs = getOneMapTokenExpiryMs(payload);

  oneMapTokenCache = {
    expiresAtMs,
    token,
  };

  return token;
}

function normalizeOneMapPlace(place) {
  const latitude = toNumber(place.LATITUDE ?? place.latitude);
  const longitude = toNumber(place.LONGITUDE ?? place.LONGTITUDE ?? place.longitude ?? place.longtitude);

  if (!isSingaporeCoordinate(latitude, longitude)) return null;

  const label = cleanOneMapValue(place.SEARCHVAL || place.BUILDING || place.searchVal || place.building || "");
  const address = cleanOneMapValue(place.ADDRESS || place.address || label);
  const postalCode = cleanOneMapValue(place.POSTAL || place.postal || "");

  return {
    id: `onemap:${normalizeSearchText(label || address)}:${latitude.toFixed(6)},${longitude.toFixed(6)}`,
    address,
    label: label || address,
    latitude,
    longitude,
    postalCode: postalCode === "NIL" ? "" : postalCode,
  };
}

function getOneMapTokenExpiryMs(payload) {
  const expiryTimestamp = Number(payload.expiry_timestamp || payload.expiryTimestamp || payload.expires_at || 0);

  if (Number.isFinite(expiryTimestamp) && expiryTimestamp > 0) {
    return expiryTimestamp > 1_000_000_000_000 ? expiryTimestamp : expiryTimestamp * 1000;
  }

  return Date.now() + 72 * 60 * 60 * 1000;
}

function cleanOneMapValue(value) {
  return String(value || "").trim();
}

function isSingaporeCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= 1.15 && latitude <= 1.5 && longitude >= 103.55 && longitude <= 104.15;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function scheduleAlignedLiveRefresh() {
  if (alignedRefreshTimer) clearTimeout(alignedRefreshTimer);

  alignedRefreshTimer = setTimeout(async () => {
    try {
      await ensureLiveCacheForCurrentSlot();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh LTA charger feed.";
      console.warn(`Scheduled LTA refresh failed: ${message}`);
    } finally {
      scheduleAlignedLiveRefresh();
    }
  }, getMsUntilNextRefreshBoundary());
}

function buildLivePayload(cache, cacheStatus, warning = "") {
  const cacheMeta = buildCacheMeta(cache.fetchedAtMs, cacheStatus);

  return {
    stations: cache.stations,
    source: "lta-datamall",
    sourceLabel: "Live LTA DataMall",
    ltaConfigured: true,
    updatedAt: cache.ltaUpdatedAt || "",
    lastUpdatedTime: cache.ltaLastUpdatedTime || "",
    count: cache.stations.length,
    warning,
    cache: cacheMeta,
  };
}

async function buildSamplePayload(warning, ltaConfigured) {
  const sample = await readSampleData();

  return {
    ...sample,
    source: "sample",
    sourceLabel: "Sample fallback",
    ltaConfigured,
    updatedAt: normalizeLtaTimestamp(sample.lastUpdatedTime) || sample.lastUpdatedTime || "",
    warning,
    cache: {
      status: "sample",
      ttlSeconds: Math.round(cacheTtlMs / 1000),
      refreshedAt: sample.generatedAt,
      expiresAt: null,
      ageSeconds: null,
    },
  };
}

function buildCacheMeta(fetchedAtMs, status = "fresh") {
  const expiresAtMs = getNextRefreshBoundaryMs(fetchedAtMs);

  return {
    status,
    ttlSeconds: Math.max(0, Math.round((expiresAtMs - fetchedAtMs) / 1000)),
    refreshedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round((Date.now() - fetchedAtMs) / 1000)),
  };
}

function normalizeLtaTimestamp(value) {
  if (typeof value !== "string") return "";

  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) return "";

  const [, year, month, day, hour, minute, second = "00"] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizePublicEnvValue(value) {
  return String(value || "").trim();
}

function getCurrentRefreshSlotMs(nowMs = Date.now()) {
  return Math.floor(nowMs / cacheTtlMs) * cacheTtlMs;
}

function getNextRefreshBoundaryMs(nowMs = Date.now()) {
  return getCurrentRefreshSlotMs(nowMs) + cacheTtlMs;
}

function getMsUntilNextRefreshBoundary(nowMs = Date.now()) {
  const remainder = nowMs % cacheTtlMs;

  return remainder === 0 ? cacheTtlMs : cacheTtlMs - remainder;
}

function getSecondsUntilNextRefreshBoundary(nowMs = Date.now()) {
  return Math.max(1, Math.ceil(getMsUntilNextRefreshBoundary(nowMs) / 1000));
}
