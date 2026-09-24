import { describe, expect, it } from "vitest";
import { buildingReport, heatSeasons } from "../src/building/records";
import { recordLinks, resolveBuilding, splitBbl } from "../src/building/resolve";
import { idClause, queryById } from "../src/building/socrata";
import { fakeFetch, geosearchRoute, memoryCache, type Route } from "./helpers/fakes";

describe("socrata", () => {
  it("renders id filters in both literal styles", () => {
    expect(idClause("bbl", ["1"], "text")).toBe("bbl = '1'");
    expect(idClause("bbl", ["1", "2"], "number")).toBe("bbl IN (1, 2)");
  });

  it("retries unquoted when the column is numeric", async () => {
    const wheres: string[] = [];
    const f = fakeFetch([
      {
        match: /data\.cityofnewyork\.us/,
        respond: (url) => {
          const where = url.searchParams.get("$where") ?? "";
          wheres.push(where);
          return where.includes("'")
            ? Response.json(
                { message: "Type mismatch for #EQ, is number, but 'text'" },
                { status: 400 },
              )
            : Response.json([{ ok: "1" }]);
        },
      },
    ]);
    const rows = await queryById(
      { fetch: f, cache: memoryCache() },
      "pluto",
      "bbl",
      ["1000780047"],
      (id) => ({
        $where: id,
      }),
    );
    expect(rows).toEqual([{ ok: "1" }]);
    expect(wheres).toEqual(["bbl = '1000780047'", "bbl = 1000780047"]);
  });
});

describe("resolveBuilding", () => {
  const deps = () => ({ fetch: fakeFetch([geosearchRoute()]), cache: memoryCache() });

  it("accepts a geocoder match near the listing", async () => {
    const b = await resolveBuilding(
      { street: "150 N 6th St", borough: "Brooklyn", point: { lat: 40.7181, lng: -73.9579 } },
      deps(),
    );
    expect(b).toMatchObject({ matched: true, bbl: "3023370001", bin: "3062001" });
  });

  it("refuses a match far from the listing", async () => {
    const b = await resolveBuilding(
      { street: "150 N 6th St", borough: "Brooklyn", point: { lat: 40.75, lng: -73.99 } },
      deps(),
    );
    expect(b).toMatchObject({ matched: false });
  });

  it("builds record links", () => {
    expect(splitBbl("3023370001")).toMatchObject({ boroCode: "BK", block: 2337, lot: 1 });
    expect(recordLinks("3023370001", "3062001").dob_bis).toContain("bin=3062001");
  });
});

describe("buildingReport", () => {
  const building = {
    matched: true as const,
    bbl: "1000780047",
    bin: "1001234",
    address: "1 TEST ST, Manhattan",
    borough: "Manhattan",
    zip: "10004",
    lat: 40.705,
    lng: -74.01,
  };

  const routes: Route[] = [
    {
      match: /data\.cityofnewyork\.us\/resource\/wvxf-dwi5/,
      respond: (url) =>
        Response.json(
          url.searchParams.get("$select")?.startsWith("class")
            ? [
                { class: "C", violationstatus: "Open", n: "2" },
                { class: "B", violationstatus: "Close", n: "5" },
              ]
            : [
                {
                  inspectiondate: "2026-05-01T00:00:00.000",
                  class: "C",
                  novdescription: "NO HEAT",
                  buildingid: "42",
                },
              ],
        ),
    },
    {
      match: /erm2-nwe9/,
      respond: (url) => {
        const sel = url.searchParams.get("$select") ?? "";
        if (sel.startsWith("complaint_type"))
          return Response.json([
            { complaint_type: "HEAT/HOT WATER", n: "7" },
            { complaint_type: "NOISE - RESIDENTIAL", n: "3" },
          ]);
        if (sel.startsWith("date_trunc"))
          return Response.json([
            { month: "2025-01-01T00:00:00.000", n: "4" },
            { month: "2025-11-01T00:00:00.000", n: "2" },
          ]);
        return Response.json([]);
      },
    },
    { match: /wz6d-d3jb/, respond: () => Response.json([]) },
    {
      match: /6z8x-wfk4/,
      respond: () =>
        Response.json([
          { executed_date: "2025-03-01T00:00:00.000", residential_commercial_ind: "Residential" },
        ]),
    },
    {
      match: /3h2n-5cm9/,
      respond: () =>
        Response.json([{ issue_date: "20250102", violation_type: "ELEVATOR", description: "x" }]),
    },
    { match: /rbx6-tga4/, respond: () => new Response("{}", { status: 400 }) },
    {
      match: /64uk-42ks/,
      respond: () =>
        Response.json([
          { address: "1 TEST ST", yearbuilt: "1920", unitsres: "500", numfloors: "20" },
        ]),
    },
    {
      match: /tesw-yqqr/,
      respond: () =>
        Response.json([{ registrationid: "77", lastregistrationdate: "2025-09-01T00:00:00.000" }]),
    },
    {
      match: /feu5-w2e2/,
      respond: () =>
        Response.json([
          { type: "CorporateOwner", corporationname: "TEST OWNER LLC" },
          { type: "Agent", firstname: "Pat", lastname: "Manager" },
        ]),
    },
    {
      match: /hazards\.fema\.gov/,
      respond: () =>
        Response.json({ features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }] }),
    },
  ];

  it("builds every section, with failures reported as unavailable", async () => {
    const r = await buildingReport(
      building,
      { fetch: fakeFetch(routes), cache: memoryCache() },
      { depth: "full" },
    );
    const s = r.sections as Record<string, { status: string; data?: Record<string, unknown> }>;
    expect(s.hpd_violations?.data).toMatchObject({
      open: 2,
      total: 7,
      hpd_online: "https://hpdonline.nyc.gov/hpdonline/building/42",
    });
    expect(s.complaints_311?.data).toMatchObject({ heat_hot_water_12mo: 7, total_12mo: 10 });
    expect(s.complaints_311?.data?.heat_by_season).toEqual([
      { season: "2025-26", complaints: 2 },
      { season: "2024-25", complaints: 4 },
    ]);
    expect(s.evictions?.data).toMatchObject({ residential_evictions: 1 });
    expect(s.dob_violations?.data).toMatchObject({ active: 1 });
    expect(s.permits?.status).toBe("unavailable");
    expect(s.owner?.data).toMatchObject({
      owners: ["TEST OWNER LLC"],
      managing_agents: ["Pat Manager"],
    });
    expect(s.overview?.data).toMatchObject({ year_built: 1920, residential_units: 500 });
    expect(s.flood_zone?.data).toMatchObject({ zone: "AE", high_risk: true });
  });

  it("says plainly when the building couldn't be identified", async () => {
    const r = await buildingReport(
      { matched: false, address: "nowhere", reason: "no lot" },
      { fetch: fakeFetch([]), cache: memoryCache() },
      { depth: "full" },
    );
    expect(r.matched).toBe(false);
    expect(r.notes[0]).toMatch(/not a clean record/);
  });

  it("groups heat complaints into Oct–May seasons", () => {
    expect(heatSeasons([{ month: "2024-07-01T00:00:00.000", n: "9" }])).toEqual([]);
  });
});
