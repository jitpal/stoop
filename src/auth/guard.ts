/**
 * Resolving the caller: the one place that turns an HTTP request into an
 * {@link Actor}.
 *
 * Two credentials reach `/mcp`:
 *
 *  - an **OAuth access token**, validated by `@cloudflare/workers-oauth-provider`
 *    before our handler runs. The provider hands us the grant's decrypted props on
 *    `ctx.props`; we only check their shape.
 *  - an **API key** (`Authorization: Bearer stoop_...`), minted by the operator at
 *    `/admin/keys` and matched here by SHA-256 against the keys stored in the
 *    `StoopStore` Durable Object.
 *
 * Every tool is read-only, so there are no scopes to check: a valid credential is
 * the whole question.
 *
 * When nothing valid is presented, answer with {@link unauthorizedResponse}: the
 * `WWW-Authenticate: Bearer resource_metadata=...` challenge is how an MCP client
 * discovers that this server speaks OAuth at all.
 */

import type { Env } from "../env";
import type { ErrorBody } from "../errors";
import { getStoreStub } from "../store/do";
import { looksLikeApiKey, sha256Hex } from "./tokens";

/** Who is calling: the audit log records `${kind}:${name}`. */
export interface Actor {
  /** `oauth` for an approved OAuth client, `bearer` for a minted API key. */
  kind: "oauth" | "bearer";
  /** The OAuth client's name, or the API key's name. */
  name: string;
}

/** The RFC 9728 metadata path the 401 challenge points at. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** Extracts the bearer credential from the `Authorization` header, if any. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * True when `value` is shaped like the props this worker stores on a grant (and
 * not, say, `{}`).
 */
export function isActorProps(value: unknown): value is Actor {
  if (typeof value !== "object" || value === null) return false;
  const props = value as Record<string, unknown>;
  if (typeof props.name !== "string" || props.name.length === 0) return false;
  return props.kind === "oauth" || props.kind === "bearer";
}

/**
 * Resolves a presented bearer credential against the API keys in the Durable Object.
 *
 * The `stoop_` prefix gate is deliberate: every minted key carries it, so anything
 * else cannot be one and must not cost a Durable Object round trip. Junk credentials
 * and OAuth tokens that reached here by mistake are rejected on a string comparison.
 *
 * A Durable Object failure is treated as "no match": a broken store must produce a
 * 401 with the OAuth challenge, never a 500 that tells an MCP client the server is
 * down when the real answer is "authenticate".
 *
 * @returns an `Actor` of kind `"bearer"`, or `null` when nothing active matches.
 */
export async function matchApiKey(env: Env, presentedToken: string): Promise<Actor | null> {
  const token = presentedToken.trim();
  if (!looksLikeApiKey(token)) return null;
  try {
    const match = await getStoreStub(env).matchApiKey(await sha256Hex(token));
    return match ? { kind: "bearer", name: match.name } : null;
  } catch (error) {
    // Never the key, never the digest: only why the lookup could not be made.
    console.warn(
      "auth: API key lookup failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}

/**
 * Resolves the caller of a protected request.
 *
 * Order: valid props from the OAuth provider (which also covers API keys, through
 * `resolveExternalToken`), then an API key from the `Authorization` header, then
 * nothing. The header fallback means this behaves the same whether it is called
 * from inside the provider's `apiHandler` or on a raw request in a test.
 *
 * @returns the `Actor`, or `null` when no valid credential was presented.
 */
export async function resolveActor(
  request: Request,
  env: Env,
  oauthProps?: unknown,
): Promise<Actor | null> {
  if (isActorProps(oauthProps)) return { kind: oauthProps.kind, name: oauthProps.name };
  const token = bearerToken(request);
  if (!token) return null;
  return matchApiKey(env, token);
}

/**
 * The 401 every unauthenticated request to a protected route gets.
 *
 * The `resource_metadata` parameter is the whole point: an MCP client reads it,
 * fetches the RFC 9728 document the OAuth provider serves at that path, and starts
 * the authorization flow on its own.
 */
export function unauthorizedResponse(baseUrl: string): Response {
  const resourceMetadata = `${baseUrl.replace(/\/+$/, "")}${PROTECTED_RESOURCE_METADATA_PATH}`;
  const body: ErrorBody = {
    error: {
      code: "UNAUTHORIZED",
      message: "No valid credential was presented.",
      hint: "Send 'Authorization: Bearer <key>' with an API key the operator minted at /admin/keys, or complete the OAuth flow advertised by the WWW-Authenticate header.",
    },
  };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadata}"`,
    },
  });
}

/**
 * The absolute origin to use in links, OAuth metadata and hints:
 * `PUBLIC_BASE_URL` when it is set and parseable, otherwise the request's origin.
 *
 * This deliberately does not go through `parseConfig()`: it has to keep working
 * when configuration is broken, which is exactly when the admin pages and the 401
 * challenge matter most.
 */
export function baseUrlFrom(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the request's own origin.
    }
  }
  return new URL(request.url).origin;
}

/** `c.executionCtx` where there is one; Hono throws when the app was invoked without it. */
export function executionContextOf(c: { executionCtx: unknown } | unknown): unknown {
  if (typeof c !== "object" || c === null) return undefined;
  try {
    return (c as { executionCtx: unknown }).executionCtx;
  } catch {
    return undefined;
  }
}

/** `ctx.props` when the provider set it, without assuming the context has one. */
export function propsFromContext(ctx: unknown): unknown {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  return (ctx as { props?: unknown }).props;
}
