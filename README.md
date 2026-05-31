# PlaySG

Mobile-first Singapore public playground map.

PlaySG maps NParks-managed playgrounds and parks that explicitly list playgrounds as an amenity. It uses React, Vite, Leaflet, OpenStreetMap tiles, and a checked-in static dataset generated from official data.gov.sg GeoJSON downloads.

## Data Source

The bundled dataset is written to:

```text
public/data/playgrounds.json
```

Generate it with:

```bash
npm run data:playgrounds
```

The builder uses these official sources:

- NParks Parks: dedicated point records whose names contain `PG` or `PLAYGROUND`
- NParks Parks and Nature Reserves: polygon area joined by name for managed-area size
- Parks@SG: parks that list `Playground` as an amenity

The `areaSqm` and `areaLabel` fields describe the NParks managed-area or park polygon where available. They should not be treated as exact play-equipment footprint measurements.

## Refresh Cadence

The frontend refetches `/data/playgrounds.json` once per hour while a browser tab is open.

The repository also includes an hourly GitHub Actions workflow at `.github/workflows/refresh-playgrounds.yml`. It runs `npm run data:playgrounds`, verifies the build, and commits `public/data/playgrounds.json` only when source-derived data changes. The generator preserves `generatedAt` when records are unchanged so the schedule does not create hourly churn.

## User Features

- Search by playground, park, region, type, or scale
- Filter by dedicated playgrounds, parks with playgrounds, managed-area size, and region
- Use current location to rank nearby playgrounds
- Tap markers or list rows to view coordinates, managed-area size, source notes, and Google Maps links
- Open the `/data` page for source and caveat details

## Run Locally

```bash
npm install
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
npm run data:playgrounds
```

## Notes

The Express server still serves the built frontend and optional legacy API endpoints from the original Singapore EV charger reference app. The playground experience itself loads the static playground dataset from `/data/playgrounds.json`.

Keep the visible OpenStreetMap attribution in the map UI.
