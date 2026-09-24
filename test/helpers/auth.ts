/**
 * Auth fixtures: minting an API key straight into the store, and the cookie
 * bookkeeping a browser would do for us (CSRF cookie out, form field in, session
 * cookie back).
 */

import { env } from "cloudflare:test";
import { ADMIN_COOKIE, adminSessionCookie } from "../../src/auth/admin-session";
import { generateApiKey } from "../../src/auth/tokens";
import type { Env } from "../../src/env";
import { getStoreStub } from "../../src/store/do";

/** The worker bindings, typed as the worker sees them. */
export const testEnv = env as unknown as Env;

/** Mints a key the way `/admin/keys` does and returns its plaintext. */
export async function mintKey(name = "tests"): Promise<{ id: string; token: string }> {
  const { token, sha256 } = await generateApiKey();
  const id = crypto.randomUUID();
  await getStoreStub(testEnv).createApiKey({ id, name, sha256 });
  return { id, token };
}

/** Every `name=value` pair from a response's `Set-Cookie` headers. */
export function cookiesFrom(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0) out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1));
  }
  return out;
}

/** Serialises a cookie jar into a `Cookie` request header. */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

/** The `value` of `<input ... name="NAME" value="...">` in a rendered page. */
export function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match?.[1] ?? "";
}

/** Headers a browser sends when navigating. */
export const HTML_HEADERS = { Accept: "text/html,application/xhtml+xml" };

/** A cookie jar holding a valid admin session, signed as `POST /admin/login` would. */
export async function adminJar(): Promise<Record<string, string>> {
  const header = await adminSessionCookie(testEnv);
  const pair = (header ?? "").split(";")[0] ?? "";
  const index = pair.indexOf("=");
  return { [ADMIN_COOKIE]: decodeURIComponent(pair.slice(index + 1)) };
}
