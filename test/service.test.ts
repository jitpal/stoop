import { describe, expect, it } from "vitest";
import { StoopService } from "../src/core/service";
import { parseConfig } from "../src/env";
import { StreetEasyClient } from "../src/streeteasy/client";
import { zyteProvider } from "../src/upstream/providers";
import { createUpstream } from "../src/upstream/upstream";
import {
  BEDFORD,
  fakeFetch,
  geosearchRoute,
  LISTINGS,
  memoryBudget,
  memoryCache,
  type Route,
  searchResponse,
  socrataRoute,
  unb64,
  zyteRoute,
} from "./helpers/fakes";

function service(routes: Route[], env: Record<string, string> = {}) {
  const f = fakeFetch(routes);
  const budget = memoryBudget();
  const config = parseConfig({
    UPSTREAM_PROVIDER: "zyte",
    MAX_PAGES_PER_SEARCH: "3",
    ...env,
  } as never);
  const svc = new StoopService({
    config,
    budget,
    fetch: f,
    cache: memoryCache(),
    streeteasy: () => new StreetEasyClient(createUpstream(zyteProvider("K", f), budget, 0)),
  });
  return { svc, f, budget };
}

const records = socrataRoute({
  "wvxf-dwi5": () => [{ bbl: "3023370001", n: "2" }],
  "erm2-nwe9": () => [{ bbl: "3023670010", n: "5" }],
  "wz6d-d3jb": () => [
    {
      bbl: "3023370001",
      infested_dwelling_unit_count: "0",
      filing_date: "2026-01-01T00:00:00.000",
    },
  ],
});

describe("searchRentals near a station", () => {
  it("keeps listings inside the walking radius, nearest first, without ads", async () => {
    const queries: string[] = [];
    const { svc, budget } = service([
      zyteRoute(
        () => searchResponse(),
        (p) => queries.push(JSON.parse(unb64(p.httpRequestBody as string)).query),
      ),
      geosearchRoute(),
      records,
    ]);
    const r = await svc.searchRentals({
      near_station: "Bedford Av",
      radius_minutes: 10,
      max_price: 5000,
    });

    expect(r.where.mode).toBe("station");
    expect(r.where.neighborhoods_searched).toContain("Williamsburg");
    expect(r.results.map((l) => l.id)).toEqual(["1001", "1002"]);
    expect(r.results[0]?.distance_m).toBeLessThan(150);
    expect(r.results[0]?.walk_min).toBe(2);
    expect(r.results[1]?.walk_min).toBe(6);
    expect(budget.used).toBe(1);
    expect(r.next_cursor).toBeNull();

    // One request covering every nearby area, enums inline, price range passed through.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/areas: \[302(, \d+)+\]/);
    expect(queries[0]).toContain("rentalStatus: ACTIVE");
    expect(queries[0]).toContain("price: { lowerBound: null, upperBound: 5000 }");
    expect(queries[0]).toContain("perPage: 50");
  });

  it("attaches building flags from public records", async () => {
    const { svc } = service([zyteRoute(() => searchResponse()), geosearchRoute(), records]);
    const r = await svc.searchRentals({ near_station: "Bedford Av" });
    expect(r.results[0]?.building).toEqual({
      matched: true,
      bbl: "3023370001",
      open_class_c_violations: 2,
      heat_complaints_12mo: 0,
      bedbugs_reported_3y: false,
    });
    expect(r.results[1]?.building).toMatchObject({
      bbl: "3023670010",
      heat_complaints_12mo: 5,
      open_class_c_violations: 0,
    });
  });

  it("reports an unreachable dataset as null, not zero", async () => {
    const broken: Route = {
      match: /data\.cityofnewyork\.us/,
      respond: () => new Response("down", { status: 503 }),
    };
    const { svc } = service([zyteRoute(() => searchResponse()), geosearchRoute(), broken]);
    const r = await svc.searchRentals({ near_station: "Bedford Av" });
    expect(r.results[0]?.building).toMatchObject({
      open_class_c_violations: null,
      heat_complaints_12mo: null,
    });
  });

  it("serves a repeat search from cache", async () => {
    const { svc, budget } = service([zyteRoute(() => searchResponse()), geosearchRoute(), records]);
    await svc.searchRentals({ near_station: "Bedford Av", building_flags: false });
    await svc.searchRentals({ near_station: "Bedford Av", building_flags: false });
    expect(budget.used).toBe(1);
  });

  it("pages with a cursor when there is more than the limit", async () => {
    const { svc } = service([zyteRoute(() => searchResponse()), geosearchRoute(), records]);
    const first = await svc.searchRentals({
      near_station: "Bedford Av",
      limit: 1,
      building_flags: false,
    });
    expect(first.results.map((l) => l.id)).toEqual(["1002"]);
    expect(first.next_cursor).not.toBeNull();
    const second = await svc.searchRentals({
      near_station: "Bedford Av",
      limit: 1,
      building_flags: false,
      cursor: first.next_cursor as string,
    });
    expect(second.results.map((l) => l.id)).toEqual(["1001"]);
  });
});

