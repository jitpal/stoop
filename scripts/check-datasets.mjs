#!/usr/bin/env node
/**
 * Verifies every public dataset stoop reads: the dataset answers, and the
 * columns the code filters or reads exist. Run it after deploying and whenever
 * a building-report section shows "unavailable".
 *
 *   npm run check-datasets
 *
 * Needs network access to data.cityofnewyork.us, geosearch.planninglabs.nyc and
 * hazards.fema.gov. No keys (set SOCRATA_APP_TOKEN to avoid throttling).
 */

const DATASETS = {
  "wvxf-dwi5": [
    "bbl",
    "class",
    "violationstatus",
    "inspectiondate",
    "novdescription",
    "apartment",
    "buildingid",
  ],
  "erm2-nwe9": ["bbl", "complaint_type", "created_date", "descriptor", "status"],
  "wz6d-d3jb": [
    "bbl",
    "filing_date",
    "infested_dwelling_unit_count",
    "eradicated_unit_count",
    "of_dwelling_units",
  ],
  "3h2n-5cm9": ["bin", "issue_date", "violation_category", "violation_type", "description"],
  "rbx6-tga4": ["bin", "issued_date", "expired_date", "work_type", "job_description"],
  "6z8x-wfk4": ["bbl", "executed_date", "residential_commercial_ind"],
  "64uk-42ks": ["bbl", "address", "yearbuilt", "unitsres", "numfloors", "bldgclass", "ownername"],
  "tesw-yqqr": ["bin", "registrationid", "lastregistrationdate", "registrationenddate"],
  "feu5-w2e2": ["registrationid", "type", "corporationname", "firstname", "lastname"],
};

const headers = { Accept: "application/json" };
if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;

let failed = 0;
for (const [id, columns] of Object.entries(DATASETS)) {
  try {
    const res = await fetch(`https://data.cityofnewyork.us/api/views/${id}.json`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    const have = new Map(meta.columns.map((c) => [c.fieldName, c.dataTypeName]));
    const missing = columns.filter((c) => !have.has(c));
    const types = columns.filter((c) => have.has(c)).map((c) => `${c}:${have.get(c)}`);
    if (missing.length) failed++;
    console.log(`${missing.length ? "FAIL" : "ok  "} ${id} ${meta.name}`);
    console.log(`     ${types.join("  ")}`);
    if (missing.length) console.log(`     missing: ${missing.join(", ")}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${id}: ${err.message}`);
  }
}

for (const [name, url] of [
  [
    "NYC Geosearch",
    "https://geosearch.planninglabs.nyc/v2/search?text=120%20Broadway%2C%20New%20York&size=1",
  ],
  [
    "FEMA NFHL",
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=-74.0107,40.7085&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,SFHA_TF&returnGeometry=false&f=json",
  ],
]) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await res.json();
    const sample =
      body.features?.[0]?.properties?.addendum?.pad ??
      body.features?.[0]?.attributes ??
      body.error ??
      "no features";
    const ok = res.ok && !body.error;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(sample)}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
