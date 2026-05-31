import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(rootDir, "public", "data", "playgrounds.json");
const curatedPath = path.join(rootDir, "config", "curated-playgrounds.json");
const curatedSourceUrl = "https://github.com/celesteanglm/sg-play/blob/main/config/curated-playgrounds.json";

const DATASETS = {
  parks: {
    id: "d_0542d48f0991541706b58059381a6eca",
    label: "NParks Parks",
    url: "https://data.gov.sg/datasets/d_0542d48f0991541706b58059381a6eca/view",
  },
  boundaries: {
    id: "d_77d7ec97be83d44f61b85454f844382f",
    label: "NParks Parks and Nature Reserves",
    url: "https://data.gov.sg/datasets/d_77d7ec97be83d44f61b85454f844382f/view",
  },
  parksSg: {
    id: "d_99b71f5d34cf57a3a592fbfdef1f42b6",
    label: "Parks@SG",
    url: "https://data.gov.sg/datasets/d_99b71f5d34cf57a3a592fbfdef1f42b6/view",
  },
};

const PLAYGROUND_NAME_PATTERN = /\bPG\b|PLAYGROUND/i;

async function main() {
  const curatedConfig = await readCuratedPlaygroundConfig();
  const parksGeojson = await fetchDataset(DATASETS.parks.id);
  await sleep(1_500);
  const boundaryGeojson = await fetchDataset(DATASETS.boundaries.id);
  await sleep(1_500);
  const parksSgGeojson = await fetchDataset(DATASETS.parksSg.id);

  const boundaryByName = buildBoundaryIndex(boundaryGeojson.features || []);
  const pointByName = buildPointIndex(parksGeojson.features || []);
  const amenityByName = buildParksSgAmenityIndex(parksSgGeojson.features || []);
  const playgrounds = new Map();

  for (const feature of parksGeojson.features || []) {
    const rawName = cleanValue(feature.properties?.NAME);
    if (!PLAYGROUND_NAME_PATTERN.test(rawName)) continue;

    const [longitude, latitude] = feature.geometry?.coordinates || [];
    if (!isSingaporeCoordinate(latitude, longitude)) continue;

    const key = normalizeName(rawName);
    const boundary = boundaryByName.get(key);
    const amenity = amenityByName.get(key);
    const areaSqm = toPositiveNumber(boundary?.areaSqm);

    playgrounds.set(key, {
      id: `nparks-${feature.properties?.OBJECTID || slugify(rawName)}`,
      name: formatDisplayName(rawName),
      rawName,
      type: "Dedicated playground",
      latitude,
      longitude,
      areaSqm,
      areaLabel: formatArea(areaSqm),
      areaCategory: getAreaCategory(areaSqm),
      address: amenity?.address || "",
      amenities: amenity?.amenities || [],
      source: "NParks managed-area point",
      sourceUrl: DATASETS.parks.url,
      googleMapsUrl: buildGoogleMapsUrl(latitude, longitude),
      updatedAt: parseDataGovTimestamp(feature.properties?.FMEL_UPD_D || boundary?.updatedAt || ""),
      notes: [
        "Coordinates are the indicative NParks managed-area point.",
        areaSqm
          ? "Area is the NParks managed-area polygon area, not a measured play-equipment footprint."
          : "No official area value was published for this record.",
      ],
    });
  }

  for (const amenity of amenityByName.values()) {
    if (!amenity.hasPlayground) continue;

    const key = normalizeName(amenity.name);
    if (playgrounds.has(key)) {
      const existing = playgrounds.get(key);
      playgrounds.set(key, {
        ...existing,
        address: existing.address || amenity.address,
        amenities: amenity.amenities,
        source: `${existing.source} + Parks@SG amenity`,
      });
      continue;
    }

    const point = pointByName.get(key);
    const boundary = boundaryByName.get(key);
    const latitude = point?.latitude || amenity.latitude;
    const longitude = point?.longitude || amenity.longitude;
    const areaSqm = toPositiveNumber(boundary?.areaSqm);

    if (!isSingaporeCoordinate(latitude, longitude)) continue;

    playgrounds.set(key, {
      id: `parks-sg-${slugify(amenity.name)}`,
      name: formatDisplayName(amenity.name),
      rawName: amenity.name,
      type: "Park with playground",
      latitude,
      longitude,
      areaSqm,
      areaLabel: formatArea(areaSqm),
      areaCategory: getAreaCategory(areaSqm),
      address: amenity.address,
      amenities: amenity.amenities,
      source: "Parks@SG playground amenity",
      sourceUrl: DATASETS.parksSg.url,
      googleMapsUrl: buildGoogleMapsUrl(latitude, longitude),
      updatedAt: parseDataGovTimestamp(point?.updatedAt || boundary?.updatedAt || amenity.updatedAt || ""),
      notes: [
        "This park lists Playground as an amenity in Parks@SG.",
        areaSqm
          ? "Area is the NParks park or managed-area polygon area, not a measured playground footprint."
          : "No official area value was published for this record.",
      ],
    });
  }

  applyCuratedPlaygrounds(playgrounds, curatedConfig.playgrounds || [], {
    amenityByName,
    boundaryByName,
    pointByName,
  });

  const records = [...playgrounds.values()]
    .map((record) => ({
      ...record,
      region: getRegion(record),
      coordinateLabel: `${record.latitude.toFixed(6)}, ${record.longitude.toFixed(6)}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const previousPayload = await readExistingPayload();
  const payload = {
    generatedAt: new Date().toISOString(),
    count: records.length,
    dataQuality:
      "Best-effort public playground map from official data.gov.sg datasets plus small curated overrides for known public playgrounds missing from official playground-specific fields. NParks point coordinates are indicative. Area values describe the managed-area or park polygon where available, not the exact play-equipment footprint.",
    sources: [
      {
        name: DATASETS.parks.label,
        url: DATASETS.parks.url,
        datasetId: DATASETS.parks.id,
        use: "Dedicated playground points identified by names containing PG or PLAYGROUND.",
      },
      {
        name: DATASETS.boundaries.label,
        url: DATASETS.boundaries.url,
        datasetId: DATASETS.boundaries.id,
        use: "Managed-area polygon sizes joined by name.",
      },
      {
        name: DATASETS.parksSg.label,
        url: DATASETS.parksSg.url,
        datasetId: DATASETS.parksSg.id,
        use: "Parks that explicitly list Playground as an amenity.",
      },
      {
        name: "Curated playground overrides",
        url: curatedSourceUrl,
        datasetId: "curated-playground-overrides",
        use: "Known public playgrounds missing from official playground-specific fields, tracked in config/curated-playgrounds.json.",
      },
    ],
    playgrounds: records,
  };

  if (previousPayload && isSameGeneratedDataset(previousPayload, payload)) {
    payload.generatedAt = previousPayload.generatedAt;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`Wrote ${records.length} playground records to ${path.relative(rootDir, outputPath)}`);
}

async function readCuratedPlaygroundConfig() {
  try {
    const raw = await fs.readFile(curatedPath, "utf8");
    const config = JSON.parse(raw);

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config must be a JSON object");
    }

    if (!Array.isArray(config.playgrounds)) {
      throw new Error("config.playgrounds must be an array");
    }

    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read curated playground config.";
    throw new Error(`Curated playground config is invalid: ${message}`);
  }
}

async function readExistingPayload() {
  try {
    const raw = await fs.readFile(outputPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isSameGeneratedDataset(current, next) {
  return JSON.stringify(stripGeneratedFields(current)) === JSON.stringify(stripGeneratedFields(next));
}

function stripGeneratedFields(payload) {
  const { generatedAt: _generatedAt, ...rest } = payload || {};
  return rest;
}

async function fetchDataset(datasetId) {
  const response = await fetchWithRetry(`https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}/poll-download`);
  if (!response.ok) throw new Error(`Dataset ${datasetId} metadata returned ${response.status}`);

  const payload = await response.json();
  if (payload.code !== 0 || !payload.data?.url) {
    throw new Error(payload.errMsg || `Dataset ${datasetId} did not return a download URL`);
  }

  const dataResponse = await fetchWithRetry(payload.data.url);
  if (!dataResponse.ok) throw new Error(`Dataset ${datasetId} download returned ${dataResponse.status}`);

  return dataResponse.json();
}

async function fetchWithRetry(url, attempts = 6) {
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url);
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) {
      return response;
    }

    lastResponse = response;
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1_500 * attempt;
    await sleep(retryDelay);
  }

  return lastResponse;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBoundaryIndex(features) {
  const index = new Map();

  for (const feature of features) {
    const name = cleanValue(feature.properties?.NAME);
    if (!name) continue;

    index.set(normalizeName(name), {
      areaSqm: feature.properties?.["SHAPE_1.AREA"] ?? feature.properties?.["SHAPE.AREA"] ?? feature.properties?.Shape_Area,
      updatedAt: feature.properties?.FMEL_UPD_D,
    });
  }

  return index;
}

function buildPointIndex(features) {
  const index = new Map();

  for (const feature of features) {
    const name = cleanValue(feature.properties?.NAME);
    const [longitude, latitude] = feature.geometry?.coordinates || [];
    if (!name || !isSingaporeCoordinate(latitude, longitude)) continue;

    index.set(normalizeName(name), {
      latitude,
      longitude,
      updatedAt: feature.properties?.FMEL_UPD_D,
    });
  }

  return index;
}

function buildParksSgAmenityIndex(features) {
  const index = new Map();

  for (const feature of features) {
    const attrs = parseHtmlAttributeTable(feature.properties?.Description || feature.properties?.DESCRIPTION || "");
    const name = cleanValue(attrs.NAME || feature.properties?.Name);
    if (!name) continue;

    const [longitude, latitude] = feature.geometry?.coordinates || [];
    const description = cleanValue(attrs.DESCRIPTION);
    const amenities = splitAmenities(description);

    index.set(normalizeName(name), {
      name,
      latitude,
      longitude,
      address: buildAddress(attrs),
      amenities,
      hasPlayground: amenities.some((item) => /playground/i.test(item)) || /playground/i.test(description),
      updatedAt: attrs.FMEL_UPD_D,
    });
  }

  return index;
}

function applyCuratedPlaygrounds(playgrounds, curatedPlaygrounds, indexes) {
  for (const entry of curatedPlaygrounds) {
    const id = cleanValue(entry.id);
    const name = cleanValue(entry.name);
    const type = cleanValue(entry.type);
    const latitude = Number(entry.latitude);
    const longitude = Number(entry.longitude);
    const key = normalizeName(entry.matchName || name);

    if (!id) throw new Error("Each curated playground needs an id.");
    if (!name) throw new Error(`Curated playground ${id} needs a name.`);
    if (!["Dedicated playground", "Park with playground"].includes(type)) {
      throw new Error(`Curated playground ${id} has unsupported type: ${type}`);
    }
    if (!isSingaporeCoordinate(latitude, longitude)) {
      throw new Error(`Curated playground ${id} has coordinates outside Singapore.`);
    }
    if (!key) throw new Error(`Curated playground ${id} needs a matchable name.`);
    if (playgrounds.has(key)) throw new Error(`Curated playground ${id} duplicates generated record key: ${key}`);

    const officialName = entry.officialParkName || entry.parksSgName || name;
    const amenity = indexes.amenityByName.get(normalizeName(entry.parksSgName || officialName)) || null;
    const boundary = indexes.boundaryByName.get(normalizeName(entry.areaSourceName || officialName)) || null;
    const point = indexes.pointByName.get(normalizeName(entry.pointSourceName || officialName)) || null;
    const areaSqm = toPositiveNumber(entry.areaSqm ?? boundary?.areaSqm);
    const configuredAmenities = normalizeStringArray(entry.amenities);
    const referenceUrls = normalizeStringArray(entry.referenceUrls).filter(isHttpUrl);
    const notes = normalizeStringArray(entry.notes);

    playgrounds.set(key, {
      id,
      name,
      rawName: cleanValue(entry.rawName) || name,
      type,
      latitude,
      longitude,
      areaSqm,
      areaLabel: formatArea(areaSqm),
      areaCategory: getAreaCategory(areaSqm),
      address: cleanValue(entry.address) || amenity?.address || "",
      amenities: configuredAmenities.length > 0 ? configuredAmenities : amenity?.amenities || [],
      source: cleanValue(entry.source) || "Curated playground override",
      sourceUrl: cleanValue(entry.sourceUrl) || DATASETS.parksSg.url,
      googleMapsUrl: cleanValue(entry.googleMapsUrl) || buildGoogleMapsUrl(latitude, longitude),
      updatedAt: parseDataGovTimestamp(point?.updatedAt || boundary?.updatedAt || amenity?.updatedAt || ""),
      curated: true,
      curationReason: cleanValue(entry.reason),
      referenceUrls,
      notes: [
        ...notes,
        areaSqm
          ? "Area is joined from the official park or managed-area polygon, not a measured playground footprint."
          : "No official area value was published for this curated record.",
      ],
    });
  }
}

function parseHtmlAttributeTable(html) {
  const attrs = {};
  const pattern = /<th[^>]*>\s*([^<]+?)\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let match;

  while ((match = pattern.exec(String(html || "")))) {
    const key = decodeHtml(match[1]).trim().toUpperCase();
    const value = decodeHtml(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    attrs[key] = value;
  }

  return attrs;
}

function splitAmenities(description) {
  return cleanValue(description)
    .split(/\s{2,}|\s+;\s+|,\s+(?=[A-Z])/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAddress(attrs) {
  return [
    attrs.ADDRESSBLOCKHOUSENUMBER,
    attrs.ADDRESSSTREETNAME,
    attrs.ADDRESSBUILDINGNAME,
    attrs.ADDRESSPOSTALCODE && attrs.ADDRESSPOSTALCODE !== "0" ? `Singapore ${attrs.ADDRESSPOSTALCODE}` : "",
  ]
    .map(cleanValue)
    .filter(Boolean)
    .join(", ");
}

function formatDisplayName(value) {
  const abbreviationMap = new Map([
    ["PG", "Playground"],
    ["PK", "Park"],
    ["RD", "Road"],
    ["JLN", "Jalan"],
    ["DR", "Drive"],
    ["AVE", "Avenue"],
    ["CRES", "Crescent"],
    ["TER", "Terrace"],
    ["ST", "Street"],
    ["BT", "Bukit"],
    ["CTRL", "Central"],
  ]);

  return cleanValue(value)
    .replace(/`/g, "'")
    .split(/\s+/)
    .map((word) => {
      const stripped = word.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (abbreviationMap.has(stripped)) return word.replace(stripped, abbreviationMap.get(stripped));
      if (/^[IVX]+$/i.test(word)) return word.toUpperCase();
      if (word.includes("-")) return word.split("-").map(formatDisplayName).join("-");
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ")
    .replace(/\bAng Mo Kio\b/g, "Ang Mo Kio")
    .replace(/\bChoa Chu Kang\b/g, "Choa Chu Kang")
    .replace(/\bYio Chu Kang\b/g, "Yio Chu Kang");
}

function getAreaCategory(areaSqm) {
  const area = toPositiveNumber(areaSqm);
  if (!area) return "Area unavailable";
  if (area < 2_000) return "Pocket";
  if (area < 10_000) return "Neighbourhood";
  if (area < 50_000) return "Large";
  return "Destination";
}

function formatArea(areaSqm) {
  const area = toPositiveNumber(areaSqm);
  if (!area) return "Area not published";
  if (area < 10_000) return `${Math.round(area).toLocaleString("en-SG")} sqm`;
  return `${(area / 10_000).toFixed(1)} ha`;
}

function getRegion(record) {
  const center = { latitude: 1.3521, longitude: 103.8198 };
  const latDelta = record.latitude - center.latitude;
  const lngDelta = record.longitude - center.longitude;

  if (Math.abs(latDelta) <= 0.035 && Math.abs(lngDelta) <= 0.045) return "Central";

  const latitudeWeight = Math.abs(latDelta) / 0.09;
  const longitudeWeight = Math.abs(lngDelta) / 0.13;

  if (latitudeWeight >= longitudeWeight) return latDelta >= 0 ? "North" : "South";
  return lngDelta >= 0 ? "East" : "West";
}

function buildGoogleMapsUrl(latitude, longitude) {
  const query = encodeURIComponent(`${latitude},${longitude}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanValue).filter(Boolean);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseDataGovTimestamp(value) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "";

  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`).toISOString();
}

function normalizeName(value) {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[`']/g, "")
    .replace(/\bplayground\b/g, "pg")
    .replace(/\bpark\b/g, "pk")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeName(value).replace(/\s+/g, "-") || "playground";
}

function cleanValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isSingaporeCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= 1.15 &&
    latitude <= 1.5 &&
    longitude >= 103.55 &&
    longitude <= 104.15
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
