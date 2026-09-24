/**
 * The MCP endpoint: stateless Streamable HTTP at /mcp, one McpServer per request
 * (see weworking's docs/DEPENDENCY_NOTES.md for why: agents@0.23's
 * createMcpHandler is stateless and a cached server would leak state).
 *
 * Every tool call is written to the audit log in the store Durable Object as
 * `${actor.kind}:${actor.name}`, with what it cost upstream.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Hono } from "hono";
import {
  type Actor,
  baseUrlFrom,
  executionContextOf,
  propsFromContext,
  resolveActor,
  unauthorizedResponse,
} from "../auth/guard";
import type { StoopService } from "../core/service";
import { type Env, VERSION } from "../env";
import { statusFor, toErrorBody } from "../errors";
import type { AuditInput } from "../store/do";
import { registerTools, type ToolCall } from "./tools";

export const MCP_ROUTE = "/mcp";

export const MCP_INSTRUCTIONS = [
  "stoop: unofficial NYC apartment search. Not affiliated with StreetEasy; listing data comes from StreetEasy's private web API and may be incomplete or change.",
  "",
  "How to help someone find an apartment:",
  "1. Pin down where: neighborhoods, a subway stop (find_station if unsure), or any place/address. Ask for a walking radius if 'near' is vague (default 10 minutes).",
  "2. search_rentals with their budget, beds and must-have amenities. Put nice-to-haves in nice_to_have, not amenities.",
  "3. Read results back with price, beds/baths, walk time and the listing url. Mention building flags plainly and with their meaning: open class C violations are 'immediately hazardous' conditions; heat complaints count 311 calls in the last year; a null flag means unchecked, not clean.",
  "4. For listings they like, get_listing for detail and check_building for the full public record (violations, complaints, bedbugs, evictions, permits, owner, flood zone).",
  "5. Never contact agents or request tours; give the listing url.",
  "",
  "Costs: search_rentals and get_listing spend paid upstream requests (a daily cap applies; stoop_status shows usage). Public-record lookups are free. Errors carry a stable code and a hint; follow the hint.",
].join("\n");

/** What one MCP request needs: the service, and how much it has spent upstream. */
export interface RequestServices {
  service: StoopService;
  upstreamSpent(): number;
}

export interface MountMcpOptions {
  build: (env: Env) => RequestServices;
  /** Where tool calls are recorded. */
  audit: (env: Env) => { audit(entry: AuditInput): Promise<void> };
}

export function mountMcp<E extends { Bindings: Env }>(app: Hono<E>, opts: MountMcpOptions): void {
  app.all(MCP_ROUTE, async (c) => {
    const actor = await resolveActor(c.req.raw, c.env, propsFromContext(executionContextOf(c)));
    if (!actor) return unauthorizedResponse(baseUrlFrom(c.req.raw, c.env));

    let built: RequestServices;
    try {
      built = opts.build(c.env);
    } catch (err) {
      return c.json(toErrorBody(err), statusFor(err) as 500);
    }
    const store = opts.audit(c.env);
    const record = (call: ToolCall) => auditCall(store, actor, call);

    const handler = createMcpHandler(
      async () => {
        const server = new McpServer(
          { name: "stoop", version: VERSION, title: "stoop (unofficial NYC apartment search)" },
          { instructions: MCP_INSTRUCTIONS },
        );
        registerTools(server, built.service, { upstreamSpent: built.upstreamSpent, record });
        return server;
      },
      {
        route: MCP_ROUTE,
        authContext: { props: { ...actor } },
        allowedHostnames: allowedHostnames(c.req.raw, c.env),
      },
    );
    return handler.fetch(c.req.raw);
  });
}

/** Writes one audit row. A failing audit must never turn a tool result into an error. */
async function auditCall(
  store: { audit(entry: AuditInput): Promise<void> },
  actor: Actor,
  call: ToolCall,
): Promise<void> {
  try {
    await store.audit({ actor: `${actor.kind}:${actor.name}`, ...call });
  } catch (err) {
    console.warn("mcp: could not write the audit entry", {
      tool: call.tool,
      message: err instanceof Error ? err.message : "unknown error",
    });
  }
}

function allowedHostnames(req: Request, env: Env): string[] {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", new URL(req.url).hostname]);
  try {
    if (env.PUBLIC_BASE_URL) hosts.add(new URL(env.PUBLIC_BASE_URL).hostname);
  } catch {
    // ignore a malformed PUBLIC_BASE_URL here; it only widens the list
  }
  return [...hosts];
}
