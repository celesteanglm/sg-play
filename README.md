# PlaySG

Mobile-first Singapore public playground map.

PlaySG maps NParks-managed playgrounds and parks that explicitly list playgrounds as an amenity. It uses React, Vite, Leaflet, OpenStreetMap tiles, and a checked-in static dataset generated from official data.gov.sg GeoJSON downloads.

## Data Sources

PlaySG builds one generated playground file for the app:

```text
public/data/playgrounds.json
```

The frontend reads this file directly. Regenerate it with:

```bash
npm run data:playgrounds
```

The generator is:

```text
scripts/build-playground-data.mjs
```

### Official Park Inputs

| Source | Dataset ID | Used for |
| --- | --- | --- |
| NParks Parks | `d_0542d48f0991541706b58059381a6eca` | Dedicated playground point records. The app classifies records whose names contain `PG` or `PLAYGROUND` as `Dedicated playground`. |
| Parks@SG | `d_99b71f5d34cf57a3a592fbfdef1f42b6` | Parks that explicitly list `Playground` as an amenity. These become `Park with playground` records and provide amenity text when available. |
| NParks Parks and Nature Reserves | `d_77d7ec97be83d44f61b85454f844382f` | Managed-area or park polygon sizes joined by name to support `Pocket`, `Neighbourhood`, `Large`, and `Destination` size filters. |

### Derived Fields and Caveats

- `type` is the category of record: `Dedicated playground` versus `Park with playground`.
- `areaCategory` is a size bucket derived from managed-area or park polygon size. It is separate from `type`, so a dedicated playground can also be `Pocket`.
- `areaSqm` and `areaLabel` describe the NParks managed area or park polygon where available. They are not measured play-equipment footprints.
- Sand status is conservative. The app only shows sand as listed when Parks@SG explicitly publishes a sand play amenity; otherwise it shows no sand listed or unavailable.
- `region` is a broad coordinate-derived Singapore region bucket for filtering.
- Google Maps links are direct coordinate links generated from latitude and longitude. There is no Google Maps API integration.

### Weather, Map, and Location Sources

- NEA/data.gov.sg provides today's forecast and the official 4-day outlook through public APIs.
- Open-Meteo extends the weather panel to days 5-7 with model forecast data when available.
- OpenStreetMap tiles are rendered through Leaflet. Keep the visible attribution in the map UI.
- Browser geolocation is used only after permission and only to rank visible playgrounds near the user.

PlaySG does not require private API keys for the playground map, weather planning, OpenStreetMap tiles, or direct Google Maps links.

### Repository Data Folder Recommendation

Keep generated app data in `public/data/` because Vite and Express serve that directory to the browser. Do not add a separate top-level `data/` folder yet.

Add a top-level `data/` folder only if the repo starts keeping raw downloads, audit snapshots, notebooks, or intermediate data that should not be served publicly. If that happens, keep large or reproducible raw files out of git unless there is a specific reason to version them.

For the longer source model and field reference, see [`docs/data-sources.md`](docs/data-sources.md).

## Refresh Cadence

The frontend refetches `/data/playgrounds.json` once per hour while a browser tab is open.

The repository also includes an hourly GitHub Actions workflow at `.github/workflows/refresh-playgrounds.yml`. It runs `npm run data:playgrounds`, verifies the generated data and build, and commits `public/data/playgrounds.json` only when source-derived data changes. The generator preserves `generatedAt` when records are unchanged so the schedule does not create hourly churn.

## User Features

- Search by playground, park, region, type, or scale
- Filter by dedicated playgrounds, parks with playgrounds, managed-area size, sand status, and region
- Use current location to rank nearby playgrounds
- Check compact weather details before heading out
- Tap markers or list rows to view coordinates, managed-area size, sand notes, source notes, and Google Maps links
- Open the `/data` page for source and caveat details

## Run Locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`.

For a production-style local run:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:8787`.

Useful checks:

```bash
npm run build
npm run data:check
npm run data:playgrounds
```

## Environment

PlaySG does not require private API keys for the playground map or weather planning features.

- `GA_MEASUREMENT_ID`: optional Google Analytics measurement ID. Leave blank locally to disable analytics.
- `NEA_WEATHER_BASE_URL`: optional override for the public data.gov.sg weather API.
- `OPEN_METEO_FORECAST_URL`: optional override for the public Open-Meteo forecast API.
- `WEATHER_CACHE_TTL_MS`: optional server-side weather cache duration.
- `WEATHER_FETCH_TIMEOUT_MS`: optional weather fetch timeout.
- `PORT` and `HOST`: optional Express server bind settings.

## Notes

The Express server only exposes PlaySG app configuration, health, static assets, and weather planning endpoints. The playground map itself does not call OneMap or LTA DataMall and does not need OneMap credentials or an LTA API key.

Keep the visible OpenStreetMap attribution in the map UI.

Repo-specific planning notes live in [`docs/todo.md`](docs/todo.md).
