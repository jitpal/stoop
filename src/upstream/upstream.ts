/**
 * The one door to StreetEasy: provider + daily budget + bot-challenge retries.
 *
 * Every attempt (retries included) is counted against
 * `MAX_UPSTREAM_REQUESTS_PER_DAY` before it is sent, because paid providers bill
 * per attempt. The counter lives in the store Durable Object, which serialises
 * its requests, so the cap is exact even when searches run concurrently.
 */

import { AppError } from "../errors";
import type { UpstreamProvider, UpstreamRequest, UpstreamResponse } from "./providers";

export interface Budget {
  /** Throws BUDGET_EXCEEDED when today's cap is used up; otherwise counts one attempt. */
  spend(): Promise<void>;
  /** Attempts used today and the cap (`null` = unlimited). */
  status(): Promise<{ used: number; cap: number | null; day: string }>;
}

/** The slice of the store Durable Object the budget uses. */
export interface BudgetStore {
  spendUpstream(cap: number | null): Promise<{ ok: boolean; used: number }>;
  budgetHistory(days?: number): Promise<{ today: { day: string; used: number } }>;
}

export function storeBudget(store: BudgetStore, cap: number | null): Budget {
  return {
    async spend() {
      const result = await store.spendUpstream(cap);
      if (!result.ok) {
        throw new AppError(
          "BUDGET_EXCEEDED",
          `Today's upstream request cap (${cap}) is used up.`,
          "Tell the user the daily search limit was reached; it resets at 00:00 UTC. The operator can raise MAX_UPSTREAM_REQUESTS_PER_DAY.",
        );
      }
    },
    async status() {
      const { today } = await store.budgetHistory(1);
      return { used: today.used, cap, day: today.day };
    },
  };
}

/**
 * Counts the attempts made through `inner` during one request, so the audit log can
 * say what each tool call spent.
 */
export function meteredBudget(inner: Budget): Budget & { readonly spent: number } {
  let spent = 0;
  return {
    get spent() {
      return spent;
    },
    async spend() {
      await inner.spend();
      spent++;
    },
    status: () => inner.status(),
  };
}

/** A PerimeterX challenge rather than a real answer. */
export function isBotChallenge(res: UpstreamResponse): boolean {
  if (res.status === 403 || res.status === 429) return true;
  return /px-captcha|_pxAppId|perimeterx|Access to this page has been denied|Press & Hold/i.test(
    res.body.slice(0, 5000),
  );
}

export interface Upstream {
  readonly provider: string;
  send(req: UpstreamRequest): Promise<UpstreamResponse>;
}

export function createUpstream(
  provider: UpstreamProvider,
  budget: Budget,
  maxRetries: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Upstream {
  return {
    provider: provider.name,
    async send(req) {
      let last: UpstreamResponse | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(400 * attempt);
        await budget.spend();
        last = await provider.send(req);
        if (!isBotChallenge(last)) return last;
      }
      throw new AppError(
        "UPSTREAM_BLOCKED",
        `StreetEasy's bot protection blocked the request via "${provider.name}" (HTTP ${last?.status}) after ${maxRetries + 1} attempt(s).`,
        provider.name === "direct"
          ? "Direct requests only work from a residential connection. Set UPSTREAM_PROVIDER to zyte, brightdata or relay."
          : "Try again in a minute; if it keeps happening, switch UPSTREAM_PROVIDER.",
      );
    },
  };
}
