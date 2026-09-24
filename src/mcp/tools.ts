/**
 * The MCP tools.
 *
 * Descriptions are the only documentation the model gets, so each says what the
 * tool costs, what to call first, and how to read the result. Results put the
 * full JSON in the text content (some clients show only text) and repeat it as
 * structuredContent. Failures come back as `isError` with `{ code, message, hint }`.
 * Every call, success or failure, is reported to {@link ToolHooks.record} for the
 * audit log.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { REPORT_SECTIONS } from "../building/records";
import { SORTS, type StoopService } from "../core/service";
import { toErrorBody } from "../errors";
import { AMENITY_TOKENS } from "../streeteasy/amenities";

export const TOOL_NAMES = [
  "search_rentals",
  "get_listing",
  "check_building",
  "find_station",
  "list_neighborhoods",
  "list_amenities",
  "stoop_status",
] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const searchInput = z.object({
  neighborhoods: z
    .array(z.string())
    .min(1)
    .max(12)
    .optional()
    .describe(
      "StreetEasy neighborhood names, e.g. ['Williamsburg', 'Greenpoint'] or boroughs like 'Brooklyn'. Common nicknames work (UWS, LES, Bed-Stuy).",
    ),
  near_station: z
    .string()
    .optional()
    .describe(
      "Subway station name, e.g. 'Bedford Av', 'Atlantic Av-Barclays Ctr', 'the Bedford L'. Use find_station first if unsure.",
    ),
  line: z
    .string()
    .max(3)
    .optional()
    .describe("Subway line to disambiguate near_station, e.g. 'L', 'G', '7'."),
  near_place: z
    .string()
    .optional()
    .describe(
      "Any NYC address, intersection or landmark: '350 5th Ave', 'Bedford Ave & N 7th St', 'Prospect Park'.",
    ),
  near_point: z
    .object({ lat: z.number().min(40.4).max(41), lng: z.number().min(-74.3).max(-73.6) })
    .optional()
    .describe("Exact coordinates to search around."),
  radius_minutes: z
    .number()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Walking time from the station/place/point (default 10). Estimated from straight-line distance.",
    ),
  min_price: z.number().int().min(0).optional().describe("Monthly rent, USD."),
  max_price: z.number().int().min(0).optional().describe("Monthly rent, USD."),
  min_beds: z.number().int().min(0).max(10).optional().describe("0 = studio."),
  max_beds: z.number().int().min(0).max(10).optional(),
  min_baths: z.number().min(0).max(10).optional(),
  amenities: z
    .array(z.string())
    .optional()
    .describe(`Required amenities (tokens or plain words): ${AMENITY_TOKENS.join(", ")}.`),
  nice_to_have: z
    .array(z.string())
    .optional()
    .describe("Preferred amenities: reported as matched/missing per listing, not required."),
  pets_allowed: z.boolean().optional(),
  available_by: date.optional().describe("Latest acceptable move-in date."),
  no_fee_only: z.boolean().optional(),
  include_sponsored: z
    .boolean()
    .optional()
    .describe("Include StreetEasy's paid placements (default false)."),
  sort: z
    .enum(SORTS)
    .optional()
    .describe("Default: distance for location searches, recommended for neighborhoods."),
  limit: z.number().int().min(1).max(25).optional().describe("Results to return (default 15)."),
  cursor: z
    .string()
    .optional()
    .describe("next_cursor from a previous call with the same arguments."),
  building_flags: z
    .boolean()
    .optional()
    .describe(
      "Add public-record flags per building (default true): open class C violations, heat complaints, bedbugs.",
    ),
});

export const listingInput = z.object({
  listing_id: z.string().describe("id from search_rentals, or a streeteasy.com/rental/<id> URL."),
  building_records: z
    .boolean()
    .optional()
    .describe("Include the building's public-record summary (default true)."),
});

export const buildingInput = z.object({
  listing_id: z.string().optional().describe("A listing id from search_rentals."),
  address: z
    .string()
    .optional()
    .describe("Or any NYC street address, e.g. '123 Bedford Ave, Brooklyn'."),
  sections: z
    .array(z.enum(REPORT_SECTIONS))
    .optional()
    .describe("Limit the report to these sections (default: all)."),
  years: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Look-back for counts, in years (default 3)."),
});

export const stationInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Station name or how someone would say it: 'Bedford', 'Union Sq', 'Atlantic Terminal', 'the Bedford L'.",
    ),
  line: z.string().max(3).optional().describe("Only stations on this line, e.g. 'L'."),
});

export const neighborhoodsInput = z.object({
  query: z.string().optional().describe("Part of a name, e.g. 'heights'."),
  borough: z.enum(["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]).optional(),
});

/** One finished tool call, as the audit log records it. */
export interface ToolCall {
  tool: string;
  args: unknown;
  outcome: "ok" | "error";
  /** `CODE: message` on failure. */
  error?: string;
  /** Paid upstream requests the call spent. */
  upstream: number;
  durationMs: number;
}

export interface ToolHooks {
  /** Paid upstream requests this HTTP request has spent so far. */
  upstreamSpent(): number;
  /** Called once per tool call after it finishes. Must not throw. */
  record(call: ToolCall): Promise<void>;
}

const NO_HOOKS: ToolHooks = { upstreamSpent: () => 0, record: async () => {} };

