/**
 * NYC Geosearch (geosearch.planninglabs.nyc): the city's free geocoder, built on
 * its own address database (PAD). Besides coordinates it returns the tax lot
 * (BBL) and building (BIN) ids that key every public-records dataset.
 *
 * No key, no bot protection, so it is called directly.
 */

import { type Cache, cached, TTL } from "../cache";
import type { FetchLike } from "../upstream/providers";
import type { Point } from "./distance";

const ENDPOINT = "https://geosearch.planninglabs.nyc/v2/search";

export interface GeoResult extends Point {
  label: string;
  borough: string | null;
  zip: string | null;
  neighborhood: string | null;
  bbl: string | null;
  bin: string | null;
  layer: string | null;
}

interface Feature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    label?: string;
    borough?: string;
    postalcode?: string;
    neighbourhood?: string;
    layer?: string;
    addendum?: { pad?: { bbl?: string; bin?: string } };
  };
}

export async function geosearch(
  text: string,
  deps: { fetch: FetchLike; cache: Cache },
  opts: { focus?: Point; size?: number } = {},
): Promise<GeoResult[]> {
  const params = new URLSearchParams({ text, size: String(opts.size ?? 5) });
  if (opts.focus) {
    params.set("focus.point.lat", opts.focus.lat.toFixed(5));
    params.set("focus.point.lon", opts.focus.lng.toFixed(5));
  }
  const url = `${ENDPOINT}?${params}`;
  return cached(deps.cache, `geo:${url}`, TTL.geocode, async () => {
    const res = await deps.fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`NYC Geosearch HTTP ${res.status}`);
    const body = (await res.json()) as { features?: Feature[] };
    return (body.features ?? []).flatMap((f): GeoResult[] => {
      const c = f.geometry?.coordinates;
      if (!c) return [];
      const p = f.properties ?? {};
      const bbl = p.addendum?.pad?.bbl ?? null;
      const bin = p.addendum?.pad?.bin ?? null;
      return [
        {
          lat: c[1],
          lng: c[0],
          label: p.label ?? text,
          borough: p.borough ?? null,
          zip: p.postalcode ?? null,
          neighborhood: p.neighbourhood ?? null,
          bbl: bbl && /^\d{10}$/.test(bbl) ? bbl : null,
          // BINs ending in 000000 are placeholders for lots with no building.
          bin: bin && /^\d{7}$/.test(bin) && !/^\d000000$/.test(bin) ? bin : null,
          layer: p.layer ?? null,
        },
      ];
    });
  });
}

/**
 * Well-known places Geosearch doesn't index as addresses. `edge_m` is roughly
 * how far the place extends from its center: searches measure walking distance
 * from that edge, so "near Prospect Park" means near the park, not its middle.
 * Central Park is long and thin, so a circle fits it badly; its side streets
 * ("Central Park West & 86th St") give better results.
 */
export const LANDMARKS: Record<string, Point & { label: string; edge_m?: number }> = {
  "central park": { lat: 40.7812, lng: -73.9665, label: "Central Park", edge_m: 500 },
  "prospect park": { lat: 40.6602, lng: -73.969, label: "Prospect Park", edge_m: 900 },
  "mccarren park": { lat: 40.7205, lng: -73.9513, label: "McCarren Park" },
  "washington square park": { lat: 40.7308, lng: -73.9973, label: "Washington Square Park" },
  "union square": { lat: 40.7359, lng: -73.9906, label: "Union Square" },
  "tompkins square park": { lat: 40.7265, lng: -73.9817, label: "Tompkins Square Park" },
  "bryant park": { lat: 40.7536, lng: -73.9832, label: "Bryant Park" },
  "madison square park": { lat: 40.7424, lng: -73.9881, label: "Madison Square Park" },
  "fort greene park": { lat: 40.6912, lng: -73.9754, label: "Fort Greene Park" },
  "brooklyn bridge park": { lat: 40.7003, lng: -73.9967, label: "Brooklyn Bridge Park" },
  "domino park": { lat: 40.7142, lng: -73.9685, label: "Domino Park" },
  "astoria park": { lat: 40.7794, lng: -73.9226, label: "Astoria Park" },
  "grand central": { lat: 40.7527, lng: -73.9772, label: "Grand Central Terminal" },
  "penn station": { lat: 40.7506, lng: -73.9935, label: "Penn Station" },
  "barclays center": { lat: 40.6826, lng: -73.9754, label: "Barclays Center" },
  "hudson yards": { lat: 40.7536, lng: -74.0011, label: "Hudson Yards" },
  "world trade center": { lat: 40.7127, lng: -74.0134, label: "World Trade Center" },
  "columbia university": { lat: 40.8075, lng: -73.9626, label: "Columbia University" },
  nyu: { lat: 40.7295, lng: -73.9965, label: "NYU (Washington Square)" },
  "flushing meadows": {
    lat: 40.7397,
    lng: -73.8408,
    label: "Flushing Meadows Corona Park",
    edge_m: 1000,
  },
};
