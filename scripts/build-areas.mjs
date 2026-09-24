#!/usr/bin/env node
/**
 * Builds src/data/areas.json: every StreetEasy area code with its borough, kind,
 * and (for neighborhoods) an approximate center and radius.
 *
 *   node scripts/build-areas.mjs <streeteasy-constants.ts> <neighborhoods.geojson>
 *
 * Inputs:
 * - the `Areas` table from evandcoleman/streeteasy-api (src/constants.ts), which
 *   lists codes in borough sections;
 * - Pediacities NYC neighborhood polygons (HodgesWardElliott/custom-nyc-neighborhoods,
 *   custom-pedia-cities-nyc-Mar2018.geojson). Center = area-weighted polygon
 *   centroid; radius = farthest vertex from it.
 *
 * StreetEasy areas with no matching polygon get a hand-placed center from
 * MANUAL below (radius 700 m). These only decide which areas a location search
 * scans; listings are then filtered on their own coordinates, so a center that is
 * a few hundred meters off costs a little recall at the edge, not accuracy.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [constantsPath, geojsonPath] = process.argv.slice(2);
if (!constantsPath || !geojsonPath) {
  console.error("usage: node scripts/build-areas.mjs <constants.ts> <neighborhoods.geojson>");
  process.exit(1);
}

/** Umbrella areas: searching one includes its sub-areas. Not used for geo matching. */
const GROUPS = new Set([
  "ALL_NYC_AND_NJ",
  "ALL_DOWNTOWN",
  "ALL_MIDTOWN",
  "ALL_UPPER_WEST_SIDE",
  "ALL_UPPER_EAST_SIDE",
  "ALL_UPPER_MANHATTAN",
  "ROCKAWAY_ALL",
  "NORTH_SHORE",
  "SOUTH_SHORE",
  "EAST_SHORE",
  "WEST_SHORE",
  "MID_ISLAND",
]);
const BOROUGHS = new Set(["MANHATTAN", "BRONX", "BROOKLYN", "QUEENS", "STATEN_ISLAND"]);

/** StreetEasy key → polygon name, where the spelling differs. */
const ALIASES = {
  CLAREMONT: "Claremont Village",
  MT_HOPE: "Mount Hope",
  COLUMBIA_ST_WATERFRONT_DISTRICT: "Columbia St",
  WHITSTONE: "Whitestone",
  BAY_TERRACE_QUEENS: "Bay Terrace",
  SAINT_GEORGE: "St. George",
  FLATIRON: "Flatiron District",
  GRAMERCY_PARK: "Gramercy",
  STUYVESANT_TOWN_PCV: "Stuyvesant Town",
  CENTRAL_HARLEM: "Harlem",
  BAY_TERRACE: "Bay Terrace, Staten Island",
};

