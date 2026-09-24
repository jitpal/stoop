/**
 * A building's public record, from NYC Open Data and FEMA.
 *
 * Three depths over the same datasets:
 * - `flagsFor`: four facts per building for a whole page of search results,
 *   one batched query per dataset;
 * - `buildingReport(..., "summary")`: counts per section, for get_listing;
 * - `buildingReport(..., "full")`: counts, trends and the most recent items,
 *   for check_building.
 *
 * Every section says where it came from and over what period. A section that
 * failed is reported as `unavailable` with the reason: never as zero, because
 * "no violations" and "couldn't check" mean opposite things to a renter.
 *
 * Queries that touch columns whose exact names couldn't be verified at build
 * time select `*` and read fields defensively, so a renamed column degrades to a
 * missing field instead of a failed section. `npm run check-datasets` verifies
 * every dataset and column against the live API.
 */

import type { FetchLike } from "../upstream/providers";
import { type ResolvedBuilding, recordLinks } from "./resolve";
import {
  DATASETS,
  type DatasetKey,
  datasetUrl,
  num,
  queryById,
  type Row,
  type SocrataDeps,
  since,
} from "./socrata";

export type Section<T> =
  | { status: "ok"; source: string; source_url: string; period?: string; data: T }
  | { status: "unavailable"; source: string; source_url: string; error: string };

