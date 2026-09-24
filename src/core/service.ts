/**
 * What the tools do, independent of MCP.
 *
 * Search by location works around StreetEasy's neighborhood-only filter: find
 * the point, search every neighborhood the radius could touch in one request,
 * then keep listings whose own coordinates fall inside the radius.
 *
 * Cost control: every StreetEasy page is one paid upstream request (cached 15
 * minutes), a search scans at most MAX_PAGES_PER_SEARCH pages, and building
 * lookups (free, but each one is a subrequest) only run for returned listings.
 */

import {
  type BuildingFlags,
  buildingReport,
  flagsFor,
  type ReportSection,
  SUMMARY_SECTIONS,
} from "../building/records";
import { type ResolvedBuilding, resolveAddress, resolveBuilding } from "../building/resolve";
import type { SocrataDeps } from "../building/socrata";
import { type Cache, cached, hashKey, TTL } from "../cache";
import type { Config } from "../env";
import { AppError } from "../errors";
import { type Area, areasNear, nearestArea, resolveArea, searchAreas } from "../geo/areas";
import { metersBetween, type Point, radiusForMinutes, walkMinutes } from "../geo/distance";
import { geosearch, LANDMARKS } from "../geo/geosearch";
import { findStations, resolveStation, stationsNear } from "../geo/stations";
import { AMENITIES, type AmenityToken, resolveAmenity } from "../streeteasy/amenities";
import type { StreetEasyClient } from "../streeteasy/client";
import { type ListingSummary, normalizeDetails, normalizeEdge } from "../streeteasy/normalize";
import type { SearchFilters, SearchRentalsResponse, Sorting } from "../streeteasy/types";
import type { FetchLike } from "../upstream/providers";
import type { Budget } from "../upstream/upstream";

export interface ServiceDeps {
  config: Config;
  /** Built lazily: tools that never touch StreetEasy work without provider secrets. */
  streeteasy: () => StreetEasyClient;
  budget: Budget;
  fetch: FetchLike;
  cache: Cache;
}

export const SORTS = [
  "distance",
  "recommended",
  "newest",
  "price_low",
  "price_high",
  "largest",
] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchArgs {
  neighborhoods?: string[];
  near_station?: string;
  line?: string;
  near_place?: string;
  near_point?: Point;
  radius_minutes?: number;
  min_price?: number;
  max_price?: number;
  min_beds?: number;
  max_beds?: number;
  min_baths?: number;
  amenities?: string[];
  nice_to_have?: string[];
  pets_allowed?: boolean;
  available_by?: string;
  no_fee_only?: boolean;
  include_sponsored?: boolean;
  sort?: Sort;
  limit?: number;
  cursor?: string;
  building_flags?: boolean;
}

export interface Where {
  mode: "neighborhoods" | "station" | "place" | "point";
  label: string;
  point?: Point;
  radius_m?: number;
  walk_minutes?: number;
  /** For big places (parks): distances are measured from this far out from the center. */
  edge_m?: number;
  areas: Area[];
  station?: { name: string; routes: string[] };
}

const MAX_RADIUS_MIN = 30;
const LOCATION_PAGE_SIZE = 50;
const MAX_AREAS = 8;

export class StoopService {
  constructor(private readonly deps: ServiceDeps) {}

