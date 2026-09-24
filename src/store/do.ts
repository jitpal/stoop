/**
 * `StoopStore`, the single stateful component of this worker.
 *
 * One SQLite-backed Durable Object instance (id `"store:default"`) owns:
 *   - the API keys the operator minted at `/admin/keys`, as SHA-256 digests;
 *   - the audit log: every tool call and every key change;
 *   - the daily upstream request counter behind `MAX_UPSTREAM_REQUESTS_PER_DAY`;
 *   - the response cache (search pages, listings, public records, building ids).
 *
 * Keeping the counter here is what makes the daily cap exact: a Durable Object
 * serialises its own requests, so two searches cannot both read "299" and both
 * spend the 300th request. The cache lives here for the same reason it could have
 * lived in KV, with one difference that matters on the free plan: SQLite row
 * writes are allowed by the hundred thousand a day, KV writes by the thousand.
 *
 * Only `OAUTH_KV` is still KV, because `@cloudflare/workers-oauth-provider`
 * requires it.
 *
 * ## Test seam
 *
 * {@link StoopStore.now} is `protected` so tests can pin the clock on a live
 * instance with `runInDurableObject()` from `cloudflare:test`. There is no
 * test-only RPC on the production surface.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** The Durable Object id every request uses (one operator per deployment). */
export const STORE_DO_NAME = "store:default";

/** Audit rows older than this are pruned by {@link StoopStore.maintain}. */
export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Daily counters kept this many days, so the admin page can show recent usage. */
export const BUDGET_RETENTION_DAYS = 30;

/**
 * How often {@link StoopStore.matchApiKey} rewrites `last_used_at`.
 *
 * Every authenticated request matches a key, so an unconditional write would turn a
 * read into a write on the hot path. Once a minute is enough for the "last used"
 * column on the admin page.
 */
export const API_KEY_LAST_USED_THROTTLE_MS = 60 * 1000;

/** Longest an API key name may be. Names are labels for the audit log, not prose. */
export const API_KEY_NAME_MAX = 64;

/**
 * Largest cached value, in characters of JSON. A SQLite row in a Durable Object
 * tops out at 2 MB; anything near that is not worth caching anyway.
 */
export const CACHE_VALUE_MAX = 1_500_000;

/** Longest audit `args` JSON kept; longer arguments are cut and marked. */
const AUDIT_ARGS_MAX = 2_000;

/**
 * A JSON value, unrolled to a fixed depth instead of being defined recursively.
 *
 * Durable Object RPC maps an `unknown` return type to `never`, and a recursive JSON
 * type trips TypeScript's "excessively deep" guard inside the same mapper. Four
 * levels covers every tool argument this project stores.
 */
type Json1 = string | number | boolean | null;
type Json2 = Json1 | Json1[] | { [key: string]: Json1 };
type Json3 = Json2 | Json2[] | { [key: string]: Json2 };
export type JsonValue = Json3 | Json3[] | { [key: string]: Json3 };

/** One row of {@link StoopStore.listAudit}. */
export interface AuditEntry {
  id: number;
  /** ISO-8601 UTC. */
  ts: string;
  /** `bearer:<key name>`, `oauth:<client name>` or `admin:cookie`. */
  actor: string;
  tool: string;
  args?: JsonValue;
  outcome: string;
  error?: string;
  /** Paid upstream requests the call spent. */
  upstream: number;
  durationMs?: number;
}

/** Argument of {@link StoopStore.audit}. */
export interface AuditInput {
  actor: string;
  tool: string;
  args: unknown;
  outcome: "ok" | "error";
  error?: string;
  upstream?: number;
  durationMs?: number;
}

/**
 * One API key as {@link StoopStore.listApiKeys} reports it.
 *
 * There is no field for the key itself and there never will be: only its SHA-256 is
 * stored, and that is not returned either.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC; absent until the key authenticates a request. */
  lastUsedAt?: string;
  /** ISO-8601 UTC; present only on a revoked key. */
  revokedAt?: string;
}

/** What {@link StoopStore.matchApiKey} returns for a live key. */
export interface ApiKeyMatch {
  id: string;
  name: string;
}

/** Outcome of {@link StoopStore.spendUpstream}. */
export type SpendResult = { ok: true; used: number } | { ok: false; used: number };

