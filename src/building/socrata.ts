/**
 * NYC Open Data (Socrata SODA 2.1) queries.
 *
 * Every dataset here is keyed by a tax lot (BBL) or building (BIN) id, but
 * datasets disagree on whether that column is text or a number, and SoQL refuses
 * to compare across types. So id filters are written with a placeholder and
 * tried quoted first, then unquoted if Socrata answers with a type mismatch; the
 * style that worked is remembered per dataset and column.
 */

import { type Cache, cached, hashKey, TTL } from "../cache";
import type { FetchLike } from "../upstream/providers";

const BASE = "https://data.cityofnewyork.us/resource";

export const DATASETS = {
  hpdViolations: { id: "wvxf-dwi5", name: "HPD Housing Maintenance Code Violations" },
  complaints311: { id: "erm2-nwe9", name: "311 Service Requests" },
  bedbugs: { id: "wz6d-d3jb", name: "Bedbug Reporting (HPD annual filings)" },
  dobViolations: { id: "3h2n-5cm9", name: "DOB Violations" },
  dobPermits: { id: "rbx6-tga4", name: "DOB NOW: Build – Approved Permits" },
  evictions: { id: "6z8x-wfk4", name: "Evictions (executed by NYC Marshals)" },
  pluto: { id: "64uk-42ks", name: "Primary Land Use Tax Lot Output (PLUTO)" },
  hpdRegistrations: { id: "tesw-yqqr", name: "HPD Multiple Dwelling Registrations" },
  hpdContacts: { id: "feu5-w2e2", name: "HPD Registration Contacts" },
} as const;

export type DatasetKey = keyof typeof DATASETS;

export function datasetUrl(key: DatasetKey): string {
  return `https://data.cityofnewyork.us/d/${DATASETS[key].id}`;
}

export type Row = Record<string, string | undefined>;

export interface SocrataDeps {
  fetch: FetchLike;
  cache: Cache;
  appToken?: string | null;
}

export class SocrataError extends Error {
  constructor(
    readonly dataset: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SocrataError";
  }
}

type Style = "text" | "number";
const styleMemo = new Map<string, Style>();

/** Renders `field = v` or `field IN (...)` in the given literal style. */
export function idClause(field: string, ids: string[], style: Style): string {
  const lits = ids.map((id) =>
    style === "text" ? `'${id.replace(/'/g, "''")}'` : String(Number(id)),
  );
  return lits.length === 1 ? `${field} = ${lits[0]}` : `${field} IN (${lits.join(", ")})`;
}

/**
 * Runs a query whose `$where` includes an id filter on `field`.
 * `build(idWhere)` returns the SoQL params given the rendered id clause.
 */
export async function queryById(
  deps: SocrataDeps,
  dataset: DatasetKey,
  field: string,
  ids: string[],
  build: (idWhere: string) => Record<string, string>,
): Promise<Row[]> {
  const memoKey = `${dataset}.${field}`;
  const first = styleMemo.get(memoKey) ?? "text";
  const order: Style[] = first === "text" ? ["text", "number"] : ["number", "text"];
  let lastErr: unknown;
  for (const style of order) {
    try {
      const rows = await query(deps, dataset, build(idClause(field, ids, style)));
      styleMemo.set(memoKey, style);
      return rows;
    } catch (err) {
      lastErr = err;
      if (
        !(err instanceof SocrataError && err.status === 400 && /mismatch|type/i.test(err.message))
      ) {
        throw err;
      }
    }
  }
  throw lastErr;
}

export async function query(
  deps: SocrataDeps,
  dataset: DatasetKey,
  params: Record<string, string>,
): Promise<Row[]> {
  const { id } = DATASETS[dataset];
  const url = `${BASE}/${id}.json?${new URLSearchParams(params)}`;
  return cached(deps.cache, `soql:${hashKey(url)}`, TTL.records, async () => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (deps.appToken) headers["X-App-Token"] = deps.appToken;
    const res = await deps.fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // not JSON; keep the text
      }
      throw new SocrataError(
        id,
        res.status,
        `${DATASETS[dataset].name}: HTTP ${res.status}: ${message}`,
      );
    }
    return JSON.parse(text) as Row[];
  });
}

/** ISO date `days` ago, as a SoQL floating-timestamp literal. */
export function since(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

export function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
