/**
 * How a request reaches StreetEasy.
 *
 * StreetEasy sits behind PerimeterX, which blocks datacenter IPs, so a deployed
 * Worker cannot call it directly. Each provider below is one way around that, and
 * all of them take the same plain request and give back the same plain response,
 * so switching is one var (`UPSTREAM_PROVIDER`) and its secrets:
 *
 * - `zyte`: Zyte API `/v1/extract` with a custom HTTP method, body and headers.
 * - `brightdata`: Bright Data Web Unlocker's REST API (`/request`).
 * - `relay`: your own relay (`scripts/relay.mjs`) on a residential connection.
 * - `direct`: plain `fetch`, for `wrangler dev` from a home connection.
 *
 * Providers never retry and never count budget; `upstream.ts` does both.
 */

import type { Config, Env, ProviderName } from "../env";
import { AppError } from "../errors";

export interface UpstreamRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface UpstreamResponse {
  /** The target site's HTTP status, as best the provider reports it. */
  status: number;
  body: string;
}

export interface UpstreamProvider {
  readonly name: ProviderName;
  send(req: UpstreamRequest): Promise<UpstreamResponse>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Headers an unblocking service manages itself (browser identity, connection
 * details). Forwarding ours would at best be ignored and at worst make the
 * request look inconsistent, so managed providers only get the app headers.
 */
const MANAGED_HEADER = /^(host|connection|user-agent|accept-language|dnt|x-forwarded-.*|sec-.*)$/i;

export function appHeadersOnly(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !MANAGED_HEADER.test(k)));
}

export function createProvider(config: Config, env: Env, fetchImpl: FetchLike): UpstreamProvider {
  switch (config.provider) {
    case "zyte":
      return zyteProvider(requireSecret(env.ZYTE_API_KEY, "ZYTE_API_KEY", "zyte"), fetchImpl);
    case "brightdata":
      return brightDataProvider(
        requireSecret(env.BRIGHTDATA_API_KEY, "BRIGHTDATA_API_KEY", "brightdata"),
        config.brightdataZone,
        fetchImpl,
      );
    case "relay":
      return relayProvider(
        requireSecret(env.RELAY_URL, "RELAY_URL", "relay"),
        requireSecret(env.RELAY_TOKEN, "RELAY_TOKEN", "relay"),
        fetchImpl,
      );
    case "direct":
      return directProvider(fetchImpl);
  }
}

function requireSecret(value: string | undefined, name: string, provider: string): string {
  const v = value?.trim();
  if (!v) {
    throw new AppError(
      "CONFIG",
      `UPSTREAM_PROVIDER is "${provider}" but ${name} is not set.`,
      `Set it with \`npx wrangler secret put ${name}\` (or in .dev.vars for wrangler dev).`,
    );
  }
  return v;
}

/* -------------------------------------------------------------------------- */

const ZYTE_ENDPOINT = "https://api.zyte.com/v1/extract";

/**
 * Zyte API. Request: `httpResponseBody: true` with `httpRequestMethod`,
 * `httpRequestBody` (base64) and `customHttpRequestHeaders`. Response JSON
 * carries `statusCode` and `httpResponseBody` (base64). A ban Zyte could not get
 * past comes back as a non-200 from Zyte itself (520/521).
 */
export function zyteProvider(apiKey: string, fetchImpl: FetchLike): UpstreamProvider {
  return {
    name: "zyte",
    async send(req) {
      const payload: Record<string, unknown> = {
        url: req.url,
        httpResponseBody: true,
        httpRequestMethod: req.method,
        customHttpRequestHeaders: Object.entries(appHeadersOnly(req.headers)).map(
          ([name, value]) => ({ name, value }),
        ),
      };
      if (req.body !== undefined) payload.httpRequestBody = base64Encode(req.body);

      const res = await fetchImpl(ZYTE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Basic ${base64Encode(`${apiKey}:`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new AppError(
          "CONFIG",
          `Zyte rejected the API key (HTTP ${res.status}).`,
          "Check ZYTE_API_KEY.",
        );
      }
      if (res.status === 520 || res.status === 521) {
        return { status: 403, body: `zyte ban: ${text.slice(0, 300)}` };
      }
      if (!res.ok) {
        throw new AppError(
          "UPSTREAM_ERROR",
          `Zyte returned HTTP ${res.status}: ${text.slice(0, 500)}`,
          res.status === 429 ? "Zyte is rate limiting; wait and retry." : undefined,
        );
      }
      const data = JSON.parse(text) as { statusCode?: number; httpResponseBody?: string };
      return {
        status: data.statusCode ?? 200,
        body: data.httpResponseBody ? base64Decode(data.httpResponseBody) : "",
      };
    },
  };
}

/* -------------------------------------------------------------------------- */

const BRIGHTDATA_ENDPOINT = "https://api.brightdata.com/request";

/**
 * Bright Data Web Unlocker REST API with `format: "raw"`. Passing `method`,
 * `body` and `headers` through for a POST is untested against StreetEasy; run
 * `npm run smoke` before relying on it.
 */
export function brightDataProvider(
  apiKey: string,
  zone: string,
  fetchImpl: FetchLike,
): UpstreamProvider {
  return {
    name: "brightdata",
    async send(req) {
      const res = await fetchImpl(BRIGHTDATA_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          zone,
          url: req.url,
          format: "raw",
          method: req.method,
          headers: appHeadersOnly(req.headers),
          ...(req.body !== undefined ? { body: req.body } : {}),
        }),
      });
      const text = await res.text();
      if (res.status === 401) {
        throw new AppError(
          "CONFIG",
          "Bright Data rejected the API key (HTTP 401).",
          "Check BRIGHTDATA_API_KEY and BRIGHTDATA_ZONE.",
        );
      }
      const brdError = res.headers.get("x-brd-error") ?? res.headers.get("x-luminati-error");
      if (brdError && res.status >= 400) {
        throw new AppError("UPSTREAM_ERROR", `Bright Data error (HTTP ${res.status}): ${brdError}`);
      }
      return { status: res.status, body: text };
    },
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Your own relay: `POST RELAY_URL` with `Authorization: Bearer RELAY_TOKEN` and
 * the request as JSON; it answers `{ status, body }`. See scripts/relay.mjs.
 */
export function relayProvider(url: string, token: string, fetchImpl: FetchLike): UpstreamProvider {
  return {
    name: "relay",
    async send(req) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const text = await res.text();
      if (res.status === 401) {
        throw new AppError(
          "CONFIG",
          "The relay rejected RELAY_TOKEN (HTTP 401).",
          "Make RELAY_TOKEN match the relay's.",
        );
      }
      if (!res.ok) {
        throw new AppError(
          "UPSTREAM_ERROR",
          `Relay returned HTTP ${res.status}: ${text.slice(0, 300)}`,
          "Is the relay running and reachable?",
        );
      }
      const data = JSON.parse(text) as { status: number; body: string };
      return { status: data.status, body: data.body };
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Plain fetch. Only works from a residential connection (e.g. `wrangler dev` at home). */
export function directProvider(fetchImpl: FetchLike): UpstreamProvider {
  return {
    name: "direct",
    async send(req) {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}

/* -------------------------------------------------------------------------- */

export function base64Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64Decode(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
