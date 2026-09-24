/**
 * Distances and walking time.
 *
 * Walking time is an estimate from straight-line distance: Manhattan-style grids
 * make the real route about 1.3× the crow-flies distance, at ~80 m a minute
 * (3 mph). Good enough to decide "near"; not a routing engine.
 */

export interface Point {
  lat: number;
  lng: number;
}

export const WALK_METERS_PER_MIN = 80;
export const DETOUR_FACTOR = 1.3;

export function metersBetween(a: Point, b: Point): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated walking minutes for a straight-line distance. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round((meters * DETOUR_FACTOR) / WALK_METERS_PER_MIN));
}

/** Straight-line radius that corresponds to a walking time. */
export function radiusForMinutes(minutes: number): number {
  return (minutes * WALK_METERS_PER_MIN) / DETOUR_FACTOR;
}