  private get socrata(): SocrataDeps {
    return {
      fetch: this.deps.fetch,
      cache: this.deps.cache,
      appToken: this.deps.config.socrataAppToken,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Search                                                                    */
  /* ------------------------------------------------------------------------ */

  async searchRentals(args: SearchArgs) {
    const where = await this.resolveWhere(args);
    const limit = clamp(args.limit ?? 15, 1, 25);
    const sort: Sort = args.sort ?? (where.point ? "distance" : "recommended");
    if (sort === "distance" && !where.point) {
      throw new AppError(
        "BAD_REQUEST",
        "sort=distance needs a location.",
        "Use near_station, near_place or near_point, or pick another sort.",
      );
    }
    const filters = this.buildFilters(
      args,
      where.areas.map((a) => a.code),
    );
    const sorting = upstreamSort(sort);
    const flagsWanted = args.building_flags ?? true;
    const needsScan = Boolean(where.point || args.no_fee_only);
    const perPage = needsScan ? LOCATION_PAGE_SIZE : limit;

    const cursor = decodeCursor(args.cursor);
    let page = cursor.p;
    let offset = cursor.o;
    let pagesRead = 0;
    let scanned = 0;
    let total = 0;
    let next: Cursor | null = null;
    const results: { listing: ListingSummary; building?: ResolvedBuilding }[] = [];

    scan: while (pagesRead < this.deps.config.maxPagesPerSearch) {
      const res = await this.searchPage(filters, sorting, page, perPage);
      pagesRead++;
      total = res.searchRentals.totalCount;
      const edges = res.searchRentals.edges.filter((e) => e?.node);

      const candidates: { idx: number; listing: ListingSummary; building?: ResolvedBuilding }[] =
        [];
      for (let i = offset; i < edges.length; i++) {
        scanned++;
        const listing = normalizeEdge(edges[i] as (typeof edges)[number]);
        if (listing.sponsored && !args.include_sponsored) continue;
        if (args.no_fee_only && !listing.no_fee) continue;
        if (where.point) {
          if (listing.lat === null || listing.lng === null) continue;
          const d = Math.max(
            0,
            metersBetween(where.point, { lat: listing.lat, lng: listing.lng }) -
              (where.edge_m ?? 0),
          );
          if (d > (where.radius_m ?? 0)) continue;
          listing.distance_m = Math.round(d);
          listing.walk_min = walkMinutes(d);
        }
        candidates.push({ idx: i, listing });
      }

      if (flagsWanted) {
        // Only the listings this call will return need their building looked up.
        const batch = candidates.slice(0, Math.max(0, limit - results.length));
        await Promise.all(
          batch.map(async (c) => {
            c.building = await this.listingBuilding(c.listing);
          }),
        );
      }

      for (const c of candidates) {
        results.push({ listing: c.listing, ...(c.building ? { building: c.building } : {}) });
        if (results.length >= limit) {
          next =
            c.idx + 1 < edges.length
              ? { p: page, o: c.idx + 1 }
              : page * perPage < total
                ? { p: page + 1, o: 0 }
                : null;
          break scan;
        }
      }

      offset = 0;
      if (edges.length === 0 || page * perPage >= total) {
        next = null;
        break;
      }
      page++;
      next = { p: page, o: 0 };
    }

    if (flagsWanted) await this.attachFlags(results);
    const listings = results.map((r) => r.listing);
    if (sort === "distance") listings.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));

    const notes: string[] = [];
    if (where.point && next) {
      notes.push(
        `Scanned ${scanned} of ${total} listings in the ${where.areas.length} nearby neighborhood(s); pass next_cursor to scan more. Results are sorted by distance within what was scanned.`,
      );
    }
    if (!listings.length && !next)
      notes.push(
        "Nothing matched. Try a bigger radius, fewer required amenities, or a wider price range.",
      );

    return {
      where: describeWhere(where),
      total_in_neighborhoods: total,
      scanned,
      returned: listings.length,
      results: listings,
      next_cursor: next ? encodeCursor(next) : null,
      upstream_requests_used: pagesRead,
      notes,
    };
  }

  private async searchPage(
    filters: SearchFilters,
    sorting: Sorting,
    page: number,
    perPage: number,
  ): Promise<SearchRentalsResponse> {
    const key = `se:search:${hashKey({ filters, sorting, page, perPage })}`;
    return cached(this.deps.cache, key, TTL.searchPage, () =>
      this.deps.streeteasy().searchRentals({ filters, sorting, page, perPage }),
    );
  }

