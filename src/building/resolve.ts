/**
 * Turning a listing (or any address) into the city's building ids.
 *
 * Geosearch gives the tax lot (BBL) and building (BIN). A match is only trusted
 * when it lands within MATCH_RADIUS_M of the listing's own coordinates, so a
 * mistyped or ambiguous address never attaches another building's record.
 * "Couldn't match" is reported as such, never as a clean record.
 */

import { type Cache, cached, TTL } from "../cache";
import { metersBetween, type Point } from "../geo/distance";
import { geosearch } from "../geo/geosearch";
import type { FetchLike } from "../upstream/providers";

export const MATCH_RADIUS_M = 150;

export type ResolvedBuilding =
  | {
      matched: true;
      bbl: string;
      bin: string | null;
      address: string;
      borough: string | null;
      zip: string | null;
      lat: number;
      lng: number;
    }
  | { matched: false; address: string; reason: string };

export interface ResolveInput {
  street: string;
  borough?: string | null;
  zip?: string | null;
  /** The listing's coordinates; when present the match must be near them. */
  point?: Point | null;
}

export async function resolveBuilding(
  input: ResolveInput,
  deps: { fetch: FetchLike; cache: Cache },
): Promise<ResolvedBuilding> {
  const street = input.street
    .replace(/\s+#.*$/, "")
    .replace(/\s+(apt|unit)\b.*$/i, "")
    .trim();
  const where = input.zip || input.borough || "New York";
  const text = `${street}, ${where}`;
  const key = `bldg:${text.toLowerCase()}|${input.point ? `${input.point.lat.toFixed(4)},${input.point.lng.toFixed(4)}` : ""}`;

  return cached(deps.cache, key, TTL.buildingId, async () => {
    // A Geosearch failure throws out of `cached`, so an outage is never cached.
    const results = await geosearch(text, deps, input.point ? { focus: input.point } : {});
    const withIds = results.filter((r) => r.bbl);
    const pick = input.point
      ? withIds.find((r) => metersBetween(r, input.point as Point) <= MATCH_RADIUS_M)
      : withIds[0];
    if (!pick?.bbl) {
      return {
        matched: false as const,
        address: text,
        reason: withIds.length
          ? `The city's geocoder placed "${text}" more than ${MATCH_RADIUS_M} m from the listing's location.`
          : `The city's geocoder found no tax lot for "${text}".`,
      };
    }
    return {
      matched: true as const,
      bbl: pick.bbl,
      bin: pick.bin,
      address: pick.label,
      borough: pick.borough,
      zip: pick.zip,
      lat: pick.lat,
      lng: pick.lng,
    };
  });
}

/** Free-text address → building (no location check; the address is all we have). */
export async function resolveAddress(
  address: string,
  deps: { fetch: FetchLike; cache: Cache },
): Promise<ResolvedBuilding> {
  return resolveBuilding({ street: address }, deps);
}

const BORO_CODE: Record<string, string> = { "1": "MN", "2": "BX", "3": "BK", "4": "QN", "5": "SI" };

/** Borough, block, lot from a 10-digit BBL. */
export function splitBbl(bbl: string): {
  boro: string;
  boroCode: string;
  block: number;
  lot: number;
} {
  return {
    boro: bbl.slice(0, 1),
    boroCode: BORO_CODE[bbl.slice(0, 1)] ?? "",
    block: Number(bbl.slice(1, 6)),
    lot: Number(bbl.slice(6, 10)),
  };
}

/** Official and public pages for a building, for people to check the record themselves. */
export function recordLinks(bbl: string, bin: string | null): Record<string, string> {
  const { boro, block, lot } = splitBbl(bbl);
  const links: Record<string, string> = {
    zola: `https://zola.planning.nyc.gov/l/lot/${boro}/${block}/${lot}`,
    who_owns_what: `https://whoownswhat.justfix.org/bbl/${bbl}`,
  };
  if (bin)
    links.dob_bis = `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${bin}`;
  return links;
}
