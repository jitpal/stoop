import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/env";
import {
  brightDataProvider,
  createProvider,
  relayProvider,
  zyteProvider,
} from "../src/upstream/providers";
import { createUpstream, isBotChallenge } from "../src/upstream/upstream";
import { b64, fakeFetch, memoryBudget, unb64 } from "./helpers/fakes";

const req = {
  url: "https://api-v6.streeteasy.com/",
  method: "POST" as const,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0",
    "Sec-Fetch-Mode": "cors",
    Origin: "https://streeteasy.com",
  },
  body: '{"query":"{ x }"}',
};

describe("zyte provider", () => {
  it("sends method, base64 body and app headers only, and decodes the answer", async () => {
    let seen: Record<string, unknown> = {};
    let auth = "";
    const f = fakeFetch([
      {
        match: /api\.zyte\.com/,
        respond: (_u, init) => {
          seen = JSON.parse(String(init?.body));
          auth = new Headers(init?.headers).get("Authorization") ?? "";
          return Response.json({ statusCode: 200, httpResponseBody: b64('{"data":{"ok":"é"}}') });
        },
      },
    ]);
    const res = await zyteProvider("KEY", f).send(req);
    expect(res).toEqual({ status: 200, body: '{"data":{"ok":"é"}}' });
    expect(auth).toBe(`Basic ${btoa("KEY:")}`);
    expect(seen.httpRequestMethod).toBe("POST");
    expect(unb64(seen.httpRequestBody as string)).toBe(req.body);
    expect(seen.httpResponseBody).toBe(true);
    const names = (seen.customHttpRequestHeaders as { name: string }[]).map((h) => h.name);
    expect(names).toEqual(["Content-Type", "Origin"]);
  });

  it("maps a Zyte ban to a 403 so it is retried", async () => {
    const f = fakeFetch([
      { match: /zyte/, respond: () => new Response("banned", { status: 520 }) },
    ]);
    const res = await zyteProvider("KEY", f).send(req);
    expect(res.status).toBe(403);
  });

  it("reports a bad key as a config error", async () => {
    const f = fakeFetch([{ match: /zyte/, respond: () => new Response("no", { status: 401 }) }]);
    await expect(zyteProvider("KEY", f).send(req)).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("other providers", () => {
  it("bright data posts zone, url, method and body", async () => {
    let seen: Record<string, unknown> = {};
    const f = fakeFetch([
      {
        match: /api\.brightdata\.com\/request/,
        respond: (_u, init) => {
          seen = JSON.parse(String(init?.body));
          return new Response('{"data":{}}');
        },
      },
    ]);
    const res = await brightDataProvider("K", "zone1", f).send(req);
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      zone: "zone1",
      url: req.url,
      format: "raw",
      method: "POST",
      body: req.body,
    });
  });

  it("relay forwards the request as JSON with its token", async () => {
    const f = fakeFetch([
      {
        match: /relay\.example/,
        respond: (_u, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer T");
          expect(JSON.parse(String(init?.body)).url).toBe(req.url);
          return Response.json({ status: 200, body: "ok" });
        },
      },
    ]);
    expect(await relayProvider("https://relay.example/r", "T", f).send(req)).toEqual({
      status: 200,
      body: "ok",
    });
  });

  it("createProvider needs the provider's secret", () => {
    const config = parseConfig({ UPSTREAM_PROVIDER: "relay" } as never);
    expect(() => createProvider(config, { RELAY_URL: "" } as never, fetch)).toThrowError(
      /RELAY_URL/,
    );
    expect(() => parseConfig({ UPSTREAM_PROVIDER: "nope" } as never)).toThrowError(
      /UPSTREAM_PROVIDER/,
    );
  });
});

describe("upstream", () => {
  it("retries a bot challenge and counts every attempt", async () => {
    let n = 0;
    const provider = {
      name: "zyte" as const,
      send: async () =>
        ++n === 1 ? { status: 403, body: "px-captcha" } : { status: 200, body: "{}" },
    };
    const budget = memoryBudget();
    const up = createUpstream(provider, budget, 2, async () => {});
    expect(await up.send(req)).toEqual({ status: 200, body: "{}" });
    expect(budget.used).toBe(2);
  });

  it("gives up after the retries with UPSTREAM_BLOCKED", async () => {
    const provider = { name: "direct" as const, send: async () => ({ status: 403, body: "" }) };
    const up = createUpstream(provider, memoryBudget(), 1, async () => {});
    await expect(up.send(req)).rejects.toMatchObject({ code: "UPSTREAM_BLOCKED" });
  });

  it("stops at the daily cap before sending", async () => {
    let sent = 0;
    const provider = {
      name: "zyte" as const,
      send: async () => {
        sent++;
        return { status: 200, body: "{}" };
      },
    };
    const up = createUpstream(provider, memoryBudget(0), 1, async () => {});
    await expect(up.send(req)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(sent).toBe(0);
  });

  it("recognizes challenge pages served with 200", () => {
    expect(isBotChallenge({ status: 200, body: "<html>Press & Hold to confirm</html>" })).toBe(
      true,
    );
    expect(isBotChallenge({ status: 200, body: '{"data":{}}' })).toBe(false);
  });
});
