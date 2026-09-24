import { describe, expect, it } from "vitest";
import { areasNear, resolveArea } from "../src/geo/areas";
import { metersBetween, radiusForMinutes, walkMinutes } from "../src/geo/distance";
import { findStations, resolveStation, stationsNear } from "../src/geo/stations";
import { BEDFORD } from "./helpers/fakes";

describe("stations", () => {
  it("finds a station by plain name", () => {
    const [top] = findStations("Bedford Av");
    expect(top?.name).toBe("Bedford Av");
    expect(top?.routes).toEqual(["L"]);
  });

  it("reads the line out of 'the Bedford L'", () => {
    const s = resolveStation("the Bedford L");
    expect(s.name).toBe("Bedford Av");
  });

  it("uses an explicit line to pick between same-named stations", () => {
    const g = resolveStation("Fulton St", "G");
    expect(g.routes).toEqual(["G"]);
    const a = resolveStation("Fulton St", "A");
    expect(a.routes).toContain("A");
    expect(a.id).not.toBe(g.id);
  });

  it("knows common nicknames", () => {
    expect(resolveStation("Atlantic Terminal").name).toBe("Atlantic Av-Barclays Ctr");
    expect(resolveStation("Union Square").name).toBe("14 St-Union Sq");
    expect(resolveStation("Times Square").routes).toContain("7");
  });

  it("normalizes street words", () => {
    expect(resolveStation("Bedford Avenue").name).toBe("Bedford Av");
    expect(resolveStation("14th Street Union Square").name).toBe("14 St-Union Sq");
  });

  it("fails with suggestions for nonsense", () => {
    expect(() => resolveStation("Qwertyuiop")).toThrowError(/No subway station/);
  });

  it("lists nearby stations with walking time", () => {
    const near = stationsNear(BEDFORD, 3);
    expect(near[0]?.name).toBe("Bedford Av");
    expect(near[0]?.walk_min).toBe(1);
  });
});

describe("areas", () => {
  it("resolves names, nicknames and codes", () => {
    expect(resolveArea("Williamsburg").code).toBe(302);
    expect(resolveArea("UWS").key).toBe("UPPER_WEST_SIDE");
    expect(resolveArea("bed-stuy").key).toBe("BEDFORD_STUYVESANT");
    expect(resolveArea(302).name).toBe("Williamsburg");
  });

  it("suggests close names when unknown", () => {
    expect(() => resolveArea("Williamsbrg")).toThrowError(/Unknown neighborhood/);
  });

  it("picks the neighborhoods around a point", () => {
    const names = areasNear(BEDFORD, radiusForMinutes(10)).map((c) => c.area.name);
    expect(names).toContain("Williamsburg");
    expect(names.length).toBeLessThanOrEqual(8);
    expect(names).not.toContain("Upper West Side");
  });
});

describe("distance", () => {
  it("measures and converts", () => {
    const d = metersBetween(BEDFORD, { lat: 40.7141, lng: -73.9555 });
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(400);
    expect(walkMinutes(d)).toBe(6);
    expect(Math.round(radiusForMinutes(10))).toBe(615);
  });
});
