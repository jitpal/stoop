/**
 * Test doubles: a route-table fetch, an in-memory cache and budget, and a
 * StreetEasy search fixture near the Bedford Av L station.
 */

import type { Cache } from "../../src/cache";
import type { FetchLike } from "../../src/upstream/providers";
import type { Budget } from "../../src/upstream/upstream";

export interface Route {
  match: RegExp;
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
}

export interface FakeFetch extends FetchLike {
  calls: { url: string; init?: RequestInit }[];
}

export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, ...(init ? { init } : {}) });
    const route = routes.find((r) => r.match.test(input));
    if (!route) throw new Error(`unexpected fetch: ${input}`);
    return route.respond(new URL(input), init);
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
}

export function memoryCache(): Cache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(key: string) {
      return (store.has(key) ? store.get(key) : null) as T | null;
    },
    async put(key, value) {
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

export function memoryBudget(cap: number | null = null): Budget & { used: number } {
  const b = {
    used: 0,
    async spend() {
      if (cap !== null && b.used >= cap) {
        const { AppError } = await import("../../src/errors");
        throw new AppError("BUDGET_EXCEEDED", "cap");
      }
      b.used++;
    },
    async status() {
      return { used: b.used, cap, day: "2026-09-24" };
    },
  };
  return b;
}

export function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export function unb64(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

/** Bedford Av (L) station, from the bundled GTFS data. */
export const BEDFORD = { lat: 40.717304, lng: -73.956872 };

function node(
  id: string,
  street: string,
  lat: number,
  lng: number,
  extra: Record<string, unknown> = {},
) {
  return {
    __typename: "SearchRentalListing",
    id,
    areaName: "Williamsburg",
    availableAt: "2026-10-01",
    bedroomCount: 2,
    buildingType: "RENTAL",
    fullBathroomCount: 1,
    furnished: false,
    geoPoint: { __typename: "GeoPoint", latitude: lat, longitude: lng },
    halfBathroomCount: 0,
    hasTour3d: false,
    hasVideos: false,
    isNewDevelopment: false,
    leadMedia: { __typename: "LeadMedia", photo: { __typename: "Photo", key: `photo-${id}` } },
    leaseTermMonths: 12,
    livingAreaSize: 750,
    mediaAssetCount: 8,
    monthsFree: null,
    noFee: true,
    netEffectivePrice: null,
    offMarketAt: null,
    photos: [{ __typename: "Photo", key: `photo-${id}` }],
    price: 4200,
    priceChangedAt: null,
    priceDelta: null,
    slug: street.toLowerCase().replace(/\s+/g, "-"),
    sourceGroupLabel: "Test Realty",
    sourceType: "BROKER",
    status: "ACTIVE",
    street,
    unit: "2R",
    upcomingOpenHouse: null,
    urlPath: `/building/${id}/2r`,
    ...extra,
  };
}

export const LISTINGS = {
  near: node("1001", "150 N 6th St", 40.7181, -73.9579), // ~120 m from Bedford Av
  mid: node("1002", "200 Metropolitan Ave", 40.7141, -73.9555), // ~370 m
  far: node("1003", "10 Clinton St", 40.6955, -73.9915), // ~3.9 km
  ad: node("1004", "99 Berry St", 40.7185, -73.959),
};

export function searchResponse(
  nodes = [LISTINGS.far, LISTINGS.mid, LISTINGS.ad, LISTINGS.near],
  total = 4,
) {
  return {
    data: {
      searchRentals: {
        __typename: "SearchRentalsResponse",
        totalCount: total,
        edges: nodes.map((n) =>
          n === LISTINGS.ad
            ? { __typename: "SponsoredRentalEdge", node: n, sponsoredSimilarityLabel: "similar" }
            : {
                __typename: "OrganicRentalEdge",
                node: n,
                amenitiesMatch: true,
                matchedAmenities: [],
                missingAmenities: [],
              },
        ),
      },
    },
  };
}

/** Zyte route answering every StreetEasy call with `body`. */
export function zyteRoute(
  body: () => unknown,
  onRequest?: (payload: Record<string, unknown>) => void,
): Route {
  return {
    match: /^https:\/\/api\.zyte\.com\/v1\/extract$/,
    respond: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      onRequest?.(payload);
      return Response.json({ statusCode: 200, httpResponseBody: b64(JSON.stringify(body())) });
    },
  };
}

/** Geosearch route: returns a lot at the address's listing coordinates. */
export function geosearchRoute(): Route {
  const byStreet: Record<string, { lat: number; lng: number; bbl: string; bin: string }> = {
    "150 n 6th st": { lat: 40.71812, lng: -73.95788, bbl: "3023370001", bin: "3062001" },
    "200 metropolitan ave": { lat: 40.71409, lng: -73.95548, bbl: "3023670010", bin: "3062002" },
  };
  return {
    match: /^https:\/\/geosearch\.planninglabs\.nyc\//,
    respond: (url) => {
      const text = (url.searchParams.get("text") ?? "").toLowerCase();
      const key = Object.keys(byStreet).find((k) => text.startsWith(k));
      const hit = key ? byStreet[key] : undefined;
      return Response.json({
        features: hit
          ? [
              {
                geometry: { coordinates: [hit.lng, hit.lat] },
                properties: {
                  label: `${key?.toUpperCase()}, Brooklyn, NY, USA`,
                  borough: "Brooklyn",
                  postalcode: "11249",
                  layer: "address",
                  addendum: { pad: { bbl: hit.bbl, bin: hit.bin } },
                },
              },
            ]
          : [],
      });
    },
  };
}

/** NYC Open Data route: answers by dataset id. */
export function socrataRoute(rows: Record<string, (params: URLSearchParams) => unknown[]>): Route {
  return {
    match: /^https:\/\/data\.cityofnewyork\.us\/resource\//,
    respond: (url) => {
      const id = url.pathname.split("/").pop()?.replace(".json", "") ?? "";
      const handler = rows[id];
      return Response.json(handler ? handler(url.searchParams) : []);
    },
  };
}
