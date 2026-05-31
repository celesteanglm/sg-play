# PlaySG Data Sources

PlaySG is built from public Singapore park data and public forecast/map services. The playground map does not need OneMap credentials, an LTA DataMall key, or a Google Maps API key.

## Generated Playground Dataset

The frontend reads the checked-in dataset at:

```text
public/data/playgrounds.json
```

Regenerate it with:

```bash
npm run data:playgrounds
```

The generator is:

```text
scripts/build-playground-data.mjs
```

## Official Park Inputs

| Source | Dataset ID | Used for |
| --- | --- | --- |
| NParks Parks | `d_0542d48f0991541706b58059381a6eca` | Dedicated playground point records whose names contain `PG` or `PLAYGROUND`. |
| NParks Parks and Nature Reserves | `d_77d7ec97be83d44f61b85454f844382f` | Managed-area and park polygon sizes joined by name. |
| Parks@SG | `d_99b71f5d34cf57a3a592fbfdef1f42b6` | Parks that explicitly list `Playground` as an amenity, plus amenity details such as sand when published. |

## Derived Fields

- `type`: `Dedicated playground` for NParks point records; `Park with playground` for park records that list playgrounds as an amenity.
- `areaCategory`: `Pocket`, `Neighbourhood`, `Large`, `Destination`, or `Area unavailable`, based on managed-area or park polygon size.
- `areaLabel`: formatted managed-area size. This is not the measured footprint of the playground equipment.
- `region`: rough Singapore region bucket derived from coordinates.
- `googleMapsUrl`: direct Google Maps URL built from coordinates.
- `amenities`: Parks@SG amenity text when available.

## Parent Planning Data

Sand status is intentionally conservative:

- `Sand play listed`: Parks@SG explicitly lists a sand play area.
- `No sand listed`: Parks@SG publishes amenities, but sand is not listed.
- `Sand info unavailable`: the source record does not publish enough amenity detail.

## Weather Data

The server exposes `/api/weather` and caches weather responses server-side.

- NEA/data.gov.sg is used for today's forecast and the official 4-day outlook.
- Open-Meteo is used to extend planning details to days 5-7 when available.
- The weather API uses public endpoints and no API keys.

Relevant environment variables:

```text
NEA_WEATHER_BASE_URL
OPEN_METEO_FORECAST_URL
WEATHER_CACHE_TTL_MS
WEATHER_FETCH_TIMEOUT_MS
```

## Map and Location

- Map tiles: OpenStreetMap tiles rendered through Leaflet.
- Directions: direct Google Maps links generated from coordinates.
- Near-me ranking: browser geolocation, only after the user grants permission.

## Refresh Model

The app fetches `/data/playgrounds.json` periodically while the browser is open. The GitHub Actions workflow at `.github/workflows/refresh-playgrounds.yml` also rebuilds the generated dataset hourly and commits only when source-derived records change.

## Folder Recommendation

Keep generated app data in `public/data/` because it is intentionally served to the browser. Do not add a separate top-level `data/` folder unless the project starts keeping raw downloads, manual audit snapshots, notebooks, or intermediate files that are not part of the public app bundle.

If a top-level `data/` folder is added later, large or reproducible raw files should usually be ignored rather than committed.

## Known Gaps

- Surface details are sparse because official amenity data is inconsistent.
- Size categories describe managed area or park area, not playground equipment footprint.
- There is no crowd-submitted enrichment layer yet.
- Legacy EV charger server endpoints and sample data still exist from the source project and should be removed once PlaySG no longer needs compatibility with that scaffold.
