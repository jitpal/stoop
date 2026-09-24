# stoop — design

An MCP server on Cloudflare Workers that lets an agent search NYC rentals by
neighborhood, subway stop, or any place, and check the building before you
tour it. Unofficial: listing data comes from StreetEasy's private GraphQL API
(the one its website uses), which can change without notice.

## Constraints we designed around

- **StreetEasy blocks datacenter IPs** (PerimeterX). A Worker can't call it
  directly. Upstream calls go through a provider (Zyte by default; Bright
  Data, a home relay, or direct) behind one `UpstreamProvider` interface
  (`src/upstream/providers.ts`), picked by the `UPSTREAM_PROVIDER` var.
- **Search filters by neighborhood code only.** No geo, radius, or transit
  filter has been found. Location search is ours: resolve a point, search the
  neighborhoods around it, filter listings by distance.
- **Read-only.** No agent contact or tour requests (those sit behind a human
  check). We return the listing URL instead.

## Architecture

```
Agent ──MCP──▶ Worker (auth, tools, cache, geo logic, caps)
                 ├─ Upstream (provider + daily cap + retries) ──▶ Zyte | Bright Data | relay ──▶ api-v6.streeteasy.com
                 ├─ NYC Open Data (Socrata) ─ direct, no proxy needed
                 ├─ NYC Geosearch ─ address/place → lat/lng + BBL/BIN
                 ├─ StoopStore Durable Object (SQLite): API keys, audit log,
                 │    daily upstream counter, cache (search ~15 min, details ~6 h,
                 │    building data ~1 day)
                 ├─ FEMA NFHL ─ flood zone by point
                 └─ Bundled: MTA stations, neighborhood codes + centers
```

Stack mirrors weworking: Hono, MCP SDK, zod, workers-oauth-provider, vitest
with the Workers pool, biome.

## Status (2026-09-24)

Verified live from a cloud container:

- `npm run smoke` through Zyte: search and listing detail both pass
  (~1.3 s and ~0.4 s); StreetEasy accepts `perPage: 50`.
- `npm run check-datasets`: every Open Data dataset and column exists;
  Geosearch and FEMA answer.
- The real service code, end to end: a station search (3 Zyte requests,
  ~5 s), a Prospect Park search (1 request), `get_listing`, and
  `check_building` by listing and by address, with every section `ok`.

Deployed the same day and checked over HTTP: admin sign-in, minting and
revoking a key, a live station search through Zyte (1 request, ~0.8 s; the
repeat was a cache hit, 0 requests), and each call in the audit log.

Not yet done: a real MCP client connected to the deployment.

## Tools

| Tool | Purpose |
| --- | --- |
| `search_rentals` | Where = `neighborhoods[]` \| `near_station` (+ optional line) \| `near_place` (free text), with `radius_minutes` (walk, default 10). Filters: price, beds, baths, required/optional amenities, pets, move-in date, no-fee, sort, page. Station/place searches return `distance_m` + `walk_min` and sort by distance. Each result carries building flags (batched, see below). |
| `get_listing` | Full detail: description, amenities, pet policy, price history, building, nearby stations with lines, photos, floor plans, URL, plus the building summary. |
| `check_building` | Full public-record report for a listing id or any address, with optional `sections` and `years`. Works for buildings with no active listing. |
| `find_station` | Fuzzy station lookup ("the Bedford L", "Atlantic Terminal") → station, lines, neighborhood. (The GTFS feed has no accessibility data, so no ADA status yet.) |
| `list_neighborhoods`, `list_amenities` | Reference lookups. |
| `stoop_status` | Provider and today's upstream request count. |

Output is a compact, normalized shape (numbers not strings, full photo URLs),
kept small for agent context.

### Location search

1. Resolve the point: station table, landmark table, or NYC Geosearch for
   free text (or raw coordinates).
2. Pick neighborhoods whose extent could overlap the radius: distance to the
   area's center minus its radius ≤ search radius + 250 m (cap 8).
