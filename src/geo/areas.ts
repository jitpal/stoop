/**
 * StreetEasy areas: codes, names, boroughs and approximate centers
 * (src/data/areas.json, built by scripts/build-areas.mjs).
 */

import data from "../data/areas.json";
import { AppError } from "../errors";
import { metersBetween, type Point } from "./distance";

export type AreaKind = "region" | "borough" | "group" | "neighborhood";

export interface Area {
  code: number;
  key: string;
  name: string;
  borough: string | null;
  kind: AreaKind;
  lat?: number;
  lng?: number;
  radius_m?: number;
  center_source?: "polygon" | "manual";
}

export const AREAS = data.areas as Area[];
export const AREAS_BUILT_AT = data.built_at;

const byCode = new Map(AREAS.map((a) => [a.code, a]));

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bst\b\.?/g, "saint")
    .replace(/\bmt\b\.?/g, "mount")
    .replace(/[^a-z0-9]/g, "");
}

const byName = new Map<string, Area>();
for (const a of AREAS) {
  byName.set(normalizeName(a.key.replace(/_/g, " ")), a);
  if (!byName.has(normalizeName(a.name))) byName.set(normalizeName(a.name), a);
}
/** Common names that aren't StreetEasy's spelling. */
const ALIASES: Record<string, string> = {
  uws: "UPPER_WEST_SIDE",
  ues: "UPPER_EAST_SIDE",
  les: "LOWER_EAST_SIDE",
  fidi: "FINANCIAL_DISTRICT",
  bedstuy: "BEDFORD_STUYVESANT",
  lic: "LONG_ISLAND_CITY",
  pls: "PROSPECT_LEFFERTS_GARDENS",
  plg: "PROSPECT_LEFFERTS_GARDENS",
  hellskitchen: "HELLS_KITCHEN",
  clinton: "HELLS_KITCHEN",
  stuytown: "STUYVESANT_TOWN_PCV",
  eastwilliamsburg: "EAST_WILLIAMSBURG",
  southwilliamsburg: "WILLIAMSBURG",
  harlem: "CENTRAL_HARLEM",
  statenisland: "STATEN_ISLAND",
  nyc: "ALL_NYC_AND_NJ",
};
for (const [alias, key] of Object.entries(ALIASES)) {
  const area = AREAS.find((a) => a.key === key);
  if (area) byName.set(alias, area);
}

export function areaByCode(code: number): Area | undefined {
  return byCode.get(code);
}

/** Resolve a name ("Williamsburg", "UWS", "bed-stuy") or numeric code. */
export function resolveArea(input: string | number): Area {
  if (typeof input === "number" || /^\d+$/.test(String(input).trim())) {
    const a = byCode.get(Number(input));
    if (a) return a;
  } else {
    const a = byName.get(normalizeName(String(input)));
    if (a) return a;
  }
  const suggestions = searchAreas(String(input))
    .slice(0, 5)
    .map((a) => a.name);
  throw new AppError(
    "AREA_NOT_FOUND",
    `Unknown neighborhood "${input}".`,
    suggestions.length
      ? `Did you mean: ${suggestions.join(", ")}? Or call list_neighborhoods.`
      : "Call list_neighborhoods to see valid names, or search near_place instead.",
  );
}

/** Loose lookup for listings' `areaName` (never throws). */
export function areaByName(name: string | null | undefined): Area | undefined {
  return name ? byName.get(normalizeName(name)) : undefined;
}

export function searchAreas(query?: string, borough?: string): Area[] {
  const q = query ? normalizeName(query) : "";
  const b = borough ? normalizeName(borough) : "";
  return AREAS.filter(
    (a) =>
      (!q || normalizeName(a.name).includes(q) || normalizeName(a.key).includes(q)) &&
      (!b || normalizeName(a.borough ?? "") === b),
  );
}

export interface AreaCandidate {
  area: Area;
  /** Distance from the point to the area's center. */
  center_m: number;
}

/**
 * Neighborhoods whose extent could overlap a circle around `point`.
 *
 * An area qualifies when (distance to its center − its radius) is within the
 * search radius plus a margin, which errs toward searching one area too many
 * rather than missing listings near a boundary. Nearest first, capped.
 */
export function areasNear(point: Point, radiusM: number, max = 8, marginM = 250): AreaCandidate[] {
  const out: AreaCandidate[] = [];
  for (const area of AREAS) {
    if (area.kind !== "neighborhood" || area.lat === undefined || area.lng === undefined) continue;
    const center_m = metersBetween(point, { lat: area.lat, lng: area.lng });
    if (center_m - (area.radius_m ?? 700) <= radiusM + marginM) out.push({ area, center_m });
  }
  return out.sort((a, b) => a.center_m - b.center_m).slice(0, max);
}

/** The neighborhood whose center is nearest the point (for labeling). */
export function nearestArea(point: Point): Area | undefined {
  return areasNear(point, 5000, 1, 5000)[0]?.area;
}
