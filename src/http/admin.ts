/**
 * The operator's pages: status, API keys, audit log.
 *
 * Everything here is behind {@link requireAdmin}, which accepts only the
 * `stoop_admin` cookie: these are operator pages, driven from a browser.
 *
 * `/admin/keys` mints the API keys agents authenticate with. A key's plaintext is
 * shown on exactly one page render and never stored, so the Durable Object holds
 * nothing but its SHA-256. `/admin/audit` lists every tool call and key change.
 */

import { Hono } from "hono";
import {
  type AdminEnv,
  csrfHeaders,
  issueCsrfToken,
  requireAdmin,
  verifyCsrfToken,
} from "../auth/admin-session";
import { baseUrlFrom } from "../auth/guard";
import { generateApiKey } from "../auth/tokens";
import { type Config, type Env, parseConfig } from "../env";
import { toErrorBody } from "../errors";
import {
  API_KEY_NAME_MAX,
  type ApiKeySummary,
  type AuditEntry,
  type AuditInput,
  type BudgetDay,
  getStoreStub,
} from "../store/do";
import { banner, escapeHtml, htmlResponse, keyValues, page } from "./admin-html";

/**
 * The slice of the `StoopStore` Durable Object these pages use.
 *
 * Declaring it here (rather than typing against the DO class) lets a test inject a
 * plain object instead of a real stub.
 */
export interface AdminStoreStub {
  listAudit(opts?: { limit?: number }): Promise<AuditEntry[]>;
  audit(entry: AuditInput): Promise<void>;
  createApiKey(input: { id: string; name: string; sha256: string }): Promise<void>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id: string): Promise<boolean>;
  budgetHistory(days?: number): Promise<{ today: BudgetDay; recent: BudgetDay[] }>;
}

/** Injectable dependencies; the production default is the real DO stub. */
export interface AdminPagesDeps {
  storeStub?: (env: Env) => AdminStoreStub;
}

const DEFAULT_AUDIT_LIMIT = 50;
/** Purpose string binding a CSRF token to the two API key forms. */
const KEYS_CSRF_PURPOSE = "admin-keys";

/**
 * `/admin`, `/admin/keys`, `/admin/keys/:id/revoke`, `/admin/audit`, `/admin/status`.
 *
 * Mount at the root (paths are absolute): `app.route("/", adminPages())`.
 */