3. Search them all in **one** StreetEasy request (the filter takes a list),
   50 per page, up to `MAX_PAGES_PER_SEARCH` pages; keep listings inside the
   radius; sort by distance. A cursor continues the scan.
4. Walk time = straight-line × 1.3 at ~80 m/min.

Neighborhood centers come from Pediacities neighborhood polygons (220 areas)
plus hand-placed centers (85), built by `scripts/build-areas.mjs`. See
docs/DATA.md.

## Public data

What's live now is listed in docs/DATA.md. In short: MTA stations (bundled),
NYC Geosearch, PLUTO, HPD violations, 311, bedbug filings, executed evictions,
DOB violations, DOB NOW permits, HPD registrations and contacts, and FEMA
flood zones.

Dropped: rent-stabilization counts from tax bills. They describe the
building, not the apartment, so they can't answer the question a renter has.

Left for later: HPD complaints (311 covers the same calls), DOB complaints,
landlord portfolio beyond the Who Owns What link, station accessibility,
commute routing, Citi Bike, OpenStreetMap amenities, elevator outages.

Reports state facts with dates and sources; no scores or "good/bad
neighborhood" labels.

### How building data flows

1. **Resolve the building once.** Listing address + coordinates → Geosearch →
   BBL (tax lot) and BIN (building). Accept the match only if it lands within
   150 m of the listing's `geoPoint`; otherwise mark `unmatched`. Cached
   for 90 days.
2. **Three depths, same queries:**
   - *Flags* on every search result: open class C violations, heat complaints in the last 12 months, bedbugs reported in 3
     years. One SoQL query per dataset per results page (`bbl IN (...)`),
     cached a day, so a page of 15 listings costs 3 Open Data calls, not 45.
   - *Summary* in `get_listing`: counts over the last 3 years + latest date
     per section.
   - *Full report* in `check_building`: per-section counts, trends by year,
     the most recent items with dates and descriptions, and links to the
     official record pages.
3. **Keys per dataset:** HPD violations, 311, evictions, bedbugs, PLUTO →
   BBL; DOB violations, permits, HPD
   registrations → BIN; flood zone → point query on coordinates.
4. **Honesty rules:** every section says its source, date range, and
   `as_of`; "no records" is distinct from "couldn't match the building".

## Safety

- Daily cap on upstream attempts (`MAX_UPSTREAM_REQUESTS_PER_DAY`, counted in
  the Durable Object before each attempt, so it is exact under concurrency).
- Cache, one request for all nearby neighborhoods, and a page cap per search,
  so each agent query has a predictable cost.
- Same auth shape as weworking. The operator signs in at `/admin` with
  `ADMIN_PASSWORD` (a signed 12-hour cookie; every form is CSRF-bound) and mints
  API keys there; only their SHA-256 is stored. MCP clients that speak OAuth can
  instead be approved on a page that asks for the same password. `OAUTH_KV` is
  the only KV namespace, because workers-oauth-provider requires one.
- Audit log of every tool call and key change (actor, scrubbed arguments,
  outcome, upstream requests spent), pruned after 90 days by a daily cron.
- Read-only; README and MCP instructions carry the unofficial-use disclaimer.

## Code map

| Path | What |
| --- | --- |
| `src/upstream/` | Providers (zyte, brightdata, relay, direct), retries, daily budget |
| `src/streeteasy/` | GraphQL queries (vendored), client, normalization, amenities |
| `src/geo/` | Distance, areas, stations, Geosearch, landmarks |
| `src/building/` | Socrata client, building resolution, report sections |
| `src/core/service.ts` | Search, listing, building report, lookups |
| `src/mcp/` | Tool definitions and the /mcp handler |
| `src/auth/` | OAuth provider and approval page, admin session, API key minting and lookup |
| `src/http/` | Admin pages (status, API keys, audit log) and the shared HTML shell |
| `src/store/do.ts` | The `StoopStore` Durable Object: keys, audit, daily budget, cache |
| `scripts/` | Data builders, smoke test, relay, dataset checker |
