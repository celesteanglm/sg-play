import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const datasetPath = path.join(rootDir, "public", "data", "playgrounds.json");

const REQUIRED_SOURCE_IDS = new Set([
  "d_0542d48f0991541706b58059381a6eca",
  "d_77d7ec97be83d44f61b85454f844382f",
  "d_99b71f5d34cf57a3a592fbfdef1f42b6",
]);
const VALID_TYPES = new Set(["Dedicated playground", "Park with playground"]);
const VALID_AREA_CATEGORIES = new Set(["Pocket", "Neighbourhood", "Large", "Destination", "Area unavailable"]);
const VALID_REGIONS = new Set(["Central", "North", "South", "East", "West"]);
const SINGAPORE_BOUNDS = {
  minLatitude: 1.15,
  maxLatitude: 1.5,
  minLongitude: 103.55,
  maxLongitude: 104.15,
};

const errors = [];
const payload = await readDataset();

validatePayload(payload);

if (errors.length > 0) {
  console.error(`Playground data check failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Playground data check passed: ${payload.count} records, ${payload.sources.length} sources.`);

async function readDataset() {
  try {
    const raw = await fs.readFile(datasetPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read playground dataset.";
    console.error(`Playground data check failed: ${message}`);
    process.exit(1);
  }
}

function validatePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("Dataset must be a JSON object.");
    return;
  }

  if (!Number.isFinite(Date.parse(data.generatedAt))) {
    errors.push("generatedAt must be a valid date string.");
  }

  if (!cleanString(data.dataQuality)) {
    errors.push("dataQuality must explain source caveats.");
  }

  validateSources(data.sources);

  if (!Array.isArray(data.playgrounds)) {
    errors.push("playgrounds must be an array.");
    return;
  }

  if (data.playgrounds.length === 0) {
    errors.push("playgrounds must not be empty.");
  }

  if (data.count !== data.playgrounds.length) {
    errors.push(`count must match playgrounds.length (${data.playgrounds.length}).`);
  }

  validatePlaygrounds(data.playgrounds);
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length < REQUIRED_SOURCE_IDS.size) {
    errors.push(`sources must list at least ${REQUIRED_SOURCE_IDS.size} source records.`);
    return;
  }

  const sourceIds = new Set();

  for (const [index, source] of sources.entries()) {
    const label = `sources[${index}]`;
    const datasetId = cleanString(source?.datasetId);

    if (!cleanString(source?.name)) errors.push(`${label}.name is required.`);
    if (!isHttpUrl(source?.url)) errors.push(`${label}.url must be an HTTP URL.`);
    if (!datasetId) errors.push(`${label}.datasetId is required.`);
    if (!cleanString(source?.use)) errors.push(`${label}.use is required.`);

    sourceIds.add(datasetId);
  }

  for (const requiredId of REQUIRED_SOURCE_IDS) {
    if (!sourceIds.has(requiredId)) errors.push(`sources must include ${requiredId}.`);
  }
}

function validatePlaygrounds(playgrounds) {
  const ids = new Set();
  const typeCounts = new Map();

  for (const [index, playground] of playgrounds.entries()) {
    const label = `playgrounds[${index}]`;
    const id = cleanString(playground?.id);
    const type = cleanString(playground?.type);
    const latitude = Number(playground?.latitude);
    const longitude = Number(playground?.longitude);

    if (!id) {
      errors.push(`${label}.id is required.`);
    } else if (ids.has(id)) {
      errors.push(`${label}.id is duplicated: ${id}.`);
    } else {
      ids.add(id);
    }

    if (!cleanString(playground?.name)) errors.push(`${label}.name is required.`);
    if (!VALID_TYPES.has(type)) errors.push(`${label}.type must be a known playground category.`);
    if (!VALID_AREA_CATEGORIES.has(playground?.areaCategory)) {
      errors.push(`${label}.areaCategory must be a known size category.`);
    }
    if (!VALID_REGIONS.has(playground?.region)) errors.push(`${label}.region must be a Singapore region bucket.`);
    if (!isSingaporeCoordinate(latitude, longitude)) errors.push(`${label} coordinates must be within Singapore bounds.`);
    if (!Array.isArray(playground?.amenities)) errors.push(`${label}.amenities must be an array.`);
    if (!Array.isArray(playground?.notes) || playground.notes.length === 0) errors.push(`${label}.notes must be a non-empty array.`);
    if (!cleanString(playground?.source)) errors.push(`${label}.source is required.`);
    if (!isHttpUrl(playground?.sourceUrl)) errors.push(`${label}.sourceUrl must be an HTTP URL.`);
    if (!isHttpUrl(playground?.googleMapsUrl)) errors.push(`${label}.googleMapsUrl must be an HTTP URL.`);
    if (!/^-?\d+\.\d{6}, -?\d+\.\d{6}$/.test(cleanString(playground?.coordinateLabel))) {
      errors.push(`${label}.coordinateLabel must contain fixed-precision coordinates.`);
    }

    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  for (const type of VALID_TYPES) {
    if (!typeCounts.has(type)) errors.push(`playgrounds must include at least one ${type} record.`);
  }
}

function isSingaporeCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= SINGAPORE_BOUNDS.minLatitude &&
    latitude <= SINGAPORE_BOUNDS.maxLatitude &&
    longitude >= SINGAPORE_BOUNDS.minLongitude &&
    longitude <= SINGAPORE_BOUNDS.maxLongitude
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanString(value) {
  return String(value || "").trim();
}
