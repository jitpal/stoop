/**
 * Bindings and configuration.
 *
 * Everything in `vars` arrives as a string; `parseConfig` validates it once per
 * request so a secret or var change applies without a redeploy.
 */

import { AppError } from "./errors";
import type { StoopStore } from "./store/do";

export const VERSION = "0.1.0";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** API keys, audit log, daily upstream counter and response cache. */
  STORE: DurableObjectNamespace<StoopStore>;

  UPSTREAM_PROVIDER?: string;
  MAX_UPSTREAM_REQUESTS_PER_DAY?: string;
  UPSTREAM_MAX_RETRIES?: string;
  MAX_PAGES_PER_SEARCH?: string;
  BRIGHTDATA_ZONE?: string;
  PUBLIC_BASE_URL?: string;

  ADMIN_PASSWORD?: string;
  COOKIE_SIGNING_KEY?: string;
  ZYTE_API_KEY?: string;
  BRIGHTDATA_API_KEY?: string;
  RELAY_URL?: string;
  RELAY_TOKEN?: string;
  SOCRATA_APP_TOKEN?: string;
}

export const PROVIDERS = ["zyte", "brightdata", "relay", "direct"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface Config {
  provider: ProviderName;
  /** `null` = unlimited. */
  maxUpstreamPerDay: number | null;
  maxRetries: number;
  maxPagesPerSearch: number;
  brightdataZone: string;
  publicBaseUrl: string | null;
  socrataAppToken: string | null;
}

export function parseConfig(env: Env): Config {
  const provider = (env.UPSTREAM_PROVIDER || "zyte").trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new AppError(
      "CONFIG",
      `UPSTREAM_PROVIDER is "${provider}", which is not one of ${PROVIDERS.join(", ")}.`,
      "Fix the UPSTREAM_PROVIDER var in wrangler.jsonc and redeploy.",
    );
  }
  const cap = (env.MAX_UPSTREAM_REQUESTS_PER_DAY ?? "300").trim().toLowerCase();
  return {
    provider: provider as ProviderName,
    maxUpstreamPerDay: cap === "unlimited" ? null : intVar("MAX_UPSTREAM_REQUESTS_PER_DAY", cap, 0),
    maxRetries: intVar("UPSTREAM_MAX_RETRIES", env.UPSTREAM_MAX_RETRIES ?? "2", 0, 5),
    maxPagesPerSearch: intVar("MAX_PAGES_PER_SEARCH", env.MAX_PAGES_PER_SEARCH ?? "3", 1, 10),
    brightdataZone: env.BRIGHTDATA_ZONE?.trim() || "web_unlocker1",
    publicBaseUrl: env.PUBLIC_BASE_URL?.trim() || null,
    socrataAppToken: env.SOCRATA_APP_TOKEN?.trim() || null,
  };
}

function intVar(name: string, raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(
      "CONFIG",
      `${name} is "${raw}"; expected an integer from ${min} to ${max === Number.MAX_SAFE_INTEGER ? "∞" : max}.`,
      `Fix the ${name} var in wrangler.jsonc and redeploy.`,
    );
  }
  return n;
}
