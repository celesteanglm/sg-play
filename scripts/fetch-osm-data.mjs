import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "osm-playgrounds.json");
const GEOJSON_PATH = path.join(__dirname, "osm-playgrounds-geojson.json");

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

function clean(val) {
  if (val == null) return "";
  const s = String(val).trim();
  return s || "";
}

// ─── Playground enrichment ─────────────────────────────────────────────────────

function enrichPlayground(element, allElements) {
  const tags = element.tags || {};
  const name = clean(tags.name);
  if (!name) return null;

  const isWay = element.type === "way";
  let lat, lon, areaSqm = 0, coords = [];

  if (isWay && element.geometry && element.geometry.length > 0) {
    coords = element.geometry.map(g => [g.lon, g.lat]);
    const c = centroid(coords);
    lat = c?.lat ?? 0;
    lon = c?.lon ?? 0;
    areaSqm = geodesicArea(coords);
  } else if (element.lat != null) {
    lat = element.lat;
    lon = element.lon;
  } else {
    return null;
  }

  const playgroundType = tags.indoor === "yes" ? "Indoor playground" : "Outdoor playground";
  const areaLabel = getAreaLabel(areaSqm);
  const areaCategory = getAreaCategory(areaSqm);
  const region = getRegion(lat, lon);
  const amenities = buildAmenities(tags);
  const notes = buildNotes(tags);
  const address = buildAddress(tags);

  const osmTags = {};
  const tagKeys = [
    "surface", "operator", "access", "wheelchair", "fenced",
    "min_age", "max_age", "max_age", "opening_hours", "description",
    "addr:housenumber", "addr:street", "addr:postcode", "addr:city",
    "building", "indoor", "note",
    "playground:swing", "playground:slide", "playground:seesaw",
    "playground:sandpit", "playground:climbing", "playground:hammock",
    "playground:spinner", "playground:zip_line", "playground:playhouse",
    "playground:water_play", "leisure:playground",
    "url", "website",
  ];
  for (const k of tagKeys) {
    if (tags[k] != null) osmTags[k] = tags[k];
  }

  return {
    id: `osm-${element.type}-${element.id}`,
    name,
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
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`,
    updatedAt: tags["addr:date"] || tags["last_edit"] || "",
    notes,
    region,
    coordinateLabel: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    osmTags,
  };
}

// ─── GeoJSON conversion ────────────────────────────────────────────────────────

function osmToGeoJSON(data) {
  const nodes = new Map();
  const ways = [];

  for (const el of (data.elements || [])) {
    if (el.type === "node") nodes.set(el.id, el);
    else if (el.type === "way") ways.push(el);
  }

  const features = [];

  for (const node of nodes.values()) {
    if (node.lat == null || node.lon == null) continue;
    features.push({
      type: "Feature",
      id: `node/${node.id}`,
      properties: { type: "node", id: node.id, tags: node.tags || {} },
      geometry: { type: "Point", coordinates: [node.lon, node.lat] },
    });
  }

  for (const way of ways) {
    if (!way.geometry || way.geometry.length === 0) continue;
    const coords = way.geometry.map(g => [g.lon, g.lat]);
    const isClosed =
      coords.length >= 3 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1];

    features.push({
      type: "Feature",
      id: `way/${way.id}`,
      properties: { type: "way", id: way.id, tags: way.tags || {} },
      geometry: isClosed
        ? { type: "Polygon", coordinates: [coords] }
        : { type: "LineString", coordinates: coords },
    });
  }

  return { type: "FeatureCollection", features };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching OSM playgrounds via Overpass API...\n");

  const data = await overpassJson(QUERY, { verbose: true });
  const total = data.elements?.length ?? 0;
  console.log(`\nReceived ${total} raw OSM elements`);

  // Build GeoJSON (full fidelity)
  const geojson = osmToGeoJSON(data);
  await fs.writeFile(GEOJSON_PATH, JSON.stringify(geojson, null, 2));
  console.log(`GeoJSON saved to ${GEOJSON_PATH} (${geojson.features.length} features)`);

  // Enrich into playground records
  const allElements = data.elements || [];
  const playgrounds = [];
  const seen = new Set();

  for (const el of allElements) {
    if (el.type === "relation") continue;
    const pg = enrichPlayground(el, allElements);
    if (!pg) continue;
    const key = `${pg.name.toLowerCase()}-${Math.round(pg.latitude * 1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    playgrounds.push(pg);
  }

  playgrounds.sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    generatedAt: new Date().toISOString(),
    count: playgrounds.length,
    dataQuality:
      "OpenStreetMap playground data via Overpass API using area lookup by name='Singapore'. Coverage is volunteer-maintained and may be incomplete. Area is calculated from polygon geometry using a geodesic formula — it describes the OSM-mapped footprint, not a measured play-equipment area.",
    overpassQuery: QUERY,
    playgrounds,
  };

  await fs.writeFile(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Structured output saved to ${OUT_PATH} (${playgrounds.length} playgrounds)`);

  // Summary stats
  const withOperator = playgrounds.filter(p => p.osmTags.operator).length;
  const withSurface  = playgrounds.filter(p => p.osmTags.surface).length;
  const withArea     = playgrounds.filter(p => p.areaSqm > 0).length;
  const withAmenities = playgrounds.filter(p => p.amenities.length > 0).length;
  const indoor        = playgrounds.filter(p => p.type === "Indoor playground").length;

  console.log(`\nCoverage summary:`);
  console.log(`  ${withOperator} with operator | ${withSurface} with surface`);
  console.log(`  ${withArea} with area | ${withAmenities} with amenities`);
  console.log(`  ${indoor} indoor | ${playgrounds.length} total`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
