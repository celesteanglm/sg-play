# PlaySG Roadmap Notes

Product and data-quality ideas for the playground map.

## Parent Planning Value

- Add richer official amenities when a reliable source exists, such as toilets, water play, shelters, stroller access, nearby food, and accessibility notes.
- Keep sand and surface details conservative unless the source explicitly publishes them.
- Add saved places or a shortlist flow for families comparing several playgrounds before leaving home.
- Add a wet-weather backup affordance when the daily forecast looks risky.

## Data Quality

- Add a review report for records with missing area, missing amenities, or suspicious coordinates.
- Track potential duplicates between NParks point records and Parks@SG amenity records.
- Keep category and size separate in copy, filters, docs, and analytics.
- Consider a curated enrichment layer only after deciding how manual edits will be reviewed and refreshed.

## Technical Cleanup

- Keep environment variables documented in `.env.example`, `README.md`, and `docs/data-sources.md`.
- Expand `npm run data:check` when adding new generated fields or source datasets.