export function registerTools(
  server: McpServer,
  service: StoopService,
  hooks: ToolHooks = NO_HOOKS,
): void {
  const run = (tool: string, args: unknown, fn: () => Promise<[string, unknown]>) =>
    runTool(hooks, tool, args, fn);

  server.registerTool(
    "search_rentals",
    {
      title: "Search NYC rentals",
      description: [
        "Search active NYC rental listings on StreetEasy. Give exactly one location: neighborhoods, near_station (+ optional line), near_place (address, intersection or landmark), or near_point.",
        "Location searches scan the neighborhoods around the point and keep listings within radius_minutes' walk, each with distance_m and walk_min, nearest first.",
        "Each result has price, beds/baths, sqft, availability, a photo, the listing url, and (by default) `building` flags from public records: open_class_c_violations (immediately hazardous), heat_complaints_12mo, bedbugs_reported_3y. A flag of null means it couldn't be checked, not that it's clean.",
        "Costs 1 upstream request per StreetEasy page read (usually 1-3); results are cached for 15 minutes. If next_cursor is set, pass it back with the same arguments for more.",
        "Show the user the listing url for anything they like; this tool can't contact agents or book tours.",
      ].join(" "),
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run("search_rentals", args, async () => {
        const r = await service.searchRentals(args);
        return [
          `${r.returned} listing(s) ${r.where.mode === "neighborhoods" ? "in" : "near"} ${r.where.label}${r.next_cursor ? " (more available via next_cursor)" : ""}.`,
          r,
        ];
      }),
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get a listing",
      description: [
        "Full detail for one listing: description, unit features, building amenities, pet policy, lease terms, price history, days on market, neighborhood median rent, photos, floor plans, videos, 3D tour, the nearest subway stations with walking minutes, and a summary of the building's public records (HPD violations, 311 complaints, bedbugs, evictions, DOB violations).",
        "Costs 1 upstream request (cached 6 hours). Use check_building for the full record with recent items and owner.",
      ].join(" "),
      inputSchema: listingInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run("get_listing", args, async () => {
        const r = await service.getListing(args.listing_id, args);
        return [
          `Listing ${r.id}: ${r.street ?? ""}${r.unit ? ` #${r.unit}` : ""}, $${r.price}/mo.`,
          r,
        ];
      }),
  );

  server.registerTool(
    "check_building",
    {
      title: "Check a building's public record",
      description: [
        "Public-record report for a building, by listing_id or any NYC address, from NYC Open Data, tax bills and FEMA.",
        `Sections: ${REPORT_SECTIONS.join(", ")}. Each says its source and period and has status ok or unavailable; 'unavailable' means the source couldn't be reached, never 'no problems'.`,
        "Facts, not a verdict: present counts with their dates, and note that records describe the whole building.",
        "Free (no upstream requests) when called with an address; 1 cached upstream request with a listing_id.",
      ].join(" "),
      inputSchema: buildingInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run("check_building", args, async () => {
        const r = await service.checkBuilding(args);
        return [
          r.matched
            ? `Public record for ${r.address} (BBL ${r.bbl}).`
            : `Couldn't identify the building: ${r.reason}`,
          r,
        ];
      }),
  );

  server.registerTool(
    "find_station",
    {
      title: "Find a subway station",
      description:
        "Look up NYC subway stations by name, optionally on one line, with the lines that stop there (weekday daytime) and the neighborhood. Use it to confirm which station the user means before near_station. Free.",
      inputSchema: stationInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      run("find_station", args, async () => {
        const r = service.findStation(args.query, args.line);
        return [`${r.matches.length} station(s) match "${args.query}".`, r];
      }),
  );

  server.registerTool(
    "list_neighborhoods",
    {
      title: "List neighborhoods",
      description:
        "StreetEasy's neighborhood names (and boroughs/groups like 'All Upper West Side'), optionally filtered. Use it when a neighborhood name is rejected. Free.",
      inputSchema: neighborhoodsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      run("list_neighborhoods", args, async () => {
        const r = service.listNeighborhoods(args);
        return [`${r.count} neighborhood(s).`, r];
      }),
  );

  server.registerTool(
    "list_amenities",
    {
      title: "List amenity filters",
      description:
        "The amenity tokens search_rentals accepts in `amenities` and `nice_to_have`. Free.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => run("list_amenities", {}, async () => ["Amenity tokens.", service.listAmenities()]),
  );

  server.registerTool(
    "stoop_status",
    {
      title: "Deployment status",
      description:
        "Which upstream provider this deployment uses and how many of today's upstream requests are used. Call it if searches fail with BUDGET_EXCEEDED or UPSTREAM_BLOCKED. Free.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => run("stoop_status", {}, async () => ["Deployment status.", await service.status()]),
  );
}

async function runTool(
  hooks: ToolHooks,
  tool: string,
  args: unknown,
  fn: () => Promise<[string, unknown]>,
): Promise<CallToolResult> {
  const started = Date.now();
  const spentBefore = hooks.upstreamSpent();
  let result: CallToolResult;
  let error: string | undefined;
  try {
    const [summary, data] = await fn();
    result = {
      content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data)}` }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (err) {
    const body = toErrorBody(err);
    if (body.error.code === "INTERNAL") console.error("tool failed", err);
    error = `${body.error.code}: ${body.error.message}`;
    result = { isError: true, content: [{ type: "text", text: JSON.stringify(body.error) }] };
  }
  await hooks.record({
    tool,
    args,
    outcome: error === undefined ? "ok" : "error",
    ...(error === undefined ? {} : { error }),
    upstream: hooks.upstreamSpent() - spentBefore,
    durationMs: Date.now() - started,
  });
  return result;
}
