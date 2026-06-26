import type { Provider, JurisdictionInfo, VerifyResult, VerifyQuery, NormalizedLicense } from "../types.js";

// CSLB "Check A License" — California Contractors State License Board
// Detail page URL: https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum={num}
//
// Access pattern: two-step
//   1. GET CheckLicense.aspx  →  receive session cookie (TS01c60549=...)
//   2. GET LicenseDetail.aspx?LicNum={num}  with Cookie header  →  HTML detail page
//
// HTTP 503 = license number not found (CSLB's behavior for unknown records)
// HTML fields extracted by id:
//   MainContent_BusInfo   — business name (first text node before <br>)
//   MainContent_IssDt     — issue date (MM/DD/YYYY)
//   MainContent_ExpDt     — expiration date (MM/DD/YYYY)
//   MainContent_Status    — status text inside <strong>
//   MainContent_ClassCellTable — license classification link text
//   MainContent_BondingCellTable — bond details (HTML block)
//   MainContent_WCStatus  — workers' comp status (HTML block)

const FORM_URL   = "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx";
const DETAIL_URL = "https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx";
const SOURCE_URL = FORM_URL;
const TIMEOUT_MS = 10_000;

const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function extract(html: string, pattern: RegExp): string | undefined {
  return html.match(pattern)?.[1]?.trim()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'") || undefined;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeStatus(text: string): NormalizedLicense["status"] {
  const t = text.toLowerCase();
  if (t.includes("current and active")) return "active";
  if (t.includes("expired")) return "expired";
  if (t.includes("suspended")) return "suspended";
  if (t.includes("revoked")) return "revoked";
  return "unknown";
}

function parseBondFromHtml(bondSection: string): NormalizedLicense["bonded"] {
  if (!bondSection.includes("Contractor's Bond") && !bondSection.includes("Contractor&#39;s Bond")) {
    return { is_bonded: false, details: "No Contractor's Bond section found on CSLB page" };
  }

  // Patterns handle both single-quoted and double-quoted attributes in live CSLB HTML
  const company    = extract(bondSection, /filed a Contractor.s Bond with\s*<a[^>]*>([^<]+)<\/a>/);
  const bondNum    = extract(bondSection, /<strong>Bond Number:\s*<\/strong>\s*([\d\w-]+)/);
  const bondAmt    = extract(bondSection, /<strong>Bond Amount:\s*<\/strong>\s*(\$[\d,]+)/);
  const effDate    = extract(bondSection, /<strong>Effective Date:<\/strong>\s*([\d\/]+)/);
  const cancelDate = extract(bondSection, /<strong>Cancellation Date:<\/strong>\s*([\d\/]+)/);

  const parts: string[] = [];
  if (company)    parts.push(`Surety: ${company}`);
  if (bondAmt)    parts.push(`Amount: ${bondAmt}`);
  if (bondNum)    parts.push(`Bond #: ${bondNum}`);
  if (effDate)    parts.push(`Effective: ${effDate}`);
  if (cancelDate) parts.push(`Cancelled: ${cancelDate}`);

  const is_bonded = !!bondAmt || !!company;
  return {
    is_bonded,
    details: parts.length ? parts.join("; ") : stripTags(bondSection).slice(0, 300),
  };
}

function parseWcFromHtml(wcHtml: string): NormalizedLicense["insured"] {
  const text = stripTags(wcHtml).toLowerCase();
  if (text.includes("exempt")) {
    return { has_insurance: false, details: "Exempt from workers' compensation — no employees certified" };
  }
  if (text.includes("workers compensation") || text.includes("workers' compensation")) {
    const carrier = extract(wcHtml, /Carrier:\s*([^<]+)/) ?? extract(wcHtml, /<a[^>]*>([^<]+)<\/a>/);
    const policy  = extract(wcHtml, /Policy:\s*([^<\s]+)/);
    const parts: string[] = ["Workers' compensation insurance on file"];
    if (carrier) parts.push(`Carrier: ${carrier}`);
    if (policy)  parts.push(`Policy: ${policy}`);
    return { has_insurance: true, details: parts.join("; ") };
  }
  return { has_insurance: false, details: "Workers' compensation status could not be determined" };
}