  private buildFilters(args: SearchArgs, areas: number[]): SearchFilters {
    const filters: SearchFilters = { areas, rentalStatus: "ACTIVE" };
    if (args.min_price !== undefined || args.max_price !== undefined) {
      filters.price = { lowerBound: args.min_price ?? null, upperBound: args.max_price ?? null };
    }
    if (args.min_beds !== undefined || args.max_beds !== undefined) {
      filters.bedrooms = { lowerBound: args.min_beds ?? null, upperBound: args.max_beds ?? null };
    }
    if (args.min_baths !== undefined)
      filters.bathrooms = { lowerBound: args.min_baths, upperBound: null };
    if (args.amenities?.length) filters.amenities = args.amenities.map(amenityOrThrow);
    if (args.nice_to_have?.length)
      filters.optionalAmenities = args.nice_to_have.map(amenityOrThrow);
    if (args.pets_allowed !== undefined) filters.petsAllowed = args.pets_allowed;
    if (args.available_by) filters.available = { startDate: null, endDate: args.available_by };
    return filters;
  }

  async resolveWhere(args: SearchArgs): Promise<Where> {
    const modes = [
      args.neighborhoods?.length ? "neighborhoods" : null,
      args.near_station ? "station" : null,
      args.near_place ? "place" : null,
      args.near_point ? "point" : null,
    ].filter(Boolean);
    if (modes.length !== 1) {
      throw new AppError(
        "BAD_REQUEST",
        modes.length
          ? `Give one kind of location, not ${modes.join(" + ")}.`
          : "Say where to search.",
        "Pass exactly one of neighborhoods, near_station, near_place or near_point.",
      );
    }

    if (args.neighborhoods?.length) {
      const areas = [
        ...new Map(args.neighborhoods.map((n) => resolveArea(n)).map((a) => [a.code, a])).values(),
      ];
      return { mode: "neighborhoods", label: areas.map((a) => a.name).join(", "), areas };
    }

    const minutes = clamp(args.radius_minutes ?? 10, 1, MAX_RADIUS_MIN);
    const radius_m = Math.round(radiusForMinutes(minutes));
    let point: Point;
    let label: string;
    let station: Where["station"];
    let mode: Where["mode"];
    let edge_m = 0;

    if (args.near_station) {
      const s = resolveStation(args.near_station, args.line);
      point = { lat: s.lat, lng: s.lng };
      label = `${s.name} (${s.routes.join(" ")})`;
      station = { name: s.name, routes: s.routes };
      mode = "station";
    } else if (args.near_place) {
      const resolved = await this.resolvePlace(args.near_place);
      point = resolved.point;
      label = resolved.label;
      edge_m = resolved.edge_m ?? 0;
      mode = "place";
    } else {
      point = args.near_point as Point;
      label = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
      mode = "point";
    }

    let areas = areasNear(point, radius_m + edge_m, MAX_AREAS).map((c) => c.area);
    if (!areas.length) {
      const nearest = nearestArea(point);
      if (!nearest) {
        throw new AppError(
          "PLACE_NOT_FOUND",
          `"${label}" isn't near any NYC neighborhood StreetEasy covers.`,
        );
      }
      areas = [nearest];
    }
    return {
      mode,
      label,
      point,
      radius_m,
      walk_minutes: minutes,
      ...(edge_m ? { edge_m } : {}),
      areas,
      ...(station ? { station } : {}),
    };
  }

  private async resolvePlace(
    text: string,
  ): Promise<{ point: Point; label: string; edge_m?: number }> {
    const key = text
      .trim()
      .toLowerCase()
      .replace(/^the\s+/, "");
    const landmark = LANDMARKS[key];
    if (landmark) {
      return {
        point: { lat: landmark.lat, lng: landmark.lng },
        label: landmark.label,
        edge_m: landmark.edge_m ?? 0,
      };
    }

    const station = findStations(text, undefined, 1)[0];
    if (station && station.score >= 100) {
      return { point: { lat: station.lat, lng: station.lng }, label: `${station.name} station` };
    }

    const results = await geosearch(text, { fetch: this.deps.fetch, cache: this.deps.cache });
    const best = results[0];
    if (!best) {
      throw new AppError(
        "PLACE_NOT_FOUND",
        `Couldn't find "${text}" in NYC.`,
        "Try a street address, an intersection like 'Bedford Ave & N 7th St', a station with near_station, or near_point with coordinates.",
      );
    }
    return { point: { lat: best.lat, lng: best.lng }, label: best.label };
  }

