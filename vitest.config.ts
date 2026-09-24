import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd via `@cloudflare/vitest-pool-workers`, reusing
 * wrangler.jsonc so bindings match production. Tests never touch the network:
 * everything external goes through the fake fetch in test/helpers.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          UPSTREAM_PROVIDER: "zyte",
          MAX_UPSTREAM_REQUESTS_PER_DAY: "50",
          UPSTREAM_MAX_RETRIES: "1",
          MAX_PAGES_PER_SEARCH: "3",
          PUBLIC_BASE_URL: "",
          ADMIN_PASSWORD: "test-admin-password",
          COOKIE_SIGNING_KEY: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
          ZYTE_API_KEY: "zyte-test-key",
          BRIGHTDATA_API_KEY: "",
          RELAY_URL: "",
          RELAY_TOKEN: "",
          SOCRATA_APP_TOKEN: "",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
