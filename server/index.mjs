import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const gaMeasurementId = normalizePublicEnvValue(process.env.GA_MEASUREMENT_ID);
const weatherBaseUrl = process.env.NEA_WEATHER_BASE_URL || "https://api-open.data.gov.sg/v2/real-time/api";
const openMeteoForecastUrl = process.env.OPEN_METEO_FORECAST_URL || "https://api.open-meteo.com/v1/forecast";
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

let weatherCache = null;
let weatherRefreshPromise = null;

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
    weatherCache: getWeatherCacheMeta(),
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
  console.log(`PlaySG API listening on http://${host}:${port}`);
});

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
  const updatedAt =
    dayRecord.updatedTimestamp || dayRecord.timestamp || outlookRecord.updatedTimestamp || outlookRecord.timestamp || "";
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
    forecastText: cleanValue(general.forecast?.text || ""),
    forecastCode: cleanValue(general.forecast?.code || ""),
    validText: cleanValue(validPeriod.text || ""),
    validStart: cleanValue(validPeriod.start || ""),
    validEnd: cleanValue(validPeriod.end || ""),
    temperature,
    humidity,
    wind: {
      direction: cleanValue(wind.direction || ""),
      speed: normalizeRange(wind.speed, "km/h"),
      label: [cleanValue(wind.direction || ""), normalizeRange(wind.speed, "km/h").label].filter(Boolean).join(", "),
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
      label: cleanValue(period?.timePeriod?.text || ""),
      start: cleanValue(period?.timePeriod?.start || ""),
      end: cleanValue(period?.timePeriod?.end || ""),
      regions: Object.entries(period?.regions || {}).map(([region, forecast]) => ({
        region: formatRegion(region),
        forecastText: cleanValue(forecast?.text || ""),
        forecastCode: cleanValue(forecast?.code || ""),
      })),
    }))
    .filter((period) => period.regions.length > 0)
    .slice(0, 3);
}

function normalizeOutlookForecast(forecast) {
  if (!forecast) return null;
  const wind = forecast.wind || {};

  return {
    day: cleanValue(forecast.day || ""),
    date: cleanValue(forecast.timestamp || ""),
    dateKey: getDateKey(forecast.timestamp || ""),
    forecastText: cleanValue(forecast.forecast?.text || forecast.forecast?.summary || ""),
    summary: cleanValue(forecast.forecast?.summary || forecast.forecast?.text || ""),
    forecastCode: cleanValue(forecast.forecast?.code || ""),
    temperature: normalizeRange(forecast.temperature, "C"),
    humidity: normalizeRange(forecast.relativeHumidity, "%"),
    wind: {
      direction: cleanValue(wind.direction || ""),
      speed: normalizeRange(wind.speed, "km/h"),
      label: [cleanValue(wind.direction || ""), normalizeRange(wind.speed, "km/h").label].filter(Boolean).join(", "),
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

  return cleanValue(unit || "");
}

function getDateKey(value) {
  const raw = cleanValue(value);
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
  const forecast = normalizeText(day.forecastText);
  const high = day.temperature?.high;

  if (/thundery|shower|rain/.test(forecast)) return "Pack a wet-weather backup and check the sky before heading out.";
  if (Number.isFinite(high) && high >= 34) return "Good for shorter outdoor play. Bring water and plan shade breaks.";
  if (/fair|partly cloudy|cloudy/.test(forecast)) return "Good for outdoor play, with water and shade breaks.";

  return "Check the forecast again before leaving home.";
}

function formatRegion(value) {
  const region = cleanValue(value);
  return region ? region.charAt(0).toUpperCase() + region.slice(1).toLowerCase() : "";
}

function getWeatherCacheMeta() {
  if (!weatherCache) return null;

  return {
    expiresAt: new Date(weatherCache.expiresAtMs).toISOString(),
    ttlSeconds: Math.max(0, Math.round((weatherCache.expiresAtMs - Date.now()) / 1000)),
    sourceLabel: weatherCache.payload?.sourceLabel || "",
  };
}

function cleanValue(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePublicEnvValue(value) {
  const normalized = cleanValue(value);

  return /^(undefined|null)$/i.test(normalized) ? "" : normalized;
}