/** Upstream requests used on one UTC day. */
export interface BudgetDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  used: number;
}

/** Summary returned by {@link StoopStore.maintain} (cron). */
export interface MaintenanceSummary {
  pruned: { audit: number; cache: number; budget: number };
}

interface CountRow extends Record<string, SqlStorageValue> {
  n: number;
}

interface ApiKeyRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface AuditRow extends Record<string, SqlStorageValue> {
  id: number;
  ts: number;
  actor: string;
  tool: string;
  args_redacted: string | null;
  outcome: string;
  error: string | null;
  upstream: number;
  duration_ms: number | null;
}

interface CacheRow extends Record<string, SqlStorageValue> {
  value: string;
  expires_at: number;
}

interface BudgetRow extends Record<string, SqlStorageValue> {
  day: string;
  used: number;
}

export class StoopStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The schema must exist before any RPC runs; blockConcurrencyWhile guarantees it.
    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
    });
  }

  /**
   * Liveness probe used by `/healthz`: proves the binding, the SQLite migration and
   * RPC all work without touching any state.
   */
  ping(): { ok: true; now: number } {
    return { ok: true, now: this.now() };
  }

  // --------------------------------------------------------------- api keys

  /**
   * Stores a new API key by its digest.
   *
   * The caller generates the key, hashes it and throws the plaintext away; this
   * object only ever sees `sha256`. Validation is repeated here rather than trusted
   * from the caller, because this table is what the front door authenticates
   * against.
   *
   * @throws Error for a bad name or digest, and for a duplicate id or digest.
   */
  async createApiKey(input: { id: string; name: string; sha256: string }): Promise<void> {
    const id = requireText(input.id, "id");
    const name = requireKeyName(input.name);
    const sha256 = requireDigest(input.sha256);

    if (this.#count("SELECT COUNT(*) AS n FROM api_keys WHERE id = ?", id) > 0) {
      throw new Error("An API key with that id already exists.");
    }
    if (this.#count("SELECT COUNT(*) AS n FROM api_keys WHERE sha256 = ?", sha256) > 0) {
      throw new Error("That API key already exists.");
    }

    this.#sql.exec(
      `INSERT INTO api_keys (id, name, sha256, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
      id,
      name,
      sha256,
      this.now(),
    );
  }

  /** Every key, newest first, revoked ones included. Never returns a digest. */
  async listApiKeys(): Promise<ApiKeySummary[]> {
    const rows = this.#sql
      .exec<ApiKeyRow>(
        `SELECT id, name, created_at, last_used_at, revoked_at
           FROM api_keys ORDER BY created_at DESC, rowid DESC`,
      )
      .toArray();
    return rows.map((row) => {
      const summary: ApiKeySummary = {
        id: row.id,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
      };
      if (row.last_used_at !== null) summary.lastUsedAt = new Date(row.last_used_at).toISOString();
      if (row.revoked_at !== null) summary.revokedAt = new Date(row.revoked_at).toISOString();
      return summary;
    });
  }

  /**
   * Revokes a key. The row is kept so the audit trail still resolves its name.
   *
   * @returns `true` when this call revoked it; `false` when the id is unknown or it
   * was already revoked.
   */
  async revokeApiKey(id: string): Promise<boolean> {
    const key = requireText(id, "id");
    const live = this.#count(
      "SELECT COUNT(*) AS n FROM api_keys WHERE id = ? AND revoked_at IS NULL",
      key,
    );
    if (live === 0) return false;
    this.#sql.exec(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      this.now(),
      key,
    );
    return true;
  }

  /**
   * The front door's lookup: a presented key's digest to the key behind it.
   *
   * Revoked keys never match, so revoking one takes effect on the next request.
   *
   * @param sha256 lower-case hex digest of the presented key.
   * @returns the key's id and name, or `undefined` when nothing active matches.
   */
  async matchApiKey(sha256: string): Promise<ApiKeyMatch | undefined> {
    const digest = typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
    // A malformed digest cannot match anything; answer "no" rather than throwing, so
    // a junk credential is a 401 and never a 500.
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;

    const row = this.#sql
      .exec<ApiKeyRow>(
        `SELECT id, name, created_at, last_used_at, revoked_at
           FROM api_keys WHERE sha256 = ? AND revoked_at IS NULL`,
        digest,
      )
      .toArray()[0];
    if (!row) return undefined;

    const now = this.now();
    if (row.last_used_at === null || now - row.last_used_at >= API_KEY_LAST_USED_THROTTLE_MS) {
      this.#sql.exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now, row.id);
    }
    return { id: row.id, name: row.name };
  }

  // ------------------------------------------------------------------ audit

  /** Appends one audit row. `entry.args` is scrubbed here, never by the caller. */
  async audit(entry: AuditInput): Promise<void> {
    this.#sql.exec(
      `INSERT INTO audit (ts, actor, tool, args_redacted, outcome, error, upstream, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.now(),
      entry.actor || "unknown",
      entry.tool || "unknown",
      entry.args === undefined ? null : auditArgsJson(entry.args),
      entry.outcome,
      entry.error ?? null,
      Math.max(0, Math.trunc(entry.upstream ?? 0)),
      entry.durationMs === undefined ? null : Math.max(0, Math.round(entry.durationMs)),
    );
  }

  /** The most recent audit rows, newest first. */
  async listAudit(opts: { limit?: number } = {}): Promise<AuditEntry[]> {
    const limit = clamp(opts.limit ?? 100, 1, 1000);
    const rows = this.#sql
      .exec<AuditRow>(
        `SELECT id, ts, actor, tool, args_redacted, outcome, error, upstream, duration_ms
           FROM audit ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return rows.map((row) => {
      const entry: AuditEntry = {
        id: row.id,
        ts: new Date(row.ts).toISOString(),
        actor: row.actor,
        tool: row.tool,
        outcome: row.outcome,
        upstream: row.upstream,
      };
      if (row.args_redacted !== null) entry.args = parseJson(row.args_redacted);
      if (row.error !== null) entry.error = row.error;
      if (row.duration_ms !== null) entry.durationMs = row.duration_ms;
      return entry;
    });
  }

  // ----------------------------------------------------------------- budget

  /**
   * Counts one paid upstream attempt against today's cap (UTC day), atomically.
   *
   * @param cap attempts allowed per day; `null` means no cap.
   * @returns `ok: false` without counting when the cap is already used up.
   */
  async spendUpstream(cap: number | null): Promise<SpendResult> {
    const day = utcDay(this.now());
    const used = this.#budgetUsed(day);
    if (cap !== null && used >= cap) return { ok: false, used };
    this.#sql.exec(
      `INSERT INTO budget (day, used) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET used = used + 1`,
      day,
    );
    return { ok: true, used: used + 1 };
  }

  /** Attempts used on each of the last `days` UTC days that had any, newest first. */
  async budgetHistory(days = 7): Promise<{ today: BudgetDay; recent: BudgetDay[] }> {
    const now = this.now();
    const today = utcDay(now);
    const since = utcDay(now - (clamp(days, 1, BUDGET_RETENTION_DAYS) - 1) * 86_400_000);
    const recent = this.#sql
      .exec<BudgetRow>("SELECT day, used FROM budget WHERE day >= ? ORDER BY day DESC", since)
      .toArray()
      .map((row) => ({ day: row.day, used: row.used }));
    return { today: { day: today, used: this.#budgetUsed(today) }, recent };
  }

  // ------------------------------------------------------------------ cache

  /** The cached JSON under `key`, or `null` when absent or expired. */
  async cacheGet(key: string): Promise<string | null> {
    const row = this.#sql
      .exec<CacheRow>("SELECT value, expires_at FROM cache WHERE key = ?", key)
      .toArray()[0];
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.#sql.exec("DELETE FROM cache WHERE key = ?", key);
      return null;
    }
    return row.value;
  }

  /**
   * Stores `json` under `key` for `ttlSeconds`.
   *
   * @returns `false` (and stores nothing) when the value is too large to cache.
   */
  async cachePut(key: string, json: string, ttlSeconds: number): Promise<boolean> {
    if (json.length > CACHE_VALUE_MAX) return false;
    this.#sql.exec(
      `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      json,
      this.now() + Math.max(60, ttlSeconds) * 1000,
    );
    return true;
  }

  // ------------------------------------------------------------ maintenance

  /**
   * Daily cron work: prune audit rows past {@link AUDIT_RETENTION_MS}, expired
   * cache rows, and day counters older than {@link BUDGET_RETENTION_DAYS}.
   */
  async maintain(): Promise<MaintenanceSummary> {
    const now = this.now();
    return {
      pruned: {
        audit: this.#prune("audit", "ts < ?", now - AUDIT_RETENTION_MS),
        cache: this.#prune("cache", "expires_at <= ?", now),
        budget: this.#prune("budget", "day < ?", utcDay(now - BUDGET_RETENTION_DAYS * 86_400_000)),
      },
    };
  }

  // ------------------------------------------------------------- test seam

  /** The clock. Overridden per-instance by tests via `runInDurableObject()`. */
  protected now(): number {
    return Date.now();
  }

  // --------------------------------------------------------------- internals

  get #sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  #migrate(): void {
    const sql = this.#sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_redacted TEXT,
      outcome TEXT NOT NULL,
      error TEXT,
      upstream INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS budget (
      day TEXT PRIMARY KEY,
      used INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_cache_expiry ON cache (expires_at)");
  }

  #budgetUsed(day: string): number {
    return (
      this.#sql.exec<BudgetRow>("SELECT day, used FROM budget WHERE day = ?", day).toArray()[0]
        ?.used ?? 0
    );
  }

  #count(query: string, ...bindings: SqlStorageValue[]): number {
    return this.#sql.exec<CountRow>(query, ...bindings).toArray()[0]?.n ?? 0;
  }

  /**
   * Deletes the rows of `table` matching `where` and returns how many went.
   *
   * `table` and `where` are literals from this module only, never caller input.
   */
  #prune(table: string, where: string, cutoff: number | string): number {
    const doomed = this.#count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, cutoff);
    if (doomed > 0) this.#sql.exec(`DELETE FROM ${table} WHERE ${where}`, cutoff);
    return doomed;
  }
}