async function section<T>(
  dataset: DatasetKey | { name: string; url: string },
  period: string | undefined,
  load: () => Promise<T>,
): Promise<Section<T>> {
  const source = typeof dataset === "string" ? DATASETS[dataset].name : dataset.name;
  const source_url = typeof dataset === "string" ? datasetUrl(dataset) : dataset.url;
  try {
    const data = await load();
    return { status: "ok", source, source_url, ...(period ? { period } : {}), data };
  } catch (err) {
    return {
      status: "unavailable",
      source,
      source_url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const HEAT = "HEAT/HOT WATER";

/* -------------------------------------------------------------------------- */
/* Flags: one page of search results                                           */
/* -------------------------------------------------------------------------- */

export interface BuildingFlags {
  bbl: string;
  /** Open class C ("immediately hazardous") HPD violations. null = couldn't check. */
  open_class_c_violations: number | null;
  /** 311 heat/hot-water complaints in the last 12 months. null = couldn't check. */
  heat_complaints_12mo: number | null;
  /** Any HPD bedbug filing with infested units in the last 3 years. null = couldn't check. */
  bedbugs_reported_3y: boolean | null;
}

export async function flagsFor(
  bbls: string[],
  deps: SocrataDeps,
): Promise<Map<string, BuildingFlags>> {
  const unique = [...new Set(bbls)];
  const out = new Map<string, BuildingFlags>();
  if (!unique.length) return out;

  const [hpd, heat, bugs] = await Promise.all([
    queryById(deps, "hpdViolations", "bbl", unique, (id) => ({
      $select: "bbl, count(*) AS n",
      $where: `${id} AND class = 'C' AND violationstatus = 'Open'`,
      $group: "bbl",
    })).catch(() => null),
    queryById(deps, "complaints311", "bbl", unique, (id) => ({
      $select: "bbl, count(*) AS n",
      $where: `${id} AND complaint_type = '${HEAT}' AND created_date >= '${since(365)}'`,
      $group: "bbl",
    })).catch(() => null),
    queryById(deps, "bedbugs", "bbl", unique, (id) => ({
      $where: `${id} AND filing_date >= '${since(3 * 365)}'`,
      $limit: String(unique.length * 5),
    })).catch(() => null),
  ]);

  const countBy = (rows: Row[] | null) => {
    if (!rows) return null;
    const m = new Map<string, number>();
    for (const r of rows) if (r.bbl) m.set(normBbl(r.bbl), num(r.n));
    return m;
  };
  const hpdCounts = countBy(hpd);
  const heatCounts = countBy(heat);
  const bugBbls = bugs
    ? new Set(
        bugs
          .filter((r) => num(r.infested_dwelling_unit_count) > 0)
          .map((r) => normBbl(r.bbl ?? "")),
      )
    : null;

  for (const bbl of unique) {
    out.set(bbl, {
      bbl,
      open_class_c_violations: hpdCounts ? (hpdCounts.get(bbl) ?? 0) : null,
      heat_complaints_12mo: heatCounts ? (heatCounts.get(bbl) ?? 0) : null,
      bedbugs_reported_3y: bugBbls ? bugBbls.has(bbl) : null,
    });
  }
  return out;
}

/** Socrata sometimes returns BBLs as "1000780047.00000000". */
function normBbl(v: string): string {
  return v.split(".")[0] ?? v;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

export const REPORT_SECTIONS = [
  "overview",
  "hpd_violations",
  "complaints_311",
  "bedbugs",
  "evictions",
  "dob_violations",
  "permits",
  "owner",
  "flood_zone",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** What get_listing includes; check_building defaults to all of REPORT_SECTIONS. */
export const SUMMARY_SECTIONS: ReportSection[] = [
  "hpd_violations",
  "complaints_311",
  "bedbugs",
  "evictions",
  "dob_violations",
];

export interface ReportOptions {
  sections?: ReportSection[];
  depth: "summary" | "full";
  /** Look-back for counts, in years (default 3). */
  years?: number;
}

export interface BuildingReport {
  matched: boolean;
  address: string;
  bbl?: string;
  bin?: string | null;
  links?: Record<string, string>;
  reason?: string;
  as_of: string;
  sections: Partial<Record<ReportSection, unknown>>;
  notes: string[];
}

export async function buildingReport(
  building: ResolvedBuilding,
  deps: SocrataDeps & { fetch: FetchLike },
  opts: ReportOptions,
): Promise<BuildingReport> {
  const as_of = new Date().toISOString().slice(0, 10);
  if (!building.matched) {
    return {
      matched: false,
      address: building.address,
      reason: building.reason,
      as_of,
      sections: {},
      notes: [
        "No public records were checked because the building couldn't be identified. This is not a clean record.",
      ],
    };
  }
  const { bbl, bin } = building;
  const full = opts.depth === "full";
  const years = opts.years ?? 3;
  const wanted = new Set(opts.sections ?? (full ? REPORT_SECTIONS : SUMMARY_SECTIONS));
  const sinceYears = since(years * 365);
  const period = `since ${sinceYears}`;

  const tasks: [ReportSection, Promise<unknown>][] = [];
  const add = (name: ReportSection, p: () => Promise<unknown>) => {
    if (wanted.has(name)) tasks.push([name, p()]);
  };

  add("overview", () => section("pluto", undefined, () => overview(bbl, deps)));
  add("hpd_violations", () =>
    section("hpdViolations", period, () => hpdViolations(bbl, sinceYears, full, deps)),
  );
  add("complaints_311", () =>
    section("complaints311", "last 12 months", () => complaints311(bbl, full, deps)),
  );
  add("bedbugs", () =>
    section("bedbugs", "most recent annual filings", () => bedbugs(bbl, full, deps)),
  );
  add("evictions", () =>
    section("evictions", period, () => evictions(bbl, sinceYears, full, deps)),
  );
  if (bin) {
    add("dob_violations", () =>
      section("dobViolations", "currently active", () => dobViolations(bin, full, deps)),
    );
    add("permits", () => section("dobPermits", "most recent 15 permits", () => permits(bin, deps)));
    add("owner", () =>
      section("hpdRegistrations", "latest HPD registration", () => owner(bin, deps)),
    );
  }
  add("flood_zone", () =>
    section(
      { name: "FEMA National Flood Hazard Layer", url: "https://msc.fema.gov/portal/home" },
      undefined,
      () => floodZone(building.lat, building.lng, deps.fetch),
    ),
  );

  const results = await Promise.all(tasks.map(([, p]) => p));
  const sections: Partial<Record<ReportSection, unknown>> = {};
  tasks.forEach(([name], i) => {
    sections[name] = results[i];
  });

  const notes = [
    "Counts come from public city records as of the dates shown; they describe the whole building, not a specific apartment.",
  ];
  if (!bin && (wanted.has("dob_violations") || wanted.has("permits") || wanted.has("owner"))) {
    notes.push(
      "The city has no building id (BIN) for this lot, so DOB and registration records were skipped.",
    );
  }
  return {
    matched: true,
    address: building.address,
    bbl,
    bin,
    links: recordLinks(bbl, bin),
    as_of,
    sections,
    notes,
  };
}

async function overview(bbl: string, deps: SocrataDeps) {
  const rows = await queryById(deps, "pluto", "bbl", [bbl], (id) => ({ $where: id, $limit: "1" }));
  const r = rows[0];
  if (!r) return { found: false };
  return {
    found: true,
    address: r.address,
    zip: r.zipcode,
    building_class: r.bldgclass,
    year_built: num(r.yearbuilt) || null,
    year_altered: [r.yearalter1, r.yearalter2].map(num).filter(Boolean),
    floors: num(r.numfloors) || null,
    residential_units: num(r.unitsres),
    total_units: num(r.unitstotal),
    buildings_on_lot: num(r.numbldgs) || null,
    owner_name: r.ownername ?? null,
  };
}

async function hpdViolations(bbl: string, sinceDate: string, full: boolean, deps: SocrataDeps) {
  const counts = await queryById(deps, "hpdViolations", "bbl", [bbl], (id) => ({
    $select: "class, violationstatus, count(*) AS n",
    $where: `${id} AND inspectiondate >= '${sinceDate}'`,
    $group: "class, violationstatus",
  }));
  const by_class: Record<string, { open: number; total: number }> = {};
  let open = 0;
  let total = 0;
  for (const r of counts) {
    const cls = r.class ?? "?";
    by_class[cls] ??= { open: 0, total: 0 };
    const n = num(r.n);
    by_class[cls].total += n;
    total += n;
    if (r.violationstatus === "Open") {
      by_class[cls].open += n;
      open += n;
    }
  }
  const data: Record<string, unknown> = {
    open,
    total,
    by_class,
    legend:
      "Class A = non-hazardous, B = hazardous, C = immediately hazardous (e.g. no heat, lead paint, vermin).",
  };
  if (full) {
    const recent = await queryById(deps, "hpdViolations", "bbl", [bbl], (id) => ({
      $where: `${id} AND violationstatus = 'Open'`,
      $order: "inspectiondate DESC",
      $limit: "8",
    }));
    data.recent_open = recent.map((r) => ({
      date: r.inspectiondate?.slice(0, 10),
      class: r.class,
      apartment: r.apartment || null,
      description: truncate(r.novdescription),
    }));
    const hpdId = recent[0]?.buildingid;
    if (hpdId) data.hpd_online = `https://hpdonline.nyc.gov/hpdonline/building/${hpdId}`;
  }
  return data;
}

async function complaints311(bbl: string, full: boolean, deps: SocrataDeps) {
  const byType = await queryById(deps, "complaints311", "bbl", [bbl], (id) => ({
    $select: "complaint_type, count(*) AS n",
    $where: `${id} AND created_date >= '${since(365)}'`,
    $group: "complaint_type",
    $order: "n DESC",
    $limit: "10",
  }));
  const data: Record<string, unknown> = {
    total_12mo: byType.reduce((s, r) => s + num(r.n), 0),
    heat_hot_water_12mo: num(byType.find((r) => r.complaint_type === HEAT)?.n),
    by_type: byType.map((r) => ({ type: r.complaint_type, count: num(r.n) })),
  };
  if (full) {
    const heat = await queryById(deps, "complaints311", "bbl", [bbl], (id) => ({
      $select: "date_trunc_ym(created_date) AS month, count(*) AS n",
      $where: `${id} AND complaint_type = '${HEAT}' AND created_date >= '${since(4 * 365)}'`,
      $group: "month",
    }));
    data.heat_by_season = heatSeasons(heat);
    const recent = await queryById(deps, "complaints311", "bbl", [bbl], (id) => ({
      $select: "created_date, complaint_type, descriptor, status",
      $where: id,
      $order: "created_date DESC",
      $limit: "8",
    }));
    data.recent = recent.map((r) => ({
      date: r.created_date?.slice(0, 10),
      type: r.complaint_type,
      detail: r.descriptor,
      status: r.status,
    }));
  }
  return data;
}

/** Heat season runs Oct 1 – May 31; label "2024-25". */
export function heatSeasons(rows: Row[]): { season: string; complaints: number }[] {
  const seasons = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.month ?? "");
    if (Number.isNaN(d.getTime())) continue;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const start = m >= 10 ? y : m <= 5 ? y - 1 : null;
    if (start === null) continue;
    const label = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
    seasons.set(label, (seasons.get(label) ?? 0) + num(r.n));
  }
  return [...seasons.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([season, complaints]) => ({ season, complaints }));
}

async function bedbugs(bbl: string, full: boolean, deps: SocrataDeps) {
  const rows = await queryById(deps, "bedbugs", "bbl", [bbl], (id) => ({
    $where: id,
    $order: "filing_date DESC",
    $limit: full ? "5" : "3",
  }));
  return {
    filings: rows.map((r) => ({
      filed: r.filing_date?.slice(0, 10),
      period_start: r.filing_period_start_date?.slice(0, 10),
      units_in_building: num(r.of_dwelling_units) || null,
      infested_units: num(r.infested_dwelling_unit_count),
      eradicated_units: num(r.eradicated_unit_count),
      reinfested_units: num(r.re_infested_dwelling_unit),
    })),
    note: rows.length
      ? "Landlords file these yearly for the previous 12 months."
      : "No bedbug filings found. Buildings with fewer than 3 units don't file.",
  };
}

async function evictions(bbl: string, sinceDate: string, full: boolean, deps: SocrataDeps) {
  const rows = await queryById(deps, "evictions", "bbl", [bbl], (id) => ({
    $where: `${id} AND executed_date >= '${sinceDate}'`,
    $order: "executed_date DESC",
    $limit: "100",
  }));
  const residential = rows.filter(
    (r) => !/commercial/i.test(r.residential_commercial_ind ?? r.residential_commercial ?? ""),
  );
  const byYear: Record<string, number> = {};
  for (const r of residential) {
    const y = r.executed_date?.slice(0, 4);
    if (y) byYear[y] = (byYear[y] ?? 0) + 1;
  }
  return {
    residential_evictions: residential.length,
    by_year: byYear,
    ...(full
      ? { note: "Executed evictions only (a marshal carried it out), not filings or cases." }
      : {}),
  };
}

async function dobViolations(bin: string, full: boolean, deps: SocrataDeps) {
  const rows = await queryById(deps, "dobViolations", "bin", [bin], (id) => ({
    $where: `${id} AND violation_category LIKE '%ACTIVE%'`,
    $order: "issue_date DESC",
    $limit: "50",
  }));
  return {
    active: rows.length,
    ...(full
      ? {
          recent_active: rows.slice(0, 8).map((r) => ({
            issued: formatYmd(r.issue_date),
            type: r.violation_type?.replace(/\s+/g, " ").trim(),
            description: truncate(r.description),
          })),
        }
      : {}),
  };
}

async function permits(bin: string, deps: SocrataDeps) {
  const rows = await queryById(deps, "dobPermits", "bin", [bin], (id) => ({
    $where: id,
    $order: "issued_date DESC",
    $limit: "15",
  }));
  const now = Date.now();
  const items = rows.map((r) => {
    const expires = r.expired_date ? Date.parse(r.expired_date) : Number.NaN;
    return {
      issued: r.issued_date?.slice(0, 10),
      expires: r.expired_date?.slice(0, 10),
      active: Number.isFinite(expires) ? expires > now : null,
      work_type: r.work_type,
      description: truncate(r.job_description),
    };
  });
  const active = items.filter((p) => p.active);
  return {
    active_permits: active.length,
    sidewalk_shed_or_scaffold: active.some((p) =>
      /shed|scaffold/i.test(`${p.work_type} ${p.description}`),
    ),
    permits: items,
  };
}

async function owner(bin: string, deps: SocrataDeps) {
  const regs = await queryById(deps, "hpdRegistrations", "bin", [bin], (id) => ({
    $where: id,
    $order: "lastregistrationdate DESC",
    $limit: "1",
  }));
  const reg = regs[0];
  if (!reg?.registrationid) {
    return {
      registered: false,
      note: "No HPD registration. Only buildings with 3+ units (or 1-2 with no owner in residence) must register.",
    };
  }
  const contacts = await queryById(
    deps,
    "hpdContacts",
    "registrationid",
    [reg.registrationid],
    (id) => ({
      $where: id,
      $limit: "50",
    }),
  );
  const person = (c: Row) =>
    c.corporationname?.trim() || [c.firstname, c.lastname].filter(Boolean).join(" ").trim() || null;
  const ofType = (...types: string[]) => [
    ...new Set(
      contacts
        .filter((c) => types.includes(c.type ?? ""))
        .map(person)
        .filter(Boolean),
    ),
  ];
  return {
    registered: true,
    last_registered: reg.lastregistrationdate?.slice(0, 10),
    registration_expires: reg.registrationenddate?.slice(0, 10),
    owners: ofType("CorporateOwner", "IndividualOwner", "JointOwner"),
    head_officers: ofType("HeadOfficer", "Officer"),
    managing_agents: ofType("Agent"),
    site_managers: ofType("SiteManager"),
    note: "Who Owns What (links.who_owns_what) shows the landlord's other buildings.",
  };
}

const FEMA_FLOOD_ZONES =
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";

async function floodZone(lat: number, lng: number, fetchImpl: FetchLike) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetchImpl(`${FEMA_FLOOD_ZONES}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`FEMA NFHL HTTP ${res.status}`);
  const body = (await res.json()) as {
    features?: { attributes?: { FLD_ZONE?: string; ZONE_SUBTY?: string; SFHA_TF?: string } }[];
    error?: { message?: string };
  };
  if (body.error) throw new Error(`FEMA NFHL: ${body.error.message}`);
  const a = body.features?.[0]?.attributes;
  if (!a) return { zone: null, high_risk: false, note: "No mapped flood zone at this point." };
  const high = a.SFHA_TF === "T" || /^(A|V)/.test(a.FLD_ZONE ?? "");
  return {
    zone: a.FLD_ZONE ?? null,
    subtype: a.ZONE_SUBTY ?? null,
    high_risk: high,
    note: high
      ? "In FEMA's 1%-annual-chance flood zone. NY landlords must disclose flood history and zone in the lease."
      : "Outside FEMA's 1%-annual-chance flood zone (it can still flood; check the lease's flood disclosure).",
  };
}

function truncate(s: string | undefined, n = 220): string | null {
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatYmd(s: string | undefined): string | null {
  if (!s) return null;
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
}
