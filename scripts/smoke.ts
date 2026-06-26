/**
 * Smoke test — hits REAL endpoints (WA L&I + CSLB CA), self-validates with live data.
 * Run: npm run smoke
 */

import { waProvider } from "../src/providers/wa.js";
import { caProvider } from "../src/providers/ca.js";
import { providers } from "../src/providers/index.js";
import type { JurisdictionInfo } from "../src/types.js";

const WA_BASE = "https://data.wa.gov/resource/m8qx-ubtq.json";

let passed = 0;
const total = 8;

function report(n: number, label: string, ok: boolean, data: unknown) {
  console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"} [${n}/${total}] ${label}`);
  console.log(JSON.stringify(data, null, 2));
  if (ok) passed++;
}

// ── SEED: fetch live ACTIVE records from WA to get real license/name ─────────
console.log("Fetching live ACTIVE records from WA L&I...\n");
const seedRes = await fetch(`${WA_BASE}?contractorlicensestatus=ACTIVE&$limit=5`);
if (!seedRes.ok) { console.error(`FATAL: WA API returned HTTP ${seedRes.status}`); process.exit(1); }
const seedRecords = (await seedRes.json()) as Record<string, string>[];
if (!seedRecords.length) { console.error("FATAL: 0 ACTIVE records from WA"); process.exit(1); }
const seed = seedRecords[0];
const realLicenseNumber = seed.contractorlicensenumber;
const realBusinessName  = seed.businessname;
console.log(`Seed  →  license: ${realLicenseNumber}  |  name: ${realBusinessName}`);

// ── CHECK 1: fetched real data ────────────────────────────────────────────────
report(1, "Fetched live WA data — got real license number + business name",
  typeof realLicenseNumber === "string" && realLicenseNumber.length > 0 &&
  typeof realBusinessName  === "string" && realBusinessName.length > 0,
  { realLicenseNumber, realBusinessName, totalSeedRecords: seedRecords.length }
);

// ── CHECK 2: verify by real WA license number ─────────────────────────────────
const r2 = await waProvider.verify({ license_number: realLicenseNumber });
report(2,
  `WA verify_license({ license_number: "${realLicenseNumber}" }) → found:true, active, source_url`,
  r2.found === true &&
  r2.result?.status === "active" &&
  typeof r2.source_url === "string" && r2.source_url.length > 0 &&
  r2.jurisdiction === "WA",
  r2
);

// ── CHECK 3: verify by business name ─────────────────────────────────────────
const r3 = await waProvider.verify({ business_name: realBusinessName });
const nameMatched = r3.found === true && (r3.result !== undefined || (Array.isArray(r3.matches) && r3.matches.length > 0));
report(3, `WA verify_license({ business_name: "${realBusinessName}" }) → at least one match`, nameMatched, r3);

// ── CHECK 4: fake license → found:false, no crash ────────────────────────────
const r4 = await waProvider.verify({ license_number: "FAKELIC000XX999ZZZ" });
report(4, 'WA verify_license(fake number) → found:false, no error', r4.found === false && !r4.error, r4);

// ── CHECK 5: list_supported_jurisdictions → WA live + CA live ────────────────
const jurisdictions: JurisdictionInfo[] = Array.from(providers.values()).map((p) => p.info);
const waLive = jurisdictions.some((j) => j.code === "WA" && j.status === "live");
const caPresent = jurisdictions.some((j) => j.code === "CA");
report(5, "list_supported_jurisdictions → WA live + CA present", waLive && caPresent, jurisdictions);

// ── CHECK 6: WA active contractor has REAL bond data (is_bonded:true) ─────────
// Use the same seed record — it came from a live ACTIVE record with known bond
const r6 = await waProvider.verify({ license_number: realLicenseNumber });
const hasBond = r6.found === true && r6.result?.bonded.is_bonded === true && !!r6.result.bonded.details;
report(6,
  `WA verify returns bonded.is_bonded:true with details for active contractor (${realLicenseNumber})`,
  hasBond,
  { bonded: r6.result?.bonded, insured: r6.result?.insured }
);

// ── CHECK 7: CA verify real active license (UNDERWOOD CONSTRUCTION 1100000) ───
console.log("\nChecking CA CSLB license 1100000 (UNDERWOOD CONSTRUCTION)...");
const r7 = await caProvider.verify({ license_number: "1100000" });
const caLive = r7.found === true && r7.result?.status === "active";
// Degraded: CSLB service down — must return a clean structured error (no crash, no undefined)
const caDeg  = !r7.found && typeof r7.error === "string" && typeof r7.message === "string";
const caOk   = caLive || caDeg;
report(7,
  "CA verify_license({ license_number: '1100000' }) → found:true active (or clean degraded error)",
  caOk,
  r7
);

// ── CHECK 8: fake CA number → found:false or clean error (no crash) ───────────
const r8 = await caProvider.verify({ license_number: "9999999" });
const caFakeOk = !r8.found && !r8.result;
report(8,
  "CA verify_license(fake/nonexistent number) → found:false, no crash",
  caFakeOk,
  r8
);

// ── FINAL ─────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(55)}`);
console.log(`SMOKE: ${passed}/${total} PASS`);
if (passed < total) process.exit(1);
