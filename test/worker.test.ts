/**
 * End to end through the real Worker (OAuth provider + Hono + MCP handler),
 * using an API key minted into the store. Only tools that don't leave the Worker
 * are called.
 */

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getStoreStub } from "../src/store/do";
import { mintKey, testEnv } from "./helpers/auth";

const worker = SELF;
let KEY = "";

beforeAll(async () => {
  KEY = (await mintKey("worker-tests")).token;
});

async function rpc(method: string, params: unknown, auth = `Bearer ${KEY}`) {
  const res = await worker.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        // Real requests always carry Host; SELF.fetch doesn't add one.
        Host: "localhost",
        Authorization: auth,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "null");
  return {
    status: res.status,
    body: JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown },
  };
}

describe("worker", () => {
  it("serves health", async () => {
    const res = await worker.fetch(new Request("http://localhost/healthz"));
    const body = (await res.json()) as { ok: boolean; provider: string };
    expect(body).toMatchObject({ ok: true, provider: "zyte" });
  });

  it("rejects an unknown API key", async () => {
    const { status } = await rpc("tools/list", {}, "Bearer stoop_not-a-real-key");
    expect(status).toBe(401);
  });

  it("rejects /mcp without a credential and points at OAuth metadata", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/mcp", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("lists the tools with an API key", async () => {
    const { status, body } = await rpc("tools/list", {});
    expect(status).toBe(200);
    const tools = (body.result?.tools ?? []) as { name: string }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "search_rentals",
      "get_listing",
      "check_building",
      "find_station",
      "list_neighborhoods",
      "list_amenities",
      "stoop_status",
    ]);
  });

  it("answers find_station", async () => {
    const { body } = await rpc("tools/call", {
      name: "find_station",
      arguments: { query: "Atlantic Terminal" },
    });
    const result = body.result as {
      content: { text: string }[];
      structuredContent: { matches: { name: string }[] };
    };
    expect(result.structuredContent.matches[0]?.name).toBe("Atlantic Av-Barclays Ctr");
    expect(result.content[0]?.text).toContain("Atlantic Av-Barclays Ctr");
  });

  it("returns tool errors with a code and hint", async () => {
    const { body } = await rpc("tools/call", {
      name: "search_rentals",
      arguments: { neighborhoods: ["Atlantis"] },
    });
    const result = body.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ code: "AREA_NOT_FOUND" });
  });

  it("audits each tool call with the key's name", async () => {
    await rpc("tools/call", { name: "find_station", arguments: { query: "Bedford Av" } });
    const [row] = await getStoreStub(testEnv).listAudit({ limit: 1 });
    expect(row).toMatchObject({
      actor: "bearer:worker-tests",
      tool: "find_station",
      args: { query: "Bedford Av" },
      outcome: "ok",
      upstream: 0,
    });
  });

  it("audits a failed tool call with its error code", async () => {
    await rpc("tools/call", { name: "search_rentals", arguments: { neighborhoods: ["Atlantis"] } });
    const [row] = await getStoreStub(testEnv).listAudit({ limit: 1 });
    expect(row?.outcome).toBe("error");
    expect(row?.error).toMatch(/^AREA_NOT_FOUND: /);
  });
});
