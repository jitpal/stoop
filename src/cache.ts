/**
 * A small JSON cache over the store Durable Object.
 *
 * Cached so that repeat questions don't spend upstream requests: search pages
 * for 15 minutes, listing details for 6 hours, public records for a day, and
 * building ids (address → BBL/BIN) for 90 days, since those don't change.
 */

export const TTL = {
  searchPage: 15 * 60,
  listing: 6 * 60 * 60,
  records: 24 * 60 * 60,
  buildingId: 90 * 24 * 60 * 60,
  geocode: 30 * 24 * 60 * 60,
} as const;

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** The slice of the store Durable Object the cache uses. */
export interface CacheStore {
  cacheGet(key: string): Promise<string | null>;
  cachePut(key: string, json: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * A cache backed by the store's `cache` table. Failures are logged and treated as a
 * miss: a broken cache must cost an upstream request, never fail a tool call.
 */
export function storeCache(store: CacheStore): Cache {
  return {
    async get<T>(key: string) {
      try {
        const json = await store.cacheGet(key);
        return json === null ? null : (JSON.parse(json) as T);
      } catch (err) {
        console.warn("cache: get failed", key, err instanceof Error ? err.message : err);
        return null;
      }
    },
    async put(key, value, ttlSeconds) {
      try {
        await store.cachePut(key, JSON.stringify(value), ttlSeconds);
      } catch (err) {
        console.warn("cache: put failed", key, err instanceof Error ? err.message : err);
      }
    },
  };
}

/** Memoizes `load` under `key`; `null`/`undefined` results are not cached. */
export async function cached<T>(
  cache: Cache,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null) return hit;
  const value = await load();
  if (value !== null && value !== undefined) await cache.put(key, value, ttlSeconds);
  return value;
}

/** Short stable key from arbitrary JSON (FNV-1a, hex). */
export function hashKey(value: unknown): string {
  const s = JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
