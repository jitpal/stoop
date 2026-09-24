# Security policy

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: open the repository's **Security** tab > **Report a vulnerability**. That creates a private advisory visible only to you and the maintainers.

Do not open a public issue, and do not include real API keys, provider keys, passwords, or cookies in the report. A description of the request and the observed response is enough.

Please include: what you did, what happened, what you expected, and the affected version or commit. If you have a proof of concept, describe it rather than attaching credentials.

Expect an acknowledgement within a few days. This is a volunteer project, so there is no paid bounty and no formal SLA. Fixes land on `main` and are noted in the advisory when it is published.

## What a deployment protects

- **The provider key** (`ZYTE_API_KEY` or equivalent). It spends the operator's money, so the daily cap and the key itself are the things worth attacking.
- **The operator's credentials**: `ADMIN_PASSWORD`, `COOKIE_SIGNING_KEY`, minted API keys, and OAuth grants.
- **The audit log**, which records what the operator's agents searched for, and so where they are looking to live.

Everything stoop returns is public: StreetEasy listings anyone can browse, and city and federal open data. Leaking a search result is not a vulnerability; spending the operator's requests without a credential is.

## In scope

- Authentication bypass: reaching `/mcp` or `/admin/*` without a valid OAuth token, API key, or admin cookie.
- Any agent credential reaching `/admin/*` to read the audit log or mint or revoke a key. Those pages take the admin cookie only.
- Cap bypass: spending more than `MAX_UPSTREAM_REQUESTS_PER_DAY` provider attempts in a UTC day.
- Secret leakage: any path where the provider key, the admin password, the cookie signing key, or a minted API key appears in a response body, tool output, error message, log line, or the audit log.
- Admin session cookie forgery or fixation, CSRF on `/admin/*` or the OAuth approval form, or an OAuth approval redirecting anywhere but the client's registered callback.
- Injection through upstream or agent-supplied data into the admin or approval HTML pages.

## Out of scope

- Vulnerabilities in StreetEasy, Zyte, Bright Data, NYC Open Data, or FEMA services. Report those to them.
- Anything requiring you to already hold `ADMIN_PASSWORD` or access to the deployer's Cloudflare account.
- StreetEasy blocking requests or changing its private API. That is breakage, not a vulnerability.
- Denial of service by spending your own deployment's daily cap or Worker quota.
- The in-memory rate limit on the password forms being per isolate. It is a documented trade-off; a long `ADMIN_PASSWORD` is the real defence.
- Missing hardening with no stated attack path (header nitpicks, version disclosure in `/healthz`).
- Results from a scanner with no demonstrated impact.

## Secrets handling

If you run this, the security of your deployment depends on these:

- Secrets live in Cloudflare (`wrangler secret put`) or in local `.dev.vars`, never in the repo. `.dev.vars` is gitignored; `.dev.vars.example` holds placeholders only.
- API keys are stored as SHA-256 hashes in the `StoopStore` Durable Object, never in plaintext. A key is displayed once, when it is minted at `/admin/keys`, and then exists only in your client's config.
- `COOKIE_SIGNING_KEY` should be 32 random bytes (`openssl rand -hex 32`). The admin cookie is bound to a digest of `ADMIN_PASSWORD`, so changing the password signs every browser out.
- Tool arguments are scrubbed of anything token-shaped before they reach the audit log, and audit rows are pruned after 90 days.
- `/healthz` reports whether configuration is present, never values.
- Rotation: re-run `wrangler secret put` for any secret. Revoking an API key is a button at `/admin/keys` and takes effect on the next request.