/** Hand-placed centers [lat, lng] for areas the polygon set doesn't have. */
const MANUAL = {
  // Bronx
  CROTONA_PARK_EAST: [40.8365, -73.89],
  EAST_TREMONT: [40.843, -73.887],
  NORTH_NEW_YORK: [40.825, -73.915],
  BEDFORD_PARK: [40.87, -73.885],
  KINGSBRIDGE_HEIGHTS: [40.871, -73.902],
  LACONIA: [40.874, -73.852],
  PELHAM_PARKWAY: [40.857, -73.86],
  LOCUST_POINT: [40.815, -73.793],
  BRONXWOOD: [40.872, -73.86],
  WESTCHESTER_VILLAGE: [40.842, -73.844],
  WOODSTOCK: [40.82, -73.9],
  // Brooklyn
  OCEAN_HILL: [40.678, -73.911],
  STUYVESANT_HEIGHTS: [40.683, -73.932],
  CITY_LINE: [40.68, -73.87],
  NEW_LOTS: [40.662, -73.886],
  STARRETT_CITY: [40.648, -73.882],
  MAPLETON: [40.613, -73.99],
  WEEKSVILLE: [40.675, -73.928],
  DITMAS_PARK: [40.638, -73.962],
  FISKE_TERRACE: [40.629, -73.961],
  OCEAN_PARKWAY: [40.615, -73.97],
  FARRAGUT: [40.64, -73.93],
  WINGATE: [40.66, -73.942],
  OLD_MILL_BASIN: [40.615, -73.908],
  PROSPECT_PARK_SOUTH: [40.644, -73.965],
  GREENWOOD: [40.656, -73.995],
  HOMECREST: [40.598, -73.959],
  MADISON: [40.608, -73.948],
  // Queens
  EAST_FLUSHING: [40.757, -73.812],
  MURRAY_HILL_QUEENS: [40.762, -73.813],
  HUNTERS_POINT: [40.744, -73.953],
  NORTH_CORONA: [40.754, -73.866],
  BEECHHURST: [40.792, -73.798],
  MALBA: [40.791, -73.83],
  AUBURNDALE: [40.76, -73.79],
  HAMILTON_BEACH: [40.656, -73.829],
  LINDENWOOD: [40.668, -73.848],
  OLD_HOWARD_BEACH: [40.657, -73.839],
  RAMBLERSVILLE: [40.661, -73.83],
  ROCKWOOD_PARK: [40.666, -73.842],
  SOUTH_JAMAICA: [40.688, -73.792],
  BROOKVILLE: [40.66, -73.755],
  CLEARVIEW: [40.78, -73.785],
  HILLCREST: [40.728, -73.796],
  NEW_HYDE_PARK: [40.74, -73.705],
  OAKLAND_GARDENS: [40.745, -73.758],
  POMONOK: [40.735, -73.815],
  HAMMELS: [40.587, -73.81],
  SOUTH_RICHMOND_HILL: [40.689, -73.819],
  UTOPIA: [40.736, -73.793],
  // Staten Island
  ELM_PARK: [40.632, -74.14],
  ANNADALE: [40.54, -74.178],
  GREENRIDGE: [40.56, -74.17],
  RICHMOND_VALLEY: [40.519, -74.229],
  EGBERTVILLE: [40.578, -74.115],
  GRASMERE: [40.603, -74.084],
  OAKWOOD_BEACH: [40.558, -74.115],
  OCEAN_BREEZE: [40.592, -74.068],
  TRAVIS: [40.59, -74.192],
  MANOR_HEIGHTS: [40.604, -74.127],
  MEIERS_CORNERS: [40.61, -74.135],
  SUNNYSIDE_STATEN_ISLAND: [40.613, -74.105],
  // Manhattan
  WEST_CHELSEA: [40.748, -74.005],
  FULTON_SEAPORT: [40.707, -74.003],
  NOMAD: [40.745, -73.988],
  HUDSON_SQUARE: [40.727, -74.008],
  CENTRAL_PARK_SOUTH: [40.765, -73.977],
  MIDTOWN_EAST: [40.754, -73.972],
  SUTTON_PLACE: [40.758, -73.961],
  TURTLE_BAY: [40.753, -73.968],
  BEEKMAN: [40.754, -73.965],
  MIDTOWN_SOUTH: [40.748, -73.988],
  MIDTOWN_WEST: [40.76, -73.99],
  HUDSON_YARDS: [40.754, -74.001],
  LINCOLN_SQUARE: [40.774, -73.985],
  MANHATTAN_VALLEY: [40.798, -73.966],
  CARNEGIE_HILL: [40.784, -73.955],
  LENOX_HILL: [40.767, -73.96],
  UPPER_CARNEGIE_HILL: [40.789, -73.952],
  YORKVILLE: [40.776, -73.949],
  SOUTH_HARLEM: [40.802, -73.954],
  FORT_GEORGE: [40.858, -73.928],
  HUDSON_HEIGHTS: [40.854, -73.938],
  WEST_HARLEM: [40.815, -73.953],
  MANHATTANVILLE: [40.816, -73.956],
};

const MANUAL_RADIUS_M = 700;
const SECTION_BOROUGH = {
  Bronx: "Bronx",
  Brooklyn: "Brooklyn",
  Queens: "Queens",
  "Staten Island": "Staten Island",
  Manhattan: "Manhattan",
};

/* Parse `KEY: code,` lines, tracking the `// Borough` section they sit under. */
const src = readFileSync(constantsPath, "utf8").split("export const Amenities")[0];
const areas = [];
let section = null;
for (const line of src.split("\n")) {
  const comment = line.match(/^\s*\/\/\s*(.+?)\s*$/);
  if (comment) {
    section = SECTION_BOROUGH[comment[1]] ?? null;
    continue;
  }
  const m = line.match(/^\s+([A-Z_0-9]+): (\d+),/);
  if (m) areas.push({ key: m[1], code: Number(m[2]), borough: section });
}

