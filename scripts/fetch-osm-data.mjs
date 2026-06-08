import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const OUT_PATH = path.join(rootDir, "public", "data", "osm-playgrounds.json");
// const GEOJSON_PATH = path.join(rootDir, "public", "data", "osm-playgrounds-geojson.json");

const DATASETS = {
  osm: {
    id: "nwr[leisure=playground] in Singapore",
    label: "OpenStreetMap playgrounds (Singapore)",
    url: "https://www.openstreetmap.org/?query=leisure%3Dplayground#map=12/1.3521/103.8198",
    use: "Playgrounds mapped by OpenStreetMap contributors, fetched via the Overpass API.",
  },
};

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Note: {{geocodeArea:Singapore}} is an Overpass Turbo macro — not supported by the raw /interpreter endpoint.
// Use area["name"="Singapore"] for the same effect on the raw API.
const QUERY = `[out:json][timeout:300];area["name"="Singapore"]->.searchArea;nwr["leisure"="playground"](area.searchArea);out geom;`;

// ─── Overpass client ────────────────────────────────────────────────────────────

async function overpassJson(query, { endpoint = OVERPASS_URL, userAgent = "sg-play-overpass-mjs/1.0", verbose = false } = {}) {
  if (verbose) {
    console.log(`[overpass] endpoint=${endpoint}`);
    console.log(`[overpass] query=${query}`);
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
      "Cache-control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    switch (resp.status) {
      case 400: throw new OverpassError(`400 Bad Request: ${text.slice(0, 300)}`);
      case 429: throw new OverpassError(`429 Rate Limit Exceeded`);
      case 504: throw new OverpassError(`504 Gateway Timeout`);
      default:  throw new OverpassError(`${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
    }
  }

  const json = await resp.json();
  if (json.remark) throw new OverpassError(`Runtime error: ${json.remark}`);
  return json;
}

class OverpassError extends Error {
  constructor(message) {
    super(`Overpass Error: ${message}`);
    this.name = "OverpassError";
  }
}

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function geodesicArea(coords) {
  if (!coords || coords.length < 3) return 0;
  const R = 6371010;
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % n];
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    area += Δλ * (2 + Math.sin(φ1) + Math.sin(φ2));
  }
  return Math.abs(area * R * R / 2);
}

function centroid(coords) {
  if (!coords || coords.length === 0) return null;
  const lats = coords.map(c => c[1]);
  const lons = coords.map(c => c[0]);
  return {
    lat: lats.reduce((a, b) => a + b, 0) / lats.length,
    lon: lons.reduce((a, b) => a + b, 0) / lons.length,
  };
}

function getAreaLabel(areaSqm) {
  if (!areaSqm || areaSqm <= 0) return "Area unavailable";
  if (areaSqm < 2000)          return `${Math.round(areaSqm).toLocaleString()} sqm`;
  if (areaSqm < 10000)         return `${Math.round(areaSqm).toLocaleString()} sqm`;
  if (areaSqm < 100000)        return `${(areaSqm / 10000).toFixed(1)} ha`;
  return `${(areaSqm / 10000).toFixed(1)} ha`;
}

function getAreaCategory(areaSqm) {
  if (!areaSqm || areaSqm <= 0) return "Area unavailable";
  if (areaSqm < 2000)           return "Pocket";
  if (areaSqm < 10000)          return "Neighbourhood";
  if (areaSqm < 50000)          return "Large";
  return "Destination";
}

// ─── Enrichment helpers ───────────────────────────────────────────────────────

function getRegion(lat, lon) {
  const center = { lat: 1.3521, lon: 103.8198 };
  const latDelta = lat - center.lat;
  const lonDelta = lon - center.lon;
  if (Math.abs(latDelta) <= 0.035 && Math.abs(lonDelta) <= 0.045) return "Central";
  const latW = Math.abs(latDelta) / 0.09;
  const lonW = Math.abs(lonDelta) / 0.13;
  if (latW >= lonW) return latDelta >= 0 ? "North" : "South";
  return lonDelta >= 0 ? "East" : "West";
}

function buildAddress(tags) {
  const parts = [
    clean(tags["addr:housenumber"]),
    clean(tags["addr:street"]),
    tags["addr:postcode"] ? `Singapore ${tags["addr:postcode"]}` : null,
  ].filter(Boolean);
  return parts.join(", ") || clean(tags.address) || "";
}

function buildAmenities(tags) {
  const list = [];
  const swingType = tags["playground:swing"] || tags.swing || "";
  const slideType = tags["playground:slide"] || tags.slide || "";
  const seesawType = tags["playground:seesaw"] || tags.seesaw || "";
  const sandpitType = tags["playground:sandpit"] || tags.sandpit || "";
  const climbingType = tags["playground:climbing"] || tags.climbing || "";
  const merryGoRound = tags["leisure:playground"] === "merry_go_round" || tags.merry_go_round;
  const springy = tags["leisure:playground"] === "springy" || tags.springy;
  const hammock = tags["playground:hammock"];
  const spinner = tags["playground:spinner"];
  const zipLine = tags["playground:zip_line"];
  const playhouse = tags["playground:playhouse"];
  const waterPlay = tags["playground:water_play"];

  if (swingType && swingType !== "no")   list.push("Swing");
  if (slideType && slideType !== "no")    list.push("Slide");
  if (seesawType && seesawType !== "no") list.push("Seesaw");
  if (sandpitType && sandpitType !== "no") list.push("Sand play area");
  if (climbingType && climbingType !== "no") list.push("Climbing equipment");
  if (merryGoRound)                      list.push("Merry-go-round");
  if (springy)                           list.push("Spring rider");
  if (hammock)                           list.push("Hammock");
  if (spinner)                           list.push("Spinner");
  if (zipLine)                           list.push("Zip line");
  if (playhouse)                         list.push("Playhouse");
  if (waterPlay)                         list.push("Water play");

  return list;
}

function buildNotes(tags) {
  const notes = [];
  if (tags.operator)    notes.push(`Operator: ${tags.operator}`);
  if (tags.surface)     notes.push(`Surface: ${tags.surface}`);
  if (tags.fenced === "yes") notes.push("Fenced");
  if (tags.wheelchair === "yes") notes.push("Wheelchair accessible");
  if (tags.min_age || tags.max_age) {
    notes.push(`Age range: ${[tags.min_age, tags.max_age].filter(Boolean).join("-")}`);
  }
  if (tags.description) notes.push(tags.description);
  return notes;
}

function buildGoogleMapsUrl(latitude, longitude) {
  const query = encodeURIComponent(`${latitude},${longitude}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
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
    ["PL", "Place"],
    ["WK", "Walk"],
  ]);

  return clean(value)
    .replace(/`/g, "'")
    .split(/\s+/)
    .map((word) => {
      const stripped = word.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (abbreviationMap.has(stripped)) return word.replace(stripped, abbreviationMap.get(stripped));
      if (/^[IVX]+$/i.test(word)) return word.toUpperCase();
      if (word.includes("-")) return word.split("-").map(formatDisplayName).join("-");
      if (!word) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeName(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[`']/g, "")
    .replace(/\bplayground\b/g, "pg")
    .replace(/\bpark\b/g, "pk")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clean(val) {
  if (val == null) return "";
  const s = String(val).trim();
  return s || "";
}

// ─── Playground enrichment ─────────────────────────────────────────────────────

const OSM_TAG_KEYS = [
  "surface", "operator", "access", "wheelchair", "fenced",
  "min_age", "max_age", "opening_hours", "description",
  "addr:housenumber", "addr:street", "addr:postcode", "addr:city",
  "building", "indoor", "note",
  "playground:swing", "playground:slide", "playground:seesaw",
  "playground:sandpit", "playground:climbing", "playground:hammock",
  "playground:spinner", "playground:zip_line", "playground:playhouse",
  "playground:water_play", "leisure:playground",
  "url", "website", "is_in", "place", "wikidata", "wikipedia",
];

function pickOsmTags(tags) {
  const out = {};
  for (const k of OSM_TAG_KEYS) {
    if (tags[k] != null) out[k] = tags[k];
  }
  return out;
}

function extractGeometry(element) {
  if (element.type === "way" && element.geometry && element.geometry.length > 0) {
    const coords = element.geometry.map((g) => [g.lon, g.lat]);
    const c = centroid(coords);
    if (!c) return null;
    return { lat: c.lat, lon: c.lon, areaSqm: geodesicArea(coords) };
  }
  if (element.lat != null && element.lon != null) {
    return { lat: element.lat, lon: element.lon, areaSqm: 0 };
  }
  return null;
}

function deriveUnnamedLabel(tags, lat, lon) {
  const street = clean(tags["addr:street"]);
  if (street) return `Unnamed playground at ${formatDisplayName(street)}`;
  const place = clean(tags.is_in) || clean(tags.place);
  if (place) return `Unnamed playground in ${formatDisplayName(place)}`;
  return `Unnamed playground at ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function enrichPlayground(element, allElements) {
  const tags = element.tags || {};
  const name = clean(tags.name);
  if (!name) return null;

  const geom = extractGeometry(element);
  if (!geom) return null;
  const { lat, lon, areaSqm } = geom;

  const indoor = tags.indoor === "yes";
  const isEnclosed = indoor || tags.building || tags.covered === "yes";
  const playgroundType = "Dedicated playground";
  const areaLabel = getAreaLabel(areaSqm);
  const areaCategory = getAreaCategory(areaSqm);
  const region = getRegion(lat, lon);
  const amenities = buildAmenities(tags);
  const notes = buildNotes(tags);
  const address = buildAddress(tags);

  if (indoor) notes.unshift("Indoor playground (mapped in OSM).");
  else if (isEnclosed) notes.unshift("Covered or enclosed playground (mapped in OSM).");

  notes.push(
    areaSqm
      ? "Area is the OSM-mapped polygon footprint, not a measured play-equipment area."
      : "Area is unavailable (no polygon geometry in OSM).",
  );

  const osmTags = pickOsmTags(tags);

  return {
    id: `osm-${element.type}-${element.id}`,
    name: formatDisplayName(name),
    rawName: clean(tags["name:en"]) || name,
    type: playgroundType,
    latitude: lat,
    longitude: lon,
    areaSqm,
    areaLabel,
    areaCategory,
    address,
    amenities,
    source: "OpenStreetMap",
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    googleMapsUrl: buildGoogleMapsUrl(lat, lon),
    updatedAt: clean(tags["addr:date"] || tags["last_edit"] || ""),
    notes,
    region,
    coordinateLabel: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    osmTags,
  };
}

// ─── Unnamed record builder ───────────────────────────────────────────────────

function buildUnnamedRecord(element) {
  const tags = element.tags || {};
  if (clean(tags.name)) return null;

  const geom = extractGeometry(element);
  if (!geom) return null;
  const { lat, lon, areaSqm } = geom;
  if (!isSingaporeCoordinate(lat, lon)) return null;

  const osmTags = pickOsmTags(tags);
  const id = `osm-${element.type}-${element.id}`;

  return {
    id,
    elementType: element.type,
    name: deriveUnnamedLabel(tags, lat, lon),
    rawName: clean(tags["name:en"]) || "",
    type: "Unnamed playground",
    latitude: lat,
    longitude: lon,
    areaSqm,
    areaLabel: getAreaLabel(areaSqm),
    areaCategory: getAreaCategory(areaSqm),
    address: buildAddress(tags),
    amenities: buildAmenities(tags),
    source: "OpenStreetMap (unnamed)",
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    googleMapsUrl: buildGoogleMapsUrl(lat, lon),
    updatedAt: clean(tags["addr:date"] || tags["last_edit"] || ""),
    notes: [
      "No name tag in OpenStreetMap. Confirm the location in Google Maps before adding to a curated list.",
      areaSqm
        ? "Area is the OSM-mapped polygon footprint, not a measured play-equipment area."
        : "Area is unavailable (no polygon geometry in OSM).",
    ],
    region: getRegion(lat, lon),
    coordinateLabel: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    osmTags,
  };
}

// ─── GeoJSON conversion (disabled — see GEOJSON_PATH above) ────────────────────
//
// function osmToGeoJSON(data) {
//   const nodes = new Map();
//   const ways = [];
//
//   for (const el of (data.elements || [])) {
//     if (el.type === "node") nodes.set(el.id, el);
//     else if (el.type === "way") ways.push(el);
//   }
//
//   const features = [];
//
//   for (const node of nodes.values()) {
//     if (node.lat == null || node.lon == null) continue;
//     features.push({
//       type: "Feature",
//       id: `node/${node.id}`,
//       properties: { type: "node", id: node.id, tags: node.tags || {} },
//       geometry: { type: "Point", coordinates: [node.lon, node.lat] },
//     });
//   }
//
//   for (const way of ways) {
//     if (!way.geometry || way.geometry.length === 0) continue;
//     const coords = way.geometry.map(g => [g.lon, g.lat]);
//     const isClosed =
//       coords.length >= 3 &&
//       coords[0][0] === coords[coords.length - 1][0] &&
//       coords[0][1] === coords[coords.length - 1][1];
//
//     features.push({
//       type: "Feature",
//       id: `way/${way.id}`,
//       properties: { type: "way", id: way.id, tags: way.tags || {} },
//       geometry: isClosed
//         ? { type: "Polygon", coordinates: [coords] }
//         : { type: "LineString", coordinates: coords },
//     });
//   }
//
//   return { type: "FeatureCollection", features };
// }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching OSM playgrounds via Overpass API...\n");

  const data = await overpassJson(QUERY, { verbose: true });
  const total = data.elements?.length ?? 0;
  console.log(`\nReceived ${total} raw OSM elements`);

  // Build GeoJSON (full fidelity) — disabled, see GEOJSON_PATH above
  // const geojson = osmToGeoJSON(data);
  // await fs.writeFile(GEOJSON_PATH, JSON.stringify(geojson, null, 2));
  // console.log(`GeoJSON saved to ${GEOJSON_PATH} (${geojson.features.length} features)`);

  // Enrich into playground records
  const allElements = data.elements || [];
  const playgrounds = [];
  const unnamedPlaygrounds = [];
  const seen = new Set();
  let outOfBounds = 0;
  let unnamedDropped = 0;

  for (const el of allElements) {
    if (el.type === "relation") continue;
    const tags = el.tags || {};
    if (!clean(tags.name)) {
      const unnamed = buildUnnamedRecord(el);
      if (unnamed) {
        unnamedPlaygrounds.push(unnamed);
      } else {
        unnamedDropped += 1;
      }
      continue;
    }
    const pg = enrichPlayground(el, allElements);
    if (!pg) continue;
    if (!isSingaporeCoordinate(pg.latitude, pg.longitude)) {
      outOfBounds += 1;
      continue;
    }
    const key = `${normalizeName(pg.name)}-${Math.round(pg.latitude * 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    playgrounds.push(pg);
  }

  playgrounds.sort((a, b) => a.name.localeCompare(b.name));
  unnamedPlaygrounds.sort((a, b) => a.id.localeCompare(b.id));

  const output = {
    generatedAt: new Date().toISOString(),
    count: playgrounds.length,
    unnamedCount: unnamedPlaygrounds.length,
    dataQuality:
      "OpenStreetMap playground data via Overpass API using area lookup by name='Singapore'. Coverage is volunteer-maintained and may be incomplete. Area is calculated from polygon geometry using a geodesic formula — it describes the OSM-mapped footprint, not a measured play-equipment area. Unnamed OSM records are kept separately so they can be cross-referenced to Google Maps or other sources before being added to a curated list.",
    sources: [
      {
        name: DATASETS.osm.label,
        url: DATASETS.osm.url,
        datasetId: DATASETS.osm.id,
        use: DATASETS.osm.use,
      },
    ],
    playgrounds,
    unnamedPlaygrounds,
  };

  await fs.writeFile(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  const outRelative = path.relative(rootDir, OUT_PATH);
  console.log(`Structured output saved to ${outRelative} (${playgrounds.length} named, ${unnamedPlaygrounds.length} unnamed)`);
  if (outOfBounds) console.log(`  ${outOfBounds} out-of-bounds elements dropped`);
  if (unnamedDropped) console.log(`  ${unnamedDropped} unnamed elements dropped (no usable geometry or out of bounds)`);

  // Summary stats
  const withOperator = playgrounds.filter(p => p.osmTags.operator).length;
  const withSurface  = playgrounds.filter(p => p.osmTags.surface).length;
  const withArea     = playgrounds.filter(p => p.areaSqm > 0).length;
  const withAmenities = playgrounds.filter(p => p.amenities.length > 0).length;
  const withAddress  = playgrounds.filter(p => p.address).length;

  const unnamedWithStreet = unnamedPlaygrounds.filter(p => /Unnamed playground at /.test(p.name) && !/at \d+\.\d+/.test(p.name)).length;
  const unnamedWithAddress = unnamedPlaygrounds.filter(p => p.address).length;

  console.log(`\nCoverage summary (named):`);
  console.log(`  ${withOperator} with operator | ${withSurface} with surface | ${withAddress} with address`);
  console.log(`  ${withArea} with area | ${withAmenities} with amenities`);
  console.log(`  ${playgrounds.length} total`);
  console.log(`\nCoverage summary (unnamed):`);
  console.log(`  ${unnamedWithStreet} with street hint | ${unnamedWithAddress} with address | ${unnamedPlaygrounds.length} total`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
