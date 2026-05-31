# Notices

This repository contains the source code for PlaySG. The MIT license applies to the code in this repository, except where a file says otherwise.

## Public Data Sources

PlaySG uses official data.gov.sg datasets published by NParks and Health Promotion Board/Parks@SG:

- NParks Parks
- NParks Parks and Nature Reserves
- Parks@SG

The generated file at `public/data/playgrounds.json` is a best-effort transformed dataset for this application. Managed-area size fields come from NParks polygon area values where available. They are not exact playground equipment footprints.

Use of Singapore government open datasets is governed by the Singapore Open Data Licence and any source-specific terms shown on data.gov.sg. Confirm the current terms before publishing derived datasets outside this app.

## Maps

The map view uses OpenStreetMap tiles through Leaflet. Keep the visible OpenStreetMap attribution in the map UI.

## Generated Data

Refresh the playground dataset with:

```bash
npm run data:playgrounds
```

The checked-in GitHub Actions workflow runs this refresh hourly and commits only when `public/data/playgrounds.json` changes.

The server exposes PlaySG-specific app configuration, health, static asset, and weather endpoints only. It does not include LTA DataMall or OneMap credentialed endpoints.