/**
 * Resolves the one store Durable Object stub.
 *
 * Always go through this helper rather than calling `idFromName` inline, so the
 * single-instance invariant lives in one place.
 */
export function getStoreStub(env: Env): DurableObjectStub<StoopStore> {
  return env.STORE.get(env.STORE.idFromName(STORE_DO_NAME));
}

/** `YYYY-MM-DD` of an epoch-ms instant, UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A key name: something the operator will recognise in the list and the audit log. */
function requireKeyName(value: string): string {
  const trimmed = requireText(value, "name");
  if (trimmed.length > API_KEY_NAME_MAX) {
    throw new Error(`An API key name must be 1 to ${API_KEY_NAME_MAX} characters.`);
  }
  return trimmed;
}

/** Lower-case hex SHA-256, exactly 64 characters. */
function requireDigest(value: string): string {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error("sha256 must be a 64-character hex SHA-256 digest.");
  }
  return trimmed;
}

function requireText(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`${field} must be a non-empty string.`);
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseJson(json: string): JsonValue {
  try {
    return JSON.parse(json) as JsonValue;
  } catch {
    return json;
  }
}

/* -------------------------------------------------------------------------- */
/* Audit scrubbing                                                             */
/* -------------------------------------------------------------------------- */

const REDACTED = "[redacted]";

/** Keys whose values never reach the audit log, matched as a case-insensitive substring. */
const SENSITIVE_KEY = /token|password|secret|authorization|cookie/i;

/** Anything that looks like a credential, whatever key it arrived under. */
const TOKEN_LIKE = /^(?:[A-Za-z0-9_-]{8,}\.){2}[A-Za-z0-9_-]{8,}$|^[A-Za-z0-9_.\-=+/]{40,}$/;

/**
 * Tool arguments as stored: sensitive keys and token-shaped strings replaced, and
 * the JSON cut to {@link AUDIT_ARGS_MAX} characters. Tool arguments here are
 * places, prices and filters, so this is a guard against a future tool, not a
 * known leak.
 */
function auditArgsJson(args: unknown): string {
  const json = JSON.stringify(scrub(args, 0)) ?? "null";
  return json.length <= AUDIT_ARGS_MAX
    ? json
    : JSON.stringify({ truncated: json.slice(0, AUDIT_ARGS_MAX) });
}

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return TOKEN_LIKE.test(value) ? REDACTED : value;
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(item, depth + 1);
  }
  return out;
}
