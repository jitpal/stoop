/**
 * The operator flow through the real Worker: sign in with ADMIN_PASSWORD, mint an
 * API key at /admin/keys, use it on /mcp, see the call in the audit log, revoke it.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_COOKIE, CSRF_COOKIE } from "../src/auth/admin-session";
import { callbackSource } from "../src/auth/oauth";
import { clearFailures } from "../src/auth/rate-limit";
import { adminJar, cookieHeader, cookiesFrom, HTML_HEADERS, hiddenField } from "./helpers/auth";

const BASE = "http://localhost";

function get(path: string, jar: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    headers: { ...HTML_HEADERS, Cookie: cookieHeader(jar) },
    redirect: "manual",
  });
}

function post(path: string, form: Record<string, string>, jar: Record<string, string>) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...HTML_HEADERS, Cookie: cookieHeader(jar) },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
}

function mcp(method: string, params: unknown, token: string) {
  return SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Host: "localhost",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("admin sign-in", () => {
  it("sends a signed-out browser to the login page", async () => {
    const res = await get("/admin/keys");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/login?next=%2Fadmin%2Fkeys");
  });

  it("answers a script with a 401 instead of a login page", async () => {
    const res = await SELF.fetch(`${BASE}/admin/audit?format=json`);
    expect(res.status).toBe(401);
  });

  it("refuses a wrong password and signs in with the right one", async () => {
    clearFailures();
    const form = await get("/admin/login?next=/admin/keys");
    const jar = cookiesFrom(form);
    const csrf = hiddenField(await form.text(), "csrf");
    expect(jar[CSRF_COOKIE]).toBeTruthy();

    const wrong = await post("/admin/login", { csrf, next: "/admin/keys", password: "nope" }, jar);
    expect(wrong.status).toBe(401);

    const retry = cookiesFrom(wrong);
    const retryCsrf = hiddenField(await wrong.text(), "csrf");
    const right = await post(
      "/admin/login",
      { csrf: retryCsrf, next: "/admin/keys", password: "test-admin-password" },
      retry,
    );
    expect(right.status).toBe(303);
    expect(right.headers.get("Location")).toBe("/admin/keys");
    expect(cookiesFrom(right)[ADMIN_COOKIE]).toBeTruthy();
  });

  it("refuses a login post without the form's CSRF token", async () => {
    const res = await post("/admin/login", { password: "test-admin-password" }, {});
    expect(res.status).toBe(403);
  });
});

describe("api keys and audit", () => {
  it("mints a key that works on /mcp, audits its use, and revokes it", async () => {
    const jar = await adminJar();

    const page = await get("/admin/keys", jar);
    expect(page.status).toBe(200);
    const csrf = hiddenField(await page.text(), "csrf");
    const withCsrf = { ...jar, ...cookiesFrom(page) };

    const created = await post("/admin/keys", { csrf, name: "claude-code" }, withCsrf);
    expect(created.status).toBe(200);
    const html = await created.text();
    const token = /<pre id="key">(stoop_[A-Za-z0-9_-]+)<\/pre>/.exec(html)?.[1];
    expect(token).toBeTruthy();

    const listed = await mcp("tools/list", {}, token as string);
    expect(listed.status).toBe(200);
    await mcp(
      "tools/call",
      { name: "find_station", arguments: { query: "Bedford Av" } },
      token as string,
    );

    const audit = await SELF.fetch(`${BASE}/admin/audit?format=json&limit=5`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    const { entries } = (await audit.json()) as {
      entries: { actor: string; tool: string; args?: unknown }[];
    };
    expect(entries[0]).toMatchObject({ actor: "bearer:claude-code", tool: "find_station" });
    expect(entries.some((e) => e.tool === "admin.keys.create")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(token);

    const keysPage = await get("/admin/keys", jar);
    const keysHtml = await keysPage.text();
    const id = /action="\/admin\/keys\/([^/]+)\/revoke"/.exec(keysHtml)?.[1];
    expect(id).toBeTruthy();
    const revoked = await post(
      `/admin/keys/${id}/revoke`,
      { csrf: hiddenField(keysHtml, "csrf") },
      { ...jar, ...cookiesFrom(keysPage) },
    );
    expect(revoked.status).toBe(303);

    const after = await mcp("tools/list", {}, token as string);
    expect(after.status).toBe(401);
  });

  it("refuses to mint without the form's CSRF token", async () => {
    const res = await post("/admin/keys", { name: "sneaky" }, await adminJar());
    expect(res.status).toBe(403);
  });

  it("shows the dashboard with the MCP address and today's usage", async () => {
    const res = await get("/admin", await adminJar());
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("http://localhost/mcp");
    expect(html).toContain("Used today");
  });
});

describe("oauth approval", () => {
  async function pkce() {
    const verifier = "v".repeat(64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { verifier, challenge };
  }

  it("approves a client with the password, signs the browser in, and audits as oauth", async () => {
    clearFailures();
    const redirectUri = "http://localhost:9999/callback";
    const reg = await SELF.fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirectUri,
      scope: "read",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const form = await get(`/oauth/authorize?${query}`);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain("Test Client");
    // Chrome applies form-action to the redirect after Approve, so the client's
    // callback origin must be allowed in both copies of the policy.
    expect(form.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self' http://localhost:9999;",
    );
    const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(meta).toContain("form-action &#39;self&#39; http://localhost:9999");
    expect(meta).not.toContain("frame-ancestors");

    const approved = await post(
      "/oauth/authorize",
      {
        csrf: hiddenField(html, "csrf"),
        auth_request: hiddenField(html, "auth_request"),
        password: "test-admin-password",
      },
      cookiesFrom(form),
    );
    expect(approved.status).toBe(302);
    expect(cookiesFrom(approved)[ADMIN_COOKIE]).toBeTruthy();
    const location = new URL(approved.headers.get("Location") ?? "");
    expect(location.searchParams.get("state")).toBe("s1");
    const code = location.searchParams.get("code") ?? "";

    const tokenRes = await SELF.fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    await mcp("tools/call", { name: "list_amenities", arguments: {} }, access_token);
    const audit = await SELF.fetch(`${BASE}/admin/audit?format=json&limit=1`, {
      headers: { Cookie: cookieHeader(await adminJar()) },
    });
    const { entries } = (await audit.json()) as { entries: { actor: string; tool: string }[] };
    expect(entries[0]).toMatchObject({ actor: "oauth:Test Client", tool: "list_amenities" });
  });

  it("refuses an approval post that did not come from the form", async () => {
    clearFailures();
    const res = await post("/oauth/authorize", { csrf: "x", auth_request: "y", password: "z" }, {});
    expect(res.status).toBe(403);
  });
});

describe("callbackSource", () => {
  it("allows the callback's origin, or an app's scheme", () => {
    expect(callbackSource("https://agent.meta.ai/oauth/callback?x=1")).toBe(
      "https://agent.meta.ai",
    );
    expect(callbackSource("http://localhost:33418/callback")).toBe("http://localhost:33418");
    expect(callbackSource("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor:");
    expect(callbackSource("not a url")).toBeNull();
  });

  it("keeps admin pages at form-action 'self'", async () => {
    const res = await get("/admin/login");
    expect(res.headers.get("Content-Security-Policy")).toContain("form-action 'self';");
  });
});