export function adminPages(deps: AdminPagesDeps = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const stubFor = deps.storeStub ?? defaultStoreStub;

  // Per-route rather than `app.use("/admin/*", ...)`: `Hono#route()` copies a
  // sub-app's middleware into the parent by path pattern, so a wildcard here would
  // also gate `/admin/login` from `adminRoutes()` and loop the sign-in redirect.

  /* ------------------------------------------------------------ dashboard */

  app.get("/admin", requireAdmin, async (c) => {
    const status = await collectStatus(c.env, stubFor);
    return htmlResponse(
      dashboardPage({
        status,
        baseUrl: baseUrlFrom(c.req.raw, c.env),
        flash: c.req.query("flash") ?? undefined,
      }),
    );
  });

  /* ----------------------------------------------------------- api keys */

  app.get("/admin/keys", requireAdmin, async (c) => {
    const keys = await stubFor(c.env).listApiKeys();
    const { token: csrf, cookie } = await issueCsrfToken(c.env, KEYS_CSRF_PURPOSE);
    return htmlResponse(
      keysPage({
        keys,
        csrf,
        flash: c.req.query("flash") ?? undefined,
        error: c.req.query("error") ?? undefined,
      }),
      200,
      csrfHeaders(cookie),
    );
  });

  app.post("/admin/keys", requireAdmin, async (c) => {
    const submitted = await readKeyForm(c.req.raw);
    if (!(await verifyCsrfToken(c.req.raw, c.env, KEYS_CSRF_PURPOSE, submitted.csrf))) {
      return keysErrorPage(c, stubFor, CSRF_FAILURE, 403);
    }

    const name = submitted.name.trim();
    if (name.length < 1 || name.length > API_KEY_NAME_MAX) {
      return keysErrorPage(
        c,
        stubFor,
        `Give the key a name of 1 to ${API_KEY_NAME_MAX} characters.`,
      );
    }

    const { token, sha256 } = await generateApiKey();
    const id = crypto.randomUUID();
    const stub = stubFor(c.env);
    await stub.createApiKey({ id, name, sha256 });
    // The key itself is never audited, only that one was minted.
    await auditKeyChange(stub, "admin.keys.create", { id, name });

    return htmlResponse(keyCreatedPage({ name, token, baseUrl: baseUrlFrom(c.req.raw, c.env) }));
  });

  app.post("/admin/keys/:id/revoke", requireAdmin, async (c) => {
    const submitted = await readKeyForm(c.req.raw);
    if (!(await verifyCsrfToken(c.req.raw, c.env, KEYS_CSRF_PURPOSE, submitted.csrf))) {
      return keysErrorPage(c, stubFor, CSRF_FAILURE, 403);
    }

    const id = c.req.param("id");
    const stub = stubFor(c.env);
    const revoked = await stub.revokeApiKey(id);
    if (revoked) await auditKeyChange(stub, "admin.keys.revoke", { id });

    const query = revoked
      ? `flash=${encodeURIComponent("API key revoked. It stops working on the next request.")}`
      : `error=${encodeURIComponent("That key is unknown or was already revoked.")}`;
    return c.redirect(`/admin/keys?${query}`, 303);
  });

  /* ---------------------------------------------------------------- audit */

  app.get("/admin/audit", requireAdmin, async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const rows = await stubFor(c.env).listAudit({ limit });
    if (c.req.query("format") === "json") {
      return c.json({ entries: rows, limit }, 200);
    }
    return htmlResponse(auditPage(rows, limit));
  });

  /* --------------------------------------------------------------- status */

  app.get("/admin/status", requireAdmin, async (c) => {
    return c.json(await collectStatus(c.env, stubFor), 200);
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/* Status gathering                                                            */
/* -------------------------------------------------------------------------- */

interface AdminStatus {
  provider: string | null;
  limits: {
    maxUpstreamPerDay: number | null;
    maxPagesPerSearch: number | null;
    maxRetries: number | null;
  };
  usage: { today: BudgetDay; recent: BudgetDay[] } | null;
  secrets: {
    adminPassword: boolean;
    cookieKey: boolean;
    providerKey: boolean | null;
    socrataToken: boolean;
  };
  configError?: string;
  storeError?: string;
}

function defaultStoreStub(env: Env): AdminStoreStub {
  return getStoreStub(env) as unknown as AdminStoreStub;
}

/** Which secret the configured provider needs, or `null` for `direct`. */
function providerSecretSet(env: Env, provider: string | null): boolean | null {
  switch (provider) {
    case "zyte":
      return Boolean(env.ZYTE_API_KEY?.trim());
    case "brightdata":
      return Boolean(env.BRIGHTDATA_API_KEY?.trim());
    case "relay":
      return Boolean(env.RELAY_URL?.trim() && env.RELAY_TOKEN?.trim());
    default:
      return null;
  }
}

async function collectStatus(
  env: Env,
  stubFor: (env: Env) => AdminStoreStub,
): Promise<AdminStatus> {
  let config: Config | undefined;
  let configError: string | undefined;
  try {
    config = parseConfig(env);
  } catch (error) {
    configError = toErrorBody(error).error.message;
  }

  let usage: AdminStatus["usage"] = null;
  let storeError: string | undefined;
  try {
    usage = await stubFor(env).budgetHistory(7);
  } catch (error) {
    storeError = toErrorBody(error).error.message;
  }

  const provider = config?.provider ?? null;
  const status: AdminStatus = {
    provider,
    limits: {
      maxUpstreamPerDay: config?.maxUpstreamPerDay ?? null,
      maxPagesPerSearch: config?.maxPagesPerSearch ?? null,
      maxRetries: config?.maxRetries ?? null,
    },
    usage,
    secrets: {
      adminPassword: Boolean(env.ADMIN_PASSWORD?.trim()),
      cookieKey: Boolean(env.COOKIE_SIGNING_KEY?.trim()),
      providerKey: providerSecretSet(env, provider),
      socrataToken: Boolean(env.SOCRATA_APP_TOKEN?.trim()),
    },
  };
  if (configError !== undefined) status.configError = configError;
  if (storeError !== undefined) status.storeError = storeError;
  return status;
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIT_LIMIT;
  return Math.min(Math.max(parsed, 1), 500);
}

/* -------------------------------------------------------------------------- */
/* API key forms                                                               */
/* -------------------------------------------------------------------------- */

/** What the two key forms submit. Browser form posts only; there is no JSON API here. */
interface KeyForm {
  name: string;
  csrf?: string;
}

async function readKeyForm(request: Request): Promise<KeyForm> {
  try {
    const form = await request.formData();
    const csrf = form.get("csrf");
    const name = form.get("name");
    return {
      name: typeof name === "string" ? name : "",
      csrf: typeof csrf === "string" ? csrf : undefined,
    };
  } catch {
    return { name: "" };
  }
}

/** What a form says when its token did not verify. */
const CSRF_FAILURE = "That form expired or was submitted from another site. Try again.";

/** Re-renders the key list with an error banner and a fresh CSRF token. */
async function keysErrorPage(
  c: { env: Env },
  stubFor: (env: Env) => AdminStoreStub,
  message: string,
  status = 400,
): Promise<Response> {
  const keys = await stubFor(c.env).listApiKeys();
  const { token: csrf, cookie } = await issueCsrfToken(c.env, KEYS_CSRF_PURPOSE);
  return htmlResponse(keysPage({ keys, csrf, error: message }), status, csrfHeaders(cookie));
}

/** Records a key change in the audit log. Never receives the key itself. */
async function auditKeyChange(
  stub: AdminStoreStub,
  tool: "admin.keys.create" | "admin.keys.revoke",
  args: Record<string, unknown>,
): Promise<void> {
  try {
    await stub.audit({ actor: "admin:cookie", tool, args, outcome: "ok" });
  } catch (error) {
    // An audit failure must not lose the operator their key, or leave a revoked key
    // looking un-revoked. Report it and carry on.
    console.warn("admin: could not write the audit entry", {
      tool,
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

const NAV: Array<[string, string]> = [
  ["/admin", "Status"],
  ["/admin/keys", "API keys"],
  ["/admin/audit", "Audit log"],
  ["/healthz", "Health"],
  ["/admin/logout", "Sign out"],
];

function dashboardPage(options: { status: AdminStatus; baseUrl: string; flash?: string }): string {
  const { status, baseUrl } = options;
  const mcpUrl = `${baseUrl}/mcp`;
  const cap = status.limits.maxUpstreamPerDay;
  const today = status.usage?.today;

  const usageLine = !today
    ? "unknown"
    : cap === null
      ? `${today.used} (no daily cap)`
      : `${today.used} of ${cap}`;

  const recentRows = (status.usage?.recent ?? []).map(
    (day) => [day.day, day.used] as [string, unknown],
  );

  return page({
    title: "Status",
    heading: "Status",
    nav: NAV,
    body: `
${options.flash ? banner("ok", options.flash) : ""}
${status.configError ? banner("err", `Configuration problem: ${status.configError}`) : ""}
${status.storeError ? banner("err", `The store Durable Object did not answer: ${status.storeError}`) : ""}
${
  status.secrets.providerKey === false
    ? banner(
        "warn",
        `The ${status.provider} provider's secret is not set, so searches and listing lookups will fail. Building records and station lookups still work.`,
      )
    : ""
}

<h2>Connect an agent</h2>
<p>This is the address agents connect to:</p>
<pre>${escapeHtml(mcpUrl)}</pre>
<p>Agents sign in one of two ways.</p>
<ul>
<li><a href="/admin/keys">Create an API key</a> and give it to the agent as a bearer header. This works everywhere, including scripts. For Claude Code:</li>
</ul>
<pre>claude mcp add --transport http stoop ${escapeHtml(mcpUrl)} \\
  --header "Authorization: Bearer stoop_..."</pre>
<ul>
<li>Or let the agent use OAuth: add the address above in the client, and it will send you back here to approve it. claude.ai and ChatGPT connectors only support this route.</li>
</ul>
<pre>claude mcp add --transport http stoop ${escapeHtml(mcpUrl)}</pre>

<h2>Upstream requests</h2>
<p>Every StreetEasy request goes through the provider and counts against the daily cap (UTC day), retries included. Public-record lookups are free.</p>
${keyValues([
  ["Provider", status.provider ?? "unknown"],
  ["Used today", usageLine],
  ["Pages per search", status.limits.maxPagesPerSearch ?? "unknown"],
  ["Retries after a block", status.limits.maxRetries ?? "unknown"],
])}
${recentRows.length > 1 ? `<h3>Last 7 days</h3>${keyValues(recentRows)}` : ""}
<p class="small muted">Change the limits in wrangler.jsonc and redeploy.</p>

<h2>Setup check</h2>
${keyValues([
  ["Admin password", status.secrets.adminPassword ? "set" : "missing"],
  ["Cookie signing key", status.secrets.cookieKey ? "set" : "missing"],
  [
    "Provider secret",
    status.secrets.providerKey === null
      ? "not needed"
      : status.secrets.providerKey
        ? "set"
        : "missing",
  ],
  ["NYC Open Data token", status.secrets.socrataToken ? "set" : "not set (optional)"],
])}
<p class="small muted">Only whether each secret exists is shown. Values are never displayed. The <a href="/admin/audit">audit log</a> lists every tool call made through this deployment.</p>`,
  });
}

function keysPage(options: {
  keys: ApiKeySummary[];
  csrf: string;
  flash?: string;
  error?: string;
}): string {
  const rows = options.keys
    .map((key) => {
      const revoked = key.revokedAt !== undefined;
      const action = revoked
        ? `<span class="muted">n/a</span>`
        : `<form method="post" action="/admin/keys/${encodeURIComponent(key.id)}/revoke">
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<button type="submit" class="quiet">Revoke</button>
</form>`;
      return `<tr>
<td>${escapeHtml(key.name)}</td>
<td>${escapeHtml(key.createdAt)}</td>
<td>${escapeHtml(key.lastUsedAt ?? "never")}</td>
<td>${escapeHtml(revoked ? `revoked ${key.revokedAt}` : "active")}</td>
<td>${action}</td>
</tr>`;
    })
    .join("");

  const table =
    options.keys.length === 0
      ? `<p class="muted">No API keys yet. Create one below.</p>`
      : `<div class="card"><table>
<thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`;

  return page({
    title: "API keys",
    heading: "API keys",
    subtitle: "Credentials for agents and scripts. Only their SHA-256 is stored.",
    nav: NAV,
    body: `
${options.flash ? banner("ok", options.flash) : ""}
${options.error ? banner("err", options.error) : ""}
${table}
<form class="card" method="post" action="/admin/keys">
<h2>Create a key</h2>
<input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
<label for="name">Name</label>
<input id="name" name="name" type="text" maxlength="${API_KEY_NAME_MAX}" required spellcheck="false"
 autocomplete="off" placeholder="claude-code">
<button type="submit">Create key</button>
</form>
<p class="small muted">The key is shown once, on the next page. It cannot be recovered afterwards;
mint a new one and revoke the old one if you lose it. Revoking takes effect on the next request.</p>`,
  });
}

function keyCreatedPage(options: { name: string; token: string; baseUrl: string }): string {
  const mcpUrl = `${options.baseUrl.replace(/\/+$/, "")}/mcp`;
  const claudeCode = `claude mcp add --transport http stoop ${mcpUrl} \\
  --header "Authorization: Bearer ${options.token}"`;
  const cursor = `{
  "mcpServers": {
    "stoop": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${options.token}" }
    }
  }
}`;

  return page({
    title: "API key created",
    heading: "Copy this key now",
    subtitle: "It is shown on this page only. Nothing here can show it to you again.",
    nav: NAV,
    body: `
${banner("warn", "This is the only time this key is displayed. Copy it before you leave the page.")}
<div class="card">
${keyValues([["Name", options.name]])}
<label for="key">The key</label>
<pre id="key">${escapeHtml(options.token)}</pre>
</div>
<div class="card">
<h2>Claude Code</h2>
<pre>${escapeHtml(claudeCode)}</pre>
<h2>Cursor (<code>~/.cursor/mcp.json</code>)</h2>
<pre>${escapeHtml(cursor)}</pre>
<p class="small muted">The header is a plain bearer credential: <code>Authorization: Bearer &lt;key&gt;</code>.
No other header is needed.</p>
</div>
<p class="small"><a href="/admin/keys">Back to the key list</a></p>`,
  });
}

function auditPage(rows: AuditEntry[], limit: number): string {
  const body =
    rows.length === 0
      ? `<p class="muted">No audit entries yet.</p>`
      : `<div class="card"><table>
<thead><tr><th>When</th><th>Actor</th><th>Tool</th><th>Outcome</th><th>Upstream</th><th>Time</th><th>Args</th></tr></thead>
<tbody>${rows
          .map(
            (row) => `<tr>
<td>${escapeHtml(row.ts)}</td>
<td>${escapeHtml(row.actor)}</td>
<td>${escapeHtml(row.tool)}</td>
<td>${escapeHtml(row.error ? `${row.outcome}: ${row.error}` : row.outcome)}</td>
<td>${escapeHtml(row.upstream)}</td>
<td>${escapeHtml(row.durationMs === undefined ? "n/a" : `${row.durationMs} ms`)}</td>
<td><code>${escapeHtml(row.args === undefined ? "" : JSON.stringify(row.args))}</code></td>
</tr>`,
          )
          .join("")}</tbody></table></div>`;

  return page({
    title: "Audit log",
    heading: "Audit log",
    subtitle: `Most recent ${limit} entries. Upstream is the paid requests each call spent. Kept 90 days.`,
    nav: NAV,
    body: `${body}<p class="small"><a href="/admin/audit?format=json&amp;limit=${limit}">Same data as JSON</a></p>`,
  });
}
