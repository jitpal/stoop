/**
 * stoop, Worker entry point.
 *
 * Unofficial NYC apartment search for AI agents. Not affiliated with StreetEasy.
 *
 *   1. OAuthProvider wraps the app: it serves /oauth/token, /oauth/register and
 *      the .well-known metadata, and only lets /mcp through with a valid OAuth
 *      token or an API key minted at /admin/keys (props land on ctx.props).
 *   2. Hono serves the rest: landing page, /healthz, the OAuth approval page,
 *      /admin/*, /mcp.
 *   3. The `StoopStore` Durable Object holds the state: API keys, the audit log,
 *      the daily upstream counter and the response cache.
 */

import { Hono } from "hono";
import { adminRoutes } from "./auth/admin-session";
import { createOAuthProvider, landingRoutes, oauthRoutes } from "./auth/oauth";
import { storeCache } from "./cache";
import { StoopService } from "./core/service";
import { type Env, parseConfig, VERSION } from "./env";
import { statusFor, toErrorBody } from "./errors";
import { AREAS_BUILT_AT } from "./geo/areas";
import { STATIONS_FEED } from "./geo/stations";
import { adminPages } from "./http/admin";
import { mountMcp, type RequestServices } from "./mcp/server";
import { getStoreStub } from "./store/do";
import { StreetEasyClient } from "./streeteasy/client";
import { createProvider } from "./upstream/providers";
import { createUpstream, meteredBudget, storeBudget } from "./upstream/upstream";

type AppEnv = { Bindings: Env };

/** One service per request, so var and secret changes apply without a redeploy. */
export function buildService(
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): RequestServices {
  const config = parseConfig(env);
  const store = getStoreStub(env);
  const budget = meteredBudget(storeBudget(store, config.maxUpstreamPerDay));
  let client: StreetEasyClient | undefined;
  const service = new StoopService({
    config,
    budget,
    fetch: fetchImpl,
    cache: storeCache(store),
    streeteasy: () => {
      client ??= new StreetEasyClient(
        createUpstream(createProvider(config, env, fetchImpl), budget, config.maxRetries),
      );
      return client;
    },
  });
  return { service, upstreamSpent: () => budget.spent };
}

const app = new Hono<AppEnv>();

app.route("/", landingRoutes());

app.get("/healthz", async (c) => {
  const problems: string[] = [];
  let provider: string | null = null;
  try {
    const config = parseConfig(c.env);
    provider = config.provider;
    createProvider(config, c.env, fetch);
  } catch (err) {
    problems.push(toErrorBody(err).error.message);
  }
  if (!c.env.ADMIN_PASSWORD?.trim())
    problems.push("ADMIN_PASSWORD is not set, so /admin and OAuth approval are disabled.");
  if (!c.env.COOKIE_SIGNING_KEY?.trim())
    problems.push("COOKIE_SIGNING_KEY is not set, so /admin and OAuth approval are disabled.");
  try {
    await getStoreStub(c.env).ping();
  } catch (err) {
    problems.push(`The store Durable Object did not answer: ${toErrorBody(err).error.message}`);
  }
  return c.json(
    {
      ok: problems.length === 0,
      version: VERSION,
      provider,
      problems,
      data: {
        stations_feed: STATIONS_FEED,
        areas_built: AREAS_BUILT_AT,
      },
    },
    problems.length ? 503 : 200,
  );
});

/* OAuth approval form and admin pages (the admin cookie, from ADMIN_PASSWORD) */
app.route("/", oauthRoutes());
app.route("/", adminRoutes());
app.route("/", adminPages());

/* The agent surface */
mountMcp(app, { build: (env) => buildService(env), audit: (env) => getStoreStub(env) });

app.onError((err, c) => c.json(toErrorBody(err), statusFor(err) as 500));
app.notFound((c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
        hint: "The MCP endpoint is /mcp.",
      },
    },
    404,
  ),
);

const handler = { fetch: app.fetch } satisfies ExportedHandler<Env>;
const provider = createOAuthProvider(handler);

/** Daily maintenance: prune old audit rows, expired cache rows and old counters. Never throws. */
async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    const summary = await getStoreStub(env).maintain();
    console.log("store:maintain", JSON.stringify(summary));
  } catch (err) {
    console.error("store:maintain failed", JSON.stringify(toErrorBody(err)));
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return provider.fetch(request, env as never, ctx);
  },
  scheduled,
} satisfies ExportedHandler<Env>;

/** The Durable Object class must be exported from the entry point for the binding to resolve. */
export { StoopStore } from "./store/do";
export { app };
