/**
 * Subway stations (src/data/stations.json, built from the MTA's static GTFS by
 * scripts/build-stations.mjs). One entry per station complex; `routes` are the
 * lines that stop there on weekday daytime service.
 */

import data from "../data/stations.json";
import { AppError } from "../errors";
import { metersBetween, type Point, walkMinutes } from "./distance";

export interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  routes: string[];
  stops: string[];
}

export const STATIONS = data.stations as Station[];
export const STATIONS_FEED = data.feed_version;

/** Normalizes station names: "Bedford Av" = "bedford ave" = "Bedford Avenue". */
export function normalizeStation(s: string): string {
  return ` ${s.toLowerCase()} `
    .replace(/&/g, " and ")
    .replace(/[-–/().,']/g, " ")
    .replace(/\bavenue\b|\bave\b/g, "av")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bsquare\b/g, "sq")
    .replace(/\bboulevard\b|\bblvd\b/g, "blvd")
    .replace(/\bparkway\b|\bpkwy\b/g, "pkwy")
    .replace(/\broad\b/g, "rd")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bcenter\b|\bcentre\b/g, "ctr")
    .replace(/\bterminal\b/g, "term")
    .replace(/\bheights\b/g, "hts")
    .replace(/\bjunction\b/g, "jct")
    .replace(/\bstation\b|\bstop\b|\bsubway\b|\bthe\b/g, " ")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** What people call stations → part of the MTA name. */
const STATION_ALIASES: Record<string, string> = {
  "atlantic terminal": "Atlantic Av-Barclays Ctr",
  barclays: "Atlantic Av-Barclays Ctr",
  "barclays center": "Atlantic Av-Barclays Ctr",
  "times square": "Times Sq-42 St",
  "port authority": "42 St-Port Authority",
  "grand central": "Grand Central-42 St",
  "penn station": "34 St-Penn Station",
  penn: "34 St-Penn Station",
  "union square": "14 St-Union Sq",
  "herald square": "34 St-Herald Sq",
  "columbus circle": "59 St-Columbus Circle",
  "world trade center": "World Trade Center",
  wtc: "World Trade Center",
  "jackson heights": "Jackson Hts-Roosevelt Av",
  metrotech: "Jay St-MetroTech",
  "bryant park": "42 St-Bryant Pk",
  "rockefeller center": "Rockefeller Ctr",
  "hudson yards": "34 St-Hudson Yards",
  "city hall": "Brooklyn Bridge-City Hall",
  "court square": "Court Sq",
  "main street flushing": "Flushing-Main St",
};

export interface StationMatch extends Station {
  score: number;
}

/**
 * Finds stations by name, optionally restricted to a line. Accepts phrasing
 * like "the Bedford L", "Bedford Av on the L", "Atlantic Terminal", "14th St".
 */
export function findStations(query: string, line?: string, limit = 5): StationMatch[] {
  let q = query;
  let wantLine = line?.trim().toUpperCase();
  if (!wantLine) {
    // "Bedford L" / "the L at Bedford": pull a trailing or leading single-line token.
    const m =
      q.match(/(?:^|\s)(?:the\s+)?([1-7A-GJLMNQRSWZ])(?:\s+train|\s+line)?\s*$/i) ??
      q.match(/^(?:the\s+)?([1-7A-GJLMNQRSWZ])\s+(?:train\s+|line\s+)?(?:at|to)\s+/i);
    if (m?.[1] && q.trim().length > 2) {
      wantLine = m[1].toUpperCase();
      q = q.replace(m[0], " ");
    }
  }
  q = q.replace(/\b(?:on|at)\s+the\s+[a-z0-9]\b.*$/i, " ");
  const nq = normalizeStation(q);
  if (!nq) return [];
  const aliasKey = Object.keys(STATION_ALIASES).find((k) => normalizeStation(k) === nq);
  const alias = aliasKey ? normalizeStation(STATION_ALIASES[aliasKey] as string) : null;
  const tokens = nq.split(" ").filter(Boolean);

  const matches: StationMatch[] = [];
  for (const s of STATIONS) {
    if (wantLine && !s.routes.includes(wantLine === "SIR" ? "SI" : wantLine)) continue;
    const names = s.name.split(" / ").map(normalizeStation);
    let best = 0;
    for (const n of names) {
      if (n === nq || (alias && n.includes(alias))) best = Math.max(best, 100);
      else if (n.startsWith(nq) || nq.startsWith(n)) best = Math.max(best, 80);
      else {
        const nt = n.split(" ");
        const hit = tokens.filter((t) => nt.includes(t)).length;
        if (hit) best = Math.max(best, Math.round((60 * hit) / Math.max(tokens.length, nt.length)));
      }
    }
    if (best > 0) matches.push({ ...s, score: best });
  }
  return matches
    .sort((a, b) => b.score - a.score || b.routes.length - a.routes.length)
    .slice(0, limit);
}

/** Exactly one best station, or a STATION_NOT_FOUND error with suggestions. */
export function resolveStation(query: string, line?: string): Station {
  const found = findStations(query, line, 5);
  const best = found[0];
  if (!best || best.score < 40) {
    throw new AppError(
      "STATION_NOT_FOUND",
      `No subway station matches "${query}"${line ? ` on the ${line}` : ""}.`,
      found.length
        ? `Closest: ${found.map((s) => `${s.name} (${s.routes.join(" ")})`).join("; ")}. Call find_station to pick one.`
        : "Call find_station with a shorter name, or use near_place.",
    );
  }
  return best;
}

export function stationById(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id || s.stops.includes(id));
}

export interface NearbyStation {
  name: string;
  routes: string[];
  distance_m: number;
  walk_min: number;
}

export function stationsNear(point: Point, limit = 3, maxMeters = 1600): NearbyStation[] {
  return STATIONS.map((s) => ({ s, d: metersBetween(point, s) }))
    .filter((x) => x.d <= maxMeters)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ s, d }) => ({
      name: s.name,
      routes: s.routes,
      distance_m: Math.round(d),
      walk_min: walkMinutes(d),
    }));
}