  private async listingBuilding(l: ListingSummary): Promise<ResolvedBuilding> {
    try {
      return await resolveBuilding(
        {
          street: l.street,
          borough: l.borough,
          point: l.lat !== null && l.lng !== null ? { lat: l.lat, lng: l.lng } : null,
        },
        { fetch: this.deps.fetch, cache: this.deps.cache },
      );
    } catch (err) {
      return {
        matched: false,
        address: l.street,
        reason: `City geocoder unavailable: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  private async attachFlags(
    results: { listing: ListingSummary; building?: ResolvedBuilding }[],
  ): Promise<void> {
    const bbls = results.flatMap((r) => (r.building?.matched ? [r.building.bbl] : []));
    let flags = new Map<string, BuildingFlags>();
    try {
      flags = await flagsFor(bbls, this.socrata);
    } catch {
      // Individual datasets already degrade to null; this only guards the unexpected.
    }
    for (const r of results) {
      if (!r.building) continue;
      if (!r.building.matched) {
        r.listing.building = { matched: false, reason: r.building.reason };
        continue;
      }
      const f = flags.get(r.building.bbl);
      r.listing.building = f ? { matched: true, ...f } : { matched: true, bbl: r.building.bbl };
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Listing details                                                           */
  /* ------------------------------------------------------------------------ */

  async getListing(id: string, opts: { building_records?: boolean } = {}) {
    const details = await this.listingDetails(id);
    const url = `https://streeteasy.com/rental/${details.id}`;
    const out: Record<string, unknown> = { url, ...details };
    if (!details.street) return out;

    const building = await this.detailsBuilding(details);
    if (building.matched) {
      out.nearby_stations = stationsNear({ lat: building.lat, lng: building.lng }, 4);
    }
    if (opts.building_records ?? true) {
      out.building_records = await buildingReport(building, this.socrata, {
        depth: "summary",
        sections: SUMMARY_SECTIONS,
      });
    }
    return out;
  }

  private listingDetails(id: string) {
    const clean = id
      .trim()
      .replace(/^.*\/rental\//, "")
      .replace(/[^0-9]/g, "");
    if (!clean)
      throw new AppError(
        "BAD_REQUEST",
        `"${id}" isn't a listing id.`,
        "Pass the id from search_rentals, or a streeteasy.com/rental/<id> URL.",
      );
    return cached(this.deps.cache, `se:listing:${clean}`, TTL.listing, async () =>
      normalizeDetails(await this.deps.streeteasy().listingDetails(clean)),
    );
  }

  private async detailsBuilding(
    d: Awaited<ReturnType<StoopService["listingDetails"]>>,
  ): Promise<ResolvedBuilding> {
    try {
      return await resolveBuilding(
        { street: d.street ?? "", zip: d.zip, borough: null, point: null },
        { fetch: this.deps.fetch, cache: this.deps.cache },
      );
    } catch (err) {
      return {
        matched: false,
        address: d.street ?? "",
        reason: `City geocoder unavailable: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Building report                                                           */
  /* ------------------------------------------------------------------------ */

  async checkBuilding(args: {
    listing_id?: string;
    address?: string;
    sections?: ReportSection[];
    years?: number;
  }) {
    if (Boolean(args.listing_id) === Boolean(args.address)) {
      throw new AppError(
        "BAD_REQUEST",
        "Pass either listing_id or address.",
        "Use a listing id from search_rentals, or a street address like '123 Bedford Ave, Brooklyn'.",
      );
    }
    let building: ResolvedBuilding;
    if (args.listing_id) {
      building = await this.detailsBuilding(await this.listingDetails(args.listing_id));
    } else {
      try {
        building = await resolveAddress(args.address as string, {
          fetch: this.deps.fetch,
          cache: this.deps.cache,
        });
      } catch (err) {
        throw new AppError(
          "UPSTREAM_ERROR",
          `NYC Geosearch failed: ${err instanceof Error ? err.message : err}`,
          "Retry shortly.",
        );
      }
    }
    const report = await buildingReport(building, this.socrata, {
      depth: "full",
      ...(args.sections?.length ? { sections: args.sections } : {}),
      years: clamp(args.years ?? 3, 1, 10),
    });
    if (building.matched) {
      return {
        ...report,
        nearby_stations: stationsNear({ lat: building.lat, lng: building.lng }, 4),
      };
    }
    return report;
  }

  /* ------------------------------------------------------------------------ */
  /* Lookups                                                                   */
  /* ------------------------------------------------------------------------ */

  findStation(query: string, line?: string) {
    const matches = findStations(query, line, 6);
    return {
      matches: matches.map((s) => ({
        name: s.name,
        routes: s.routes,
        lat: s.lat,
        lng: s.lng,
        neighborhood: nearestArea(s)?.name ?? null,
        match: s.score >= 80 ? "strong" : "partial",
      })),
      ...(matches.length
        ? {}
        : { hint: "No match. Try just the street or place name, e.g. 'Bedford' or 'Atlantic'." }),
    };
  }

  listNeighborhoods(args: { query?: string; borough?: string }) {
    const areas = searchAreas(args.query, args.borough);
    return {
      count: areas.length,
      neighborhoods: areas.map((a) => ({
        name: a.name,
        code: a.code,
        borough: a.borough,
        kind: a.kind,
      })),
    };
  }

  listAmenities() {
    return {
      amenities: Object.entries(AMENITIES).map(([token, v]) => ({
        token,
        label: v.label,
        group: v.group,
      })),
      note: "Pass tokens in `amenities` (required) or `nice_to_have` (ranked, reported as matched/missing).",
    };
  }

  async status() {
    const budget = await this.deps.budget.status();
    return {
      provider: this.deps.config.provider,
      upstream_requests_today: budget,
      max_pages_per_search: this.deps.config.maxPagesPerSearch,
    };
  }
}

/* -------------------------------------------------------------------------- */

interface Cursor {
  p: number;
  o: number;
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c));
}

function decodeCursor(s: string | undefined): Cursor {
  if (!s) return { p: 1, o: 0 };
  try {
    const c = JSON.parse(atob(s)) as Cursor;
    if (Number.isInteger(c.p) && c.p >= 1 && Number.isInteger(c.o) && c.o >= 0) return c;
  } catch {
    // fall through
  }
  throw new AppError(
    "BAD_REQUEST",
    "That cursor isn't valid.",
    "Pass next_cursor exactly as a previous search returned it, with the same search arguments.",
  );
}

function upstreamSort(sort: Sort): Sorting {
  switch (sort) {
    case "newest":
      return { attribute: "LISTED_AT", direction: "DESCENDING" };
    case "price_low":
      return { attribute: "PRICE", direction: "ASCENDING" };
    case "price_high":
      return { attribute: "PRICE", direction: "DESCENDING" };
    case "largest":
      return { attribute: "SQFT", direction: "DESCENDING" };
    default:
      return { attribute: "RECOMMENDED", direction: "DESCENDING" };
  }
}

function amenityOrThrow(input: string): AmenityToken {
  const token = resolveAmenity(input);
  if (!token) {
    throw new AppError(
      "BAD_REQUEST",
      `Unknown amenity "${input}".`,
      "Call list_amenities for the valid tokens.",
    );
  }
  return token;
}

function describeWhere(w: Where) {
  return {
    mode: w.mode,
    label: w.label,
    ...(w.point ? { lat: w.point.lat, lng: w.point.lng } : {}),
    ...(w.radius_m ? { radius_m: w.radius_m, walk_minutes: w.walk_minutes } : {}),
    ...(w.edge_m ? { measured_from: `the edge of ${w.label} (approximate)` } : {}),
    ...(w.station ? { station: w.station } : {}),
    neighborhoods_searched: w.areas.map((a) => a.name),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