describe("searchRentals by neighborhood", () => {
  it("passes filters through and doesn't compute distance", async () => {
    let query = "";
    const { svc } = service([
      zyteRoute(
        () => searchResponse([LISTINGS.near], 1),
        (p) => {
          query = JSON.parse(unb64(p.httpRequestBody as string)).query;
        },
      ),
      geosearchRoute(),
      records,
    ]);
    const r = await svc.searchRentals({
      neighborhoods: ["Williamsburg", "Greenpoint"],
      min_beds: 2,
      amenities: ["washer dryer", "DISHWASHER"],
      pets_allowed: true,
      sort: "newest",
      limit: 5,
    });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.distance_m).toBeUndefined();
    expect(query).toContain("areas: [302, 301]");
    expect(query).toContain("amenities: [WASHER_DRYER, DISHWASHER]");
    expect(query).toContain("petsAllowed: true");
    expect(query).toContain("attribute: LISTED_AT");
    expect(query).toContain("perPage: 5");
  });

  it("rejects unknown amenities and missing locations with hints", async () => {
    const { svc } = service([]);
    await expect(
      svc.searchRentals({ neighborhoods: ["Williamsburg"], amenities: ["moat"] }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(svc.searchRentals({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      svc.searchRentals({ neighborhoods: ["Williamsburg"], near_station: "Bedford Av" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("near_place", () => {
  it("geocodes an address and searches around it", async () => {
    const { svc } = service([zyteRoute(() => searchResponse()), geosearchRoute(), records]);
    const r = await svc.searchRentals({
      near_place: "150 N 6th St, Brooklyn",
      radius_minutes: 3,
      building_flags: false,
    });
    expect(r.where.mode).toBe("place");
    expect(r.results.map((l) => l.id)).toEqual(["1001"]);
  });

  it("uses the landmark table for parks", async () => {
    const { svc } = service([zyteRoute(() => searchResponse()), geosearchRoute(), records]);
    const where = await svc.resolveWhere({ near_place: "McCarren Park" });
    expect(where.label).toBe("McCarren Park");
    const park = await svc.resolveWhere({ near_place: "Prospect Park" });
    expect(park.edge_m).toBe(900);
    expect(park.areas.map((a) => a.name)).toContain("Park Slope");
    expect(where.areas.map((a) => a.name)).toContain("Greenpoint");
  });

  it("accepts raw coordinates", async () => {
    const { svc } = service([]);
    const where = await svc.resolveWhere({ near_point: BEDFORD, radius_minutes: 5 });
    expect(where.radius_m).toBe(308);
  });
});

describe("lookups", () => {
  it("find_station returns lines and neighborhood", () => {
    const { svc } = service([]);
    const r = svc.findStation("Bedford", "L");
    expect(r.matches[0]).toMatchObject({
      name: "Bedford Av",
      routes: ["L"],
      neighborhood: "Williamsburg",
    });
  });

  it("status reports provider and budget without touching StreetEasy", async () => {
    const { svc } = service([]);
    expect(await svc.status()).toMatchObject({
      provider: "zyte",
      upstream_requests_today: { used: 0 },
    });
  });
});