const geo = JSON.parse(readFileSync(geojsonPath, "utf8"));
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const polygons = new Map();
for (const f of geo.features) {
  const name = f.properties.neighborhood;
  const key = `${f.properties.borough}|${norm(name)}`;
  if (!polygons.has(key)) polygons.set(key, { name, rings: [] });
  const g = f.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const p of polys) polygons.get(key).rings.push(p[0]);
}

function centroidAndRadius(rings) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  const lng = cx / (3 * a);
  const lat = cy / (3 * a);
  let r = 0;
  for (const ring of rings) for (const [x, y] of ring) r = Math.max(r, meters(lat, lng, y, x));
  return { lat, lng, r };
}

function meters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const titleCase = (key) =>
  key
    .toLowerCase()
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

const out = [];
const unplaced = [];
for (const a of areas) {
  const entry = { code: a.code, key: a.key, name: titleCase(a.key), borough: a.borough };
  if (a.key === "ALL_NYC_AND_NJ") {
    entry.kind = "region";
    entry.borough = null;
  } else if (BOROUGHS.has(a.key)) entry.kind = "borough";
  else if (GROUPS.has(a.key)) entry.kind = "group";
  else {
    entry.kind = "neighborhood";
    const alias = ALIASES[a.key];
    const poly = polygons.get(`${a.borough}|${norm(alias ?? a.key)}`);
    if (poly) {
      const { lat, lng, r } = centroidAndRadius(poly.rings);
      entry.name = poly.name;
      entry.lat = round(lat);
      entry.lng = round(lng);
      entry.radius_m = Math.round(r);
      entry.center_source = "polygon";
    } else if (MANUAL[a.key]) {
      [entry.lat, entry.lng] = MANUAL[a.key];
      entry.radius_m = MANUAL_RADIUS_M;
      entry.center_source = "manual";
    } else unplaced.push(a.key);
  }
  out.push(entry);
}

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}

/* Friendlier names for keys whose title case reads badly. */
const NAMES = {
  NOHO: "NoHo",
  SOHO: "SoHo",
  NOMAD: "NoMad",
  DUMBO: "DUMBO",
  HELLS_KITCHEN: "Hell's Kitchen",
  STUYVESANT_TOWN_PCV: "Stuyvesant Town / PCV",
  MURRAY_HILL_QUEENS: "Murray Hill (Queens)",
  BAY_TERRACE_QUEENS: "Bay Terrace (Queens)",
  SUNNYSIDE_STATEN_ISLAND: "Sunnyside (Staten Island)",
  MT_HOPE: "Mount Hope",
  WHITSTONE: "Whitestone",
  SAINT_GEORGE: "St. George",
  GREENWOOD: "Greenwood Heights",
  ALL_NYC_AND_NJ: "All NYC and NJ",
  ROCKAWAY_ALL: "All Rockaway",
  COLUMBIA_ST_WATERFRONT_DISTRICT: "Columbia Street Waterfront District",
  CO_OP_CITY: "Co-op City",
};
for (const e of out) {
  if (NAMES[e.key]) e.name = NAMES[e.key];
  else if (e.key.startsWith("ALL_")) e.name = `All ${titleCase(e.key.slice(4))}`;
}

writeFileSync(
  "src/data/areas.json",
  `${JSON.stringify({
    source:
      "Codes: evandcoleman/streeteasy-api. Centers: Pediacities NYC neighborhoods (HodgesWardElliott/custom-nyc-neighborhoods) plus hand-placed centers.",
    built_at: new Date().toISOString().slice(0, 10),
    areas: out,
  })}\n`,
);
const placed = out.filter((e) => e.lat !== undefined);
console.log(
  `wrote ${out.length} areas (${placed.filter((e) => e.center_source === "polygon").length} polygon centers, ${placed.filter((e) => e.center_source === "manual").length} manual)`,
);
if (unplaced.length) console.log("neighborhoods with no center:", unplaced.join(", "));
