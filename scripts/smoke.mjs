#!/usr/bin/env node
/**
 * Step 0: can this provider reach StreetEasy? Sends one search and one listing
 * lookup through the provider and reports what came back. Spends 2 requests
 * (more if StreetEasy challenges and it retries).
 *
 *   ZYTE_API_KEY=... npm run smoke                     # default provider: zyte
 *   BRIGHTDATA_API_KEY=... BRIGHTDATA_ZONE=... npm run smoke -- brightdata
 *   RELAY_URL=... RELAY_TOKEN=... npm run smoke -- relay
 *   npm run smoke -- direct                            # from a home connection
 *
 * Pass: HTTP 200 with JSON containing totalCount and listings.
 * Fail: 403 / a challenge page / a provider error, printed in full.
 */

const provider = process.argv[2] ?? process.env.UPSTREAM_PROVIDER ?? "zyte";
const ENDPOINT = "https://api-v6.streeteasy.com/";
const HEADERS = {
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
};
const MANAGED = /^(host|connection|user-agent|accept-language|dnt|x-forwarded-.*|sec-.*)$/i;
const appHeaders = Object.fromEntries(Object.entries(HEADERS).filter(([k]) => !MANAGED.test(k)));

const SEARCH = `query SearchRentalsFederated {
  searchRentals(input: { sorting: { attribute: LISTED_AT, direction: DESCENDING }, filters: { areas: [302], rentalStatus: ACTIVE }, adStrategy: NONE, userSearchToken: "${crypto.randomUUID()}", perPage: 5, page: 1 }) {
    totalCount
    edges {
      ... on OrganicRentalEdge { node { id street unit price bedroomCount areaName geoPoint { latitude longitude } } }
      ... on FeaturedRentalEdge { node { id street unit price bedroomCount areaName geoPoint { latitude longitude } } }
    }
  }
}`;
const DETAIL = `query RentalListingDetailsFederated($listingID: ID!) {
  rentalByListingId(id: $listingID) { id status description pricing { price noFee } propertyDetails { address { street unit zipCode } bedroomCount } }
}`;

async function send(body) {
  const payload = JSON.stringify(body);
  switch (provider) {
    case "zyte": {
      const key = need("ZYTE_API_KEY");
      const res = await fetch("https://api.zyte.com/v1/extract", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: ENDPOINT,
          httpResponseBody: true,
          httpRequestMethod: "POST",
          httpRequestBody: Buffer.from(payload).toString("base64"),
          customHttpRequestHeaders: Object.entries(appHeaders).map(([name, value]) => ({
            name,
            value,
          })),
        }),
      });
      const text = await res.text();
      if (!res.ok) return { provider_status: res.status, status: null, body: text };
      const data = JSON.parse(text);
      return {
        provider_status: res.status,
        status: data.statusCode,
        body: data.httpResponseBody
          ? Buffer.from(data.httpResponseBody, "base64").toString("utf8")
          : "",
      };
    }
    case "brightdata": {
      const res = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${need("BRIGHTDATA_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone: process.env.BRIGHTDATA_ZONE ?? "web_unlocker1",
          url: ENDPOINT,
          format: "raw",
          method: "POST",
          headers: appHeaders,
          body: payload,
        }),
      });
      return { provider_status: res.status, status: res.status, body: await res.text() };
    }
    case "relay": {
      const res = await fetch(need("RELAY_URL"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${need("RELAY_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: ENDPOINT, method: "POST", headers: HEADERS, body: payload }),
      });
      const data = await res.json();
      return { provider_status: res.status, status: data.status, body: data.body };
    }
    case "direct": {
      const res = await fetch(ENDPOINT, { method: "POST", headers: HEADERS, body: payload });
      return { provider_status: null, status: res.status, body: await res.text() };
    }
    default:
      throw new Error(`unknown provider ${provider}`);
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Set ${name} first.`);
    process.exit(2);
  }
  return v;
}

function report(label, r, ms) {
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch {}
  const ok = r.status === 200 && json?.data && !json.errors;
  console.log(
    `\n${ok ? "PASS" : "FAIL"} ${label} via ${provider} in ${ms} ms (provider HTTP ${r.provider_status ?? "-"}, StreetEasy HTTP ${r.status ?? "-"})`,
  );
  if (!ok) console.log(r.body.slice(0, 1500));
  return ok ? json.data : null;
}

let t = Date.now();
const search = report(
  "search (Williamsburg, newest 5)",
  await send({ query: SEARCH }),
  Date.now() - t,
);
if (!search) process.exit(1);
const edges = search.searchRentals.edges.filter((e) => e?.node);
console.log(`  totalCount: ${search.searchRentals.totalCount}`);
for (const { node: n } of edges) {
  console.log(
    `  ${n.id}  $${n.price}  ${n.bedroomCount}BR  ${n.street} ${n.unit ?? ""}  (${n.geoPoint?.latitude}, ${n.geoPoint?.longitude})`,
  );
}
const first = edges[0]?.node?.id;
if (!first) process.exit(0);

t = Date.now();
const detail = report(
  `listing ${first}`,
  await send({ query: DETAIL, variables: { listingID: first } }),
  Date.now() - t,
);
if (!detail) process.exit(1);
const l = detail.rentalByListingId;
console.log(
  `  ${l.propertyDetails?.address?.street} ${l.propertyDetails?.address?.unit ?? ""} ${l.propertyDetails?.address?.zipCode}: $${l.pricing?.price}, ${l.status}`,
);
console.log(
  `  ${String(l.description ?? "")
    .slice(0, 160)
    .replace(/\s+/g, " ")}…`,
);
console.log(`\nBoth calls worked. Set UPSTREAM_PROVIDER=${provider} and deploy.`);
