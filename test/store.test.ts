/**
 * The `StoopStore` Durable Object: API keys, audit log, daily budget, cache.
 *
 * Each test gets its own instance by name, and the clock is pinned by overriding
 * the protected `now()` on the live instance (see the class docs).
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/tokens";
import type { StoopStore } from "../src/store/do";
import { meteredBudget, storeBudget } from "../src/upstream/upstream";
import { testEnv } from "./helpers/auth";

let counter = 0;

function freshStore(label: string): DurableObjectStub<StoopStore> {
  counter += 1;
  return testEnv.STORE.getByName(`test-${label}-${counter}`);
}

async function setClock(stub: DurableObjectStub<StoopStore>, at: number): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { now(): number }).now = () => at;
  });
}

/**
 * The message a Durable Object RPC rejected with. Awaiting in a try/catch rather
 * than `expect(...).rejects`, which leaves the RPC promise's rejection unhandled.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to reject, but it resolved");
}

const DIGEST = "a".repeat(64);
const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

describe("api keys", () => {
  it("matches a live key by digest and never returns the digest", async () => {
    const store = freshStore("keys");
    await store.createApiKey({ id: "k1", name: "laptop", sha256: DIGEST });
    expect(await store.matchApiKey(DIGEST)).toEqual({ id: "k1", name: "laptop" });
    const [listed] = await store.listApiKeys();
    expect(listed).toMatchObject({ id: "k1", name: "laptop" });
    expect(JSON.stringify(listed)).not.toContain(DIGEST);
    expect(listed?.lastUsedAt).toBeDefined();
  });

  it("stops matching once revoked, and keeps the row", async () => {
    const store = freshStore("revoke");
    await store.createApiKey({ id: "k1", name: "laptop", sha256: DIGEST });
    expect(await store.revokeApiKey("k1")).toBe(true);
    expect(await store.revokeApiKey("k1")).toBe(false);
    expect(await store.matchApiKey(DIGEST)).toBeUndefined();
    expect((await store.listApiKeys())[0]?.revokedAt).toBeDefined();
  });

  it("refuses a duplicate digest and a malformed one", async () => {
    const store = freshStore("dupe");
    await store.createApiKey({ id: "k1", name: "a", sha256: DIGEST });
    expect(await rejection(store.createApiKey({ id: "k2", name: "b", sha256: DIGEST }))).toMatch(
      /already exists/,
    );
    expect(await rejection(store.createApiKey({ id: "k3", name: "c", sha256: "nope" }))).toMatch(
      /64-character/,
    );
    expect(await store.listApiKeys()).toHaveLength(1);
    expect(await store.matchApiKey("nope")).toBeUndefined();
  });

  it("matches the digest of a real minted key", async () => {
    const store = freshStore("real");
    const token = "stoop_example-token";
    await store.createApiKey({ id: "k1", name: "real", sha256: await sha256Hex(token) });
    expect(await store.matchApiKey(await sha256Hex(token))).toMatchObject({ name: "real" });
  });
});

describe("audit", () => {
  it("lists newest first and scrubs token-shaped and sensitive values", async () => {
    const store = freshStore("audit");
    await store.audit({
      actor: "bearer:a",
      tool: "find_station",
      args: { query: "x" },
      outcome: "ok",
    });
    await store.audit({
      actor: "bearer:a",
      tool: "search_rentals",
      args: { near_place: "Prospect Park", password: "hunter2", blob: "A".repeat(60) },
      outcome: "error",
      error: "BUDGET_EXCEEDED: cap",
      upstream: 3,
      durationMs: 1234,
    });
    const [latest, first] = await store.listAudit();
    expect(first?.tool).toBe("find_station");
    expect(latest).toMatchObject({
      tool: "search_rentals",
      outcome: "error",
      error: "BUDGET_EXCEEDED: cap",
      upstream: 3,
      durationMs: 1234,
      args: { near_place: "Prospect Park", password: "[redacted]", blob: "[redacted]" },
    });
  });

  it("prunes rows past 90 days", async () => {
    const store = freshStore("prune");
    await setClock(store, T0);
    await store.audit({ actor: "a", tool: "old", args: {}, outcome: "ok" });
    await setClock(store, T0 + 91 * 86_400_000);
    await store.audit({ actor: "a", tool: "new", args: {}, outcome: "ok" });
    const { pruned } = await store.maintain();
    expect(pruned.audit).toBe(1);
    expect((await store.listAudit()).map((r) => r.tool)).toEqual(["new"]);
  });
});

describe("budget", () => {
  it("is exact under concurrency: never more than the cap", async () => {
    const store = freshStore("budget");
    const results = await Promise.all(Array.from({ length: 12 }, () => store.spendUpstream(5)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect((await store.budgetHistory(1)).today.used).toBe(5);
  });

  it("resets on a new UTC day and keeps recent days", async () => {
    const store = freshStore("days");
    await setClock(store, T0);
    await store.spendUpstream(1);
    expect((await store.spendUpstream(1)).ok).toBe(false);
    await setClock(store, T0 + 86_400_000);
    expect((await store.spendUpstream(1)).ok).toBe(true);
    const history = await store.budgetHistory(7);
    expect(history.today).toEqual({ day: "2026-09-25", used: 1 });
    expect(history.recent).toEqual([
      { day: "2026-09-25", used: 1 },
      { day: "2026-09-24", used: 1 },
    ]);
  });

  it("surfaces BUDGET_EXCEEDED through storeBudget and meters spends", async () => {
    const budget = meteredBudget(storeBudget(freshStore("adapter"), 2));
    await budget.spend();
    await budget.spend();
    await expect(budget.spend()).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(budget.spent).toBe(2);
    expect(await budget.status()).toMatchObject({ used: 2, cap: 2 });
  });

  it("has no cap when the cap is null", async () => {
    const store = freshStore("unlimited");
    for (let i = 0; i < 3; i++) expect((await store.spendUpstream(null)).ok).toBe(true);
  });
});

describe("cache", () => {
  it("returns a value until it expires", async () => {
    const store = freshStore("cache");
    await setClock(store, T0);
    await store.cachePut("k", JSON.stringify({ a: 1 }), 120);
    expect(await store.cacheGet("k")).toBe('{"a":1}');
    await setClock(store, T0 + 121_000);
    expect(await store.cacheGet("k")).toBeNull();
  });

  it("overwrites, prunes expired rows, and skips oversized values", async () => {
    const store = freshStore("cache2");
    await setClock(store, T0);
    await store.cachePut("k", '"one"', 60);
    await store.cachePut("k", '"two"', 3600);
    await store.cachePut("gone", '"x"', 60);
    expect(await store.cacheGet("k")).toBe('"two"');
    expect(await store.cachePut("big", `"${"x".repeat(1_600_000)}"`, 60)).toBe(false);
    await setClock(store, T0 + 120_000);
    expect((await store.maintain()).pruned.cache).toBe(1);
    expect(await store.cacheGet("k")).toBe('"two"');
  });
});

describe("binding", () => {
  it("answers ping on the default instance", async () => {
    const stub = env.STORE.getByName("store:default");
    expect(await stub.ping()).toMatchObject({ ok: true });
  });
});
