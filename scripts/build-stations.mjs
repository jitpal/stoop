#!/usr/bin/env node
/**
 * Builds src/data/stations.json from the MTA's static subway GTFS.
 *
 *   curl -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
 *   unzip -d gtfs gtfs_subway.zip
 *   node scripts/build-stations.mjs gtfs
 *
 * One entry per station complex (stations joined by an in-system transfer, e.g.
 * Times Sq-42 St), with the routes that stop there on weekday daytime service
 * (06:00-21:00). Express variants (6X, 7X, FX) fold into their base route.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/build-stations.mjs <extracted-gtfs-dir>");
  process.exit(1);
}

/** Minimal CSV reader: GTFS files here have no embedded newlines in the columns we read. */
function readCsv(name) {
  const text = readFileSync(join(dir, name), "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const stops = readCsv("stops.txt");
const parents = new Map();
const parentOf = new Map();
for (const s of stops) {
  if (s.location_type === "1") {
    parents.set(s.stop_id, {
      id: s.stop_id,
      name: s.stop_name,
      lat: +s.stop_lat,
      lng: +s.stop_lon,
    });
  }
}
for (const s of stops) {
  parentOf.set(s.stop_id, s.parent_station || s.stop_id);
}

const weekday = new Set(
  readCsv("calendar.txt")
    .filter((c) => c.monday === "1")
    .map((c) => c.service_id),
);
const tripRoute = new Map();
for (const t of readCsv("trips.txt")) {
  if (weekday.has(t.service_id)) tripRoute.set(t.trip_id, t.route_id);
}

const routesAt = new Map();
const allRoutesAt = new Map();
const add = (map, key, route) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(route);
};
const baseRoute = (r) => (/^[0-9A-Z]X$/.test(r) ? r[0] : r);

const stopTimes = readFileSync(join(dir, "stop_times.txt"), "utf8").split(/\r?\n/);
const stHeader = splitCsvLine(stopTimes[0]);
const iTrip = stHeader.indexOf("trip_id");
const iStop = stHeader.indexOf("stop_id");
const iArr = stHeader.indexOf("arrival_time");
for (let i = 1; i < stopTimes.length; i++) {
  const line = stopTimes[i];
  if (!line) continue;
  const cells = line.split(",");
  const route = tripRoute.get(cells[iTrip]);
  if (!route) continue;
  const parent = parentOf.get(cells[iStop]) ?? cells[iStop];
  const r = baseRoute(route);
  add(allRoutesAt, parent, r);
  const hour = Number(cells[iArr].slice(0, 2));
  if (hour >= 6 && hour < 21) add(routesAt, parent, r);
}

/* Union-find over in-system transfers to form complexes. */
const root = new Map([...parents.keys()].map((id) => [id, id]));
const find = (id) => {
  while (root.get(id) !== id) id = root.get(id);
  return id;
};
for (const t of readCsv("transfers.txt")) {
  const a = parentOf.get(t.from_stop_id) ?? t.from_stop_id;
  const b = parentOf.get(t.to_stop_id) ?? t.to_stop_id;
  if (a !== b && root.has(a) && root.has(b)) root.set(find(a), find(b));
}

const groups = new Map();
for (const id of parents.keys()) {
  const r = find(id);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(id);
}

const ROUTE_ORDER = "1234567ABCDEFGJLMNQRSWZ";
const routeSort = (a, b) => {
  const ia = ROUTE_ORDER.indexOf(a[0]);
  const ib = ROUTE_ORDER.indexOf(b[0]);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
};
const routeName = (r) => (r === "GS" || r === "FS" || r === "H" ? "S" : r);

const stations = [];
for (const ids of groups.values()) {
  const members = ids.map((id) => parents.get(id));
  const routes = new Set();
  const nightRoutes = new Set();
  for (const id of ids) {
    for (const r of routesAt.get(id) ?? []) routes.add(routeName(r));
    for (const r of allRoutesAt.get(id) ?? []) nightRoutes.add(routeName(r));
  }
  const all = routes.size ? routes : nightRoutes;
  if (!all.size) continue; // closed / not in weekday service
  const names = [...new Set(members.map((m) => m.name))];
  stations.push({
    id: ids.sort()[0],
    name: names.join(" / "),
    lat: round(members.reduce((s, m) => s + m.lat, 0) / members.length),
    lng: round(members.reduce((s, m) => s + m.lng, 0) / members.length),
    routes: [...all].sort(routeSort),
    stops: ids.sort(),
  });
}
stations.sort((a, b) => a.id.localeCompare(b.id));

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

const feedInfo = readCsv("feed_info.txt")[0] ?? {};
const out = {
  source: "MTA NYCT static subway GTFS (rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip)",
  feed_version: feedInfo.feed_version ?? null,
  built_at: new Date().toISOString().slice(0, 10),
  stations,
};
writeFileSync("src/data/stations.json", `${JSON.stringify(out)}\n`);
console.log(`wrote ${stations.length} station complexes to src/data/stations.json`);
