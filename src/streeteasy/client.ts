/**
 * StreetEasy's private GraphQL API, reached through an `Upstream`.
 *
 * Search input is rendered inline with bare enum tokens (see queries.ts); the
 * detail query uses a variable. Headers mirror what the StreetEasy web app sends;
 * managed providers (Zyte, Bright Data) drop the browser-identity ones and use
 * their own.
 */

import { AppError } from "../errors";
import type { Upstream } from "../upstream/upstream";
import { buildSearchRentalsQuery, RENTAL_LISTING_DETAILS_QUERY } from "./queries";
import type {
  RentalListingDetailsResponse,
  SearchRentalsInput,
  SearchRentalsResponse,
} from "./types";

export const STREETEASY_ENDPOINT = "https://api-v6.streeteasy.com/";

export const STREETEASY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://streeteasy.com",
  Referer: "https://streeteasy.com/",
  "Apollographql-Client-Name": "srp-frontend-service",
  "Apollographql-Client-Version": "version  50bef71ef923e981bdcb7c781851c3bfdb12a0c1",
  "App-Version": "1.0.0",
  Os: "web",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
};

interface GraphQLResult<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

export class StreetEasyClient {
  constructor(private readonly upstream: Upstream) {}

  get provider(): string {
    return this.upstream.provider;
  }

  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.upstream.send({
      url: STREETEASY_ENDPOINT,
      method: "POST",
      headers: STREETEASY_HEADERS,
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    if (res.status >= 500) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `StreetEasy returned HTTP ${res.status}.`,
        "Retry in a minute.",
      );
    }
    let parsed: GraphQLResult<T>;
    try {
      parsed = JSON.parse(res.body) as GraphQLResult<T>;
    } catch {
      throw new AppError(
        "UPSTREAM_ERROR",
        `StreetEasy answered HTTP ${res.status} with something that isn't JSON: ${res.body.slice(0, 200)}`,
        "The provider may have returned a challenge page. Retry, or switch UPSTREAM_PROVIDER.",
      );
    }
    if (parsed.errors?.length) {
      const msg = parsed.errors.map((e) => e.message).join("; ");
      const validation = parsed.errors.some((e) =>
        /VALIDATION|GRAPHQL_PARSE|Cannot query field|does not exist/i.test(
          `${e.extensions?.code} ${e.message}`,
        ),
      );
      if (validation || !parsed.data) {
        throw new AppError(
          validation ? "UPSTREAM_CHANGED" : "UPSTREAM_ERROR",
          `StreetEasy GraphQL error: ${msg}`,
          validation
            ? "StreetEasy's private API changed shape. The queries in src/streeteasy/queries.ts need updating."
            : undefined,
        );
      }
    }
    if (!parsed.data) {
      throw new AppError("UPSTREAM_ERROR", `StreetEasy returned no data (HTTP ${res.status}).`);
    }
    return parsed.data;
  }

  searchRentals(input: SearchRentalsInput): Promise<SearchRentalsResponse> {
    const query = buildSearchRentalsQuery({
      ...input,
      adStrategy: input.adStrategy ?? "NONE",
      userSearchToken: input.userSearchToken ?? crypto.randomUUID(),
    });
    return this.graphql<SearchRentalsResponse>(query);
  }

  async listingDetails(listingId: string): Promise<RentalListingDetailsResponse> {
    const data = await this.graphql<RentalListingDetailsResponse>(RENTAL_LISTING_DETAILS_QUERY, {
      listingID: listingId,
    });
    if (!data.rentalByListingId) {
      throw new AppError(
        "NOT_FOUND",
        `No StreetEasy rental with id ${listingId}.`,
        "Use an id from search_rentals.",
      );
    }
    return data;
  }
}
