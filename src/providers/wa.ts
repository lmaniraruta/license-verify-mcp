import type { Provider, JurisdictionInfo, VerifyResult, VerifyQuery, NormalizedLicense } from "../types.js";

// WA L&I datasets (all confirmed from live API):
//
// Main (m8qx-ubtq) columns:
//   contractorlicensenumber, businessname, contractorlicensestatus, statuscode,
//   contractorlicensetypecode, contractorlicensetypecodedesc,
//   licenseeffectivedate, licenseexpirationdate, ubi, primaryprincipalname,
//   address1, city, state, zip, phonenumber, businesstypecode, businesstypecodedesc
//
// Bond (bzff-4fmt) columns:
//   contractorlicensenumber, ubi, bondfirmname, bondaccountid, bondamt,
//   receivedbyl_i, bondeffectivedate, bondexpirationdate,
//   licensestatus, licensestatusdesc
//
// Insurance (ciwg-agsx) columns:
//   contractorlicensenumber, ubi, insurancecompany, insurancepolicyno, insuranceamt,
//   effectivedate, expirationdate, insuranceagencyname,
//   licensestatus, licensestatusdesc

const MAIN_URL = "https://data.wa.gov/resource/m8qx-ubtq.json";
const BOND_URL = "https://data.wa.gov/resource/bzff-4fmt.json";
const INS_URL  = "https://data.wa.gov/resource/ciwg-agsx.json";
const SOURCE_URL = "https://data.wa.gov/resource/m8qx-ubtq";
const TIMEOUT_MS = 10_000;

type RawRecord = Record<string, string | undefined>;

interface QueryResult {
  records: RawRecord[];
  error?: string;
  message?: string;
}

function normalizeStatus(contractorlicensestatus?: string, statuscode?: string): NormalizedLicense["status"] {
  const s = (contractorlicensestatus ?? statuscode ?? "").toUpperCase().trim();
  if (s === "ACTIVE" || s === "A") return "active";
  if (s === "EXPIRED" || s === "E" || s === "X") return "expired";
  if (s === "SUSPENDED" || s === "S") return "suspended";
  if (s === "REVOKED" || s === "R") return "revoked";
  return "unknown";
}

function toDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.split("T")[0];
}

