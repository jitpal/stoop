# Data sources

## Bundled in the Worker (`src/data/`)

Regenerate when the source updates; each script documents its inputs.

| File | Built by | Source | Refresh |
| --- | --- | --- | --- |
| `stations.json` | `npm run data:stations -- <gtfs-dir>` | MTA static subway GTFS, `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip`. One entry per station complex (joined by in-system transfers); `routes` = lines stopping on weekday daytime service. | When service patterns change (the feed version is in the file and in `/healthz`) |
| `areas.json` | `npm run data:areas -- <constants.ts> <geojson>` | StreetEasy area codes from [evandcoleman/streeteasy-api](https://github.com/evandcoleman/streeteasy-api) `src/constants.ts` (MIT). Centers from Pediacities NYC neighborhoods ([HodgesWardElliott/custom-nyc-neighborhoods](https://github.com/HodgesWardElliott/custom-nyc-neighborhoods), `custom-pedia-cities-nyc-Mar2018.geojson`); 85 areas without a polygon have hand-placed centers in the script. | Rarely |

## Queried live

| Section | Dataset | Keyed by |
| --- | --- | --- |
| Geocoding, BBL/BIN | NYC Geosearch v2 (`geosearch.planninglabs.nyc`) | address text |
| HPD violations | NYC Open Data `wvxf-dwi5` | `bbl` |
| 311 complaints | `erm2-nwe9` | `bbl` |
| Bedbugs | `wz6d-d3jb` | `bbl` |
| Evictions | `6z8x-wfk4` | `bbl` |
| DOB violations | `3h2n-5cm9` | `bin` |
| Permits | `rbx6-tga4` (DOB NOW approved permits) | `bin` |
| Overview | `64uk-42ks` (PLUTO) | `bbl` |
| Owner / agent | `tesw-yqqr` + `feu5-w2e2` (HPD registrations + contacts) | `bin`, then `registrationid` |
| Flood zone | FEMA NFHL MapServer layer 28 | point |

Column names come from nycdb's dataset definitions and the datasets' published
schemas, but couldn't be checked against the live API from the build
environment. `npm run check-datasets` verifies every dataset and column; the
code reads uncertain columns defensively, so a rename shows up as a missing
field or an `unavailable` section rather than wrong numbers.

Socrata disagrees across datasets on whether `bbl`/`bin` are text or numbers;
`src/building/socrata.ts` tries quoted first, retries unquoted on a type-mismatch
error, and remembers what worked.

## Caveats worth telling users

- HPD violation class: A non-hazardous, B hazardous, C immediately hazardous.
- 311 counts are complaints, not confirmed problems; heat season is Oct 1 – May 31.
- Bedbug filings cover the previous 12 months and are filed by landlords of 3+ unit buildings.
- Evictions are executed evictions only, not court filings.
