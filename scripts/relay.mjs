#!/usr/bin/env node
/**
 * A tiny relay for UPSTREAM_PROVIDER=relay: run it on a machine with a home
 * (residential) connection and expose it with a Cloudflare Tunnel, e.g.
 *
 *   RELAY_TOKEN=$(openssl rand -hex 32) npm run relay          # listens on :8787
 *   cloudflared tunnel --url http://localhost:8787             # prints a public URL
 *
 * Then set the Worker's RELAY_URL to that URL and RELAY_TOKEN to the same token.
 *
 * It only forwards to api-v6.streeteasy.com, only with the bearer token, and
 * answers `{ status, body }`. No dependencies.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const TOKEN = process.env.RELAY_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_HOST = "api-v6.streeteasy.com";

if (TOKEN.length < 32) {
  console.error("Set RELAY_TOKEN to 32+ random characters (openssl rand -hex 32).");
  process.exit(2);
}

function authorized(header) {
  const presented = Buffer.from(String(header ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(TOKEN);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!authorized(req.headers.authorization)) return reply(401, { error: "bad token" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return reply(413, { error: "too large" });
  }
  let upstream;
  try {
    upstream = JSON.parse(raw);
    if (new URL(upstream.url).hostname !== ALLOWED_HOST)
      return reply(403, { error: "host not allowed" });
  } catch {
    return reply(400, { error: "bad request" });
  }
  try {
    const r = await fetch(upstream.url, {
      method: upstream.method ?? "POST",
      headers: upstream.headers ?? {},
      body: upstream.body,
    });
    const body = await r.text();
    console.log(new Date().toISOString(), r.status, body.length, "bytes");
    reply(200, { status: r.status, body });
  } catch (err) {
    reply(502, { error: String(err) });
  }
}).listen(PORT, () => console.log(`stoop relay on :${PORT}, forwarding to ${ALLOWED_HOST}`));