function parseBond(record?: RawRecord): NormalizedLicense["bonded"] {
  if (!record) {
    return { is_bonded: false, details: "No bond record in WA L&I bond dataset (bzff-4fmt)" };
  }
  const parts: string[] = [];
  if (record.bondfirmname) parts.push(`Surety: ${record.bondfirmname}`);
  if (record.bondaccountid) parts.push(`Bond #: ${record.bondaccountid}`);
  if (record.bondamt) {
    const amt = parseFloat(record.bondamt);
    if (!isNaN(amt)) parts.push(`Amount: $${amt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  }
  if (record.bondeffectivedate) parts.push(`Effective: ${toDate(record.bondeffectivedate)}`);
  if (record.bondexpirationdate) {
    const exp = record.bondexpirationdate === "Until Canceled"
      ? "Until Canceled"
      : toDate(record.bondexpirationdate);
    parts.push(`Expires: ${exp}`);
  }
  return { is_bonded: true, details: parts.join("; ") };
}

function parseInsurance(record?: RawRecord): NormalizedLicense["insured"] {
  if (!record) {
    return { has_insurance: false, details: "No insurance record in WA L&I insurance dataset (ciwg-agsx)" };
  }
  const parts: string[] = [];
  if (record.insurancecompany) parts.push(`Carrier: ${record.insurancecompany}`);
  if (record.insurancepolicyno) parts.push(`Policy: ${record.insurancepolicyno}`);
  if (record.insuranceamt) {
    const amt = parseFloat(record.insuranceamt);
    if (!isNaN(amt)) parts.push(`Coverage: $${amt.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  }
  if (record.insuranceagencyname) parts.push(`Agency: ${record.insuranceagencyname}`);
  if (record.effectivedate) parts.push(`Effective: ${toDate(record.effectivedate)}`);
  if (record.expirationdate) parts.push(`Expires: ${toDate(record.expirationdate)}`);
  return { has_insurance: true, details: parts.join("; ") };
}

async function fetchSoda(baseUrl: string, params: Record<string, string>): Promise<QueryResult> {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      records: [],
      error: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      message: isTimeout ? `Request timed out after ${TIMEOUT_MS}ms` : `Network error: ${msg}`,
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { records: [], error: "HTTP_ERROR", message: `HTTP ${res.status}: ${res.statusText}` };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { records: [], error: "PARSE_ERROR", message: "Failed to parse JSON from WA L&I API" };
  }

  if (!Array.isArray(data)) {
    return { records: [], error: "UNEXPECTED_FORMAT", message: "Expected array from SODA API" };
  }

  return { records: data as RawRecord[] };
}

async function enrichLicense(licenseNum: string): Promise<{ bonded: NormalizedLicense["bonded"]; insured: NormalizedLicense["insured"] }> {
  const [bondResult, insResult] = await Promise.all([
    fetchSoda(BOND_URL, { contractorlicensenumber: licenseNum }),
    fetchSoda(INS_URL,  { contractorlicensenumber: licenseNum }),
  ]);
  return {
    bonded: parseBond(bondResult.records[0]),
    insured: parseInsurance(insResult.records[0]),
  };
}

function toNormalized(record: RawRecord, enrichment?: { bonded: NormalizedLicense["bonded"]; insured: NormalizedLicense["insured"] }): NormalizedLicense {
  return {
    license_number: record.contractorlicensenumber ?? "",
    business_name: record.businessname ?? "",
    status: normalizeStatus(record.contractorlicensestatus, record.statuscode),
    license_type: record.contractorlicensetypecodedesc ?? record.contractorlicensetypecode ?? "",
    bonded: enrichment?.bonded ?? { is_bonded: false, details: "Bond lookup skipped (multi-match context)" },
    insured: enrichment?.insured ?? { has_insurance: false, details: "Insurance lookup skipped (multi-match context)" },
    effective_date: toDate(record.licenseeffectivedate),
    expiration_date: toDate(record.licenseexpirationdate),
  };
}

const info: JurisdictionInfo = {
  code: "WA",
  name: "Washington",
  source: "WA L&I (data.wa.gov)",
  status: "live",
};

async function verify(query: VerifyQuery): Promise<VerifyResult> {
  const retrieved_at = new Date().toISOString();
  const base = {
    jurisdiction: "WA",
    query,
    source_url: SOURCE_URL,
    retrieved_at,
  } as const;

  if (!query.license_number && !query.business_name) {
    return { ...base, found: false, error: "MISSING_QUERY", message: "Provide license_number or business_name" };
  }

  if (query.license_number) {
    const licNum = query.license_number.toUpperCase().trim();
    const { records, error, message } = await fetchSoda(MAIN_URL, { contractorlicensenumber: licNum });
    if (error) return { ...base, found: false, error, message };
    if (records.length === 0) return { ...base, found: false };
    const raw = records[0];
    const enrichment = await enrichLicense(licNum);
    return { ...base, found: true, result: toNormalized(raw, enrichment), raw };
  }

  // Business name: case-insensitive partial match
  const escaped = query.business_name!.trim().replace(/'/g, "''");
  const { records, error, message } = await fetchSoda(MAIN_URL, {
    $where: `upper(businessname) like upper('%${escaped}%')`,
    $limit: "10",
  });

  if (error) return { ...base, found: false, error, message };
  if (records.length === 0) return { ...base, found: false };

  if (records.length === 1) {
    const raw = records[0];
    const licNum = (raw.contractorlicensenumber ?? "").toUpperCase();
    const enrichment = licNum ? await enrichLicense(licNum) : undefined;
    return { ...base, found: true, result: toNormalized(raw, enrichment), raw };
  }

  return {
    ...base,
    found: true,
    matches: records.map((r) => toNormalized(r)),
    raw: records,
  };
}

export const waProvider: Provider = { info, verify };