async function getSessionCookie(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FORM_URL, { headers: BROWSER_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (res.status !== 200) return null;  // 503 = service down, not a usable session
    const raw = res.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

interface DetailResult {
  status: number;
  html: string;
}

async function fetchDetail(licNum: string, cookie: string): Promise<DetailResult | { error: string; message: string }> {
  const url = `${DETAIL_URL}?LicNum=${encodeURIComponent(licNum)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookie, Referer: FORM_URL },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const html = res.status !== 503 ? await res.text() : "";
    return { status: res.status, html };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return {
      error: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      message: isTimeout
        ? `CSLB request timed out after ${TIMEOUT_MS}ms`
        : `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseHtml(html: string, licNum: string): NormalizedLicense | null {
  const busName = extract(html, /id="MainContent_BusInfo"[^>]*>([^<]+)/);
  if (!busName) return null;

  const statusText = extract(html, /id="MainContent_Status"[\s\S]*?<strong>([\s\S]*?)<\/strong>/) ?? "";
  const issDate    = extract(html, /id="MainContent_IssDt"[^>]*>([^<]+)/);
  const expDate    = extract(html, /id="MainContent_ExpDt"[^>]*>([^<]+)/);
  const classText  = extract(html, /id="MainContent_ClassCellTable"[\s\S]*?<a[^>]*>([^<]+)/);

  // Slice HTML between known landmarks to avoid nested-</td> truncation
  const bondStart  = html.indexOf("MainContent_BondingCellTable");
  const wcStart    = html.indexOf("MainContent_WCStatus");
  const btnStart   = html.indexOf("MainContent_ButtonPanel");
  const bondSection = bondStart >= 0 && wcStart > bondStart ? html.slice(bondStart, wcStart) : "";
  const wcSection   = wcStart >= 0
    ? html.slice(wcStart, btnStart > wcStart ? btnStart : wcStart + 2000)
    : "";

  return {
    license_number: licNum,
    business_name: busName,
    status: normalizeStatus(statusText),
    license_type: classText ?? "",
    bonded: parseBondFromHtml(bondSection),
    insured: parseWcFromHtml(wcSection),
    effective_date: issDate,
    expiration_date: expDate,
  };
}

const info: JurisdictionInfo = {
  code: "CA",
  name: "California",
  source: "CSLB (cslb.ca.gov)",
  status: "live",
};

async function verify(query: VerifyQuery): Promise<VerifyResult> {
  const retrieved_at = new Date().toISOString();
  const base = {
    jurisdiction: "CA",
    query,
    source_url: SOURCE_URL,
    retrieved_at,
  } as const;

  if (query.business_name && !query.license_number) {
    return {
      ...base,
      found: false,
      error: "NOT_SUPPORTED",
      message: "Business name search is not yet supported for CA (CSLB). Provide a numeric license_number instead.",
    };
  }

  if (!query.license_number) {
    return {
      ...base,
      found: false,
      error: "MISSING_QUERY",
      message: "CA requires a numeric CSLB license_number (e.g. '1100000').",
    };
  }

  const licNum = query.license_number.trim();
  if (!/^\d{1,8}$/.test(licNum)) {
    return {
      ...base,
      found: false,
      error: "INVALID_LICENSE_FORMAT",
      message: "CA CSLB license numbers are numeric, 1–8 digits (e.g. '1100000'). No letters or special chars.",
    };
  }

  const cookie = await getSessionCookie();
  if (!cookie) {
    return {
      ...base,
      found: false,
      error: "SESSION_ERROR",
      message: "Could not establish a CSLB session (network issue or service down). Try again.",
    };
  }

  const detail = await fetchDetail(licNum, cookie);
  if ("error" in detail) {
    return { ...base, found: false, error: detail.error, message: detail.message };
  }

  if (detail.status === 503) {
    return { ...base, found: false };
  }

  if (detail.status !== 200) {
    return {
      ...base,
      found: false,
      error: "HTTP_ERROR",
      message: `CSLB returned HTTP ${detail.status}`,
    };
  }

  const parsed = parseHtml(detail.html, licNum);
  if (!parsed) {
    return {
      ...base,
      found: false,
      error: "PARSE_ERROR",
      message: "Could not parse CSLB license detail page. Page structure may have changed.",
    };
  }

  return {
    ...base,
    found: true,
    result: parsed,
    raw: {
      source: "CSLB HTML page",
      url: `${DETAIL_URL}?LicNum=${licNum}`,
      html_length: detail.html.length,
    },
  };
}

export const caProvider: Provider = { info, verify };
