# license-verify-mcp

Verify contractor license status mid-task. Returns normalized JSON with `active|expired|suspended|revoked` status, bond details, and insurance. Two delivery modes: **MCP server** (stdio, for Claude/agent use) and **Apify Actor** (pay-per-event, agentic-payments eligible).

---

## Jurisdictions

| State | Status | Source | Bond + Insurance |
|---|---|---|---|
| **WA** | ✅ Live | WA L&I open data (data.wa.gov) | ✅ Real data (bzff-4fmt + ciwg-agsx datasets) |
| **CA** | ⚠️ Beta | CSLB HTML (cslb.ca.gov) | ✅ Parsed when CSLB is up |

**Washington is the reliable, production-ready jurisdiction.** Official WA L&I open data is served via Socrata JSON — no scraping, no rate limits, bond and insurance data included from dedicated datasets.

**California is beta.** CSLB does not publish an open API; the provider fetches the HTML detail page directly. CSLB rate-limits or 503s automated requests intermittently. When unavailable, `verify_license` returns a clean `SESSION_ERROR` — **you are never charged on source failures.** Do not rely on CA for production workflows until a stable server-side CSLB run is confirmed.

---

## Apify Actor

**Agentic-payments eligible** — pay-per-event pricing + limited permissions + no Standby mode.

### Pricing

| Event | Price |
|---|---|
| `license-verification` | **$0.03 per lookup** |

Charged **only on `found: true`**. Validation errors, not-found results, and source failures are not charged.

### Input

```json
{
  "jurisdiction": "WA",
  "license_number": "ECOSTSC758NN"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `jurisdiction` | `"WA" \| "CA"` | ✅ | WA = live; CA = beta |
| `license_number` | string | one of ↓ | WA: alphanumeric. CA: numeric, ≤8 digits |
| `business_name` | string | one of ↑ | WA only. Partial match, may return `matches[]` |

### Output (default dataset)

```json
{
  "found": true,
  "jurisdiction": "WA",
  "query": { "license_number": "ECOSTSC758NN" },
  "result": {
    "license_number": "ECOSTSC758NN",
    "business_name": "!ECO STAR C G CONSTRUCTION LLC",
    "status": "active",
    "license_type": "CONSTRUCTION CONTRACTOR",
    "bonded": {
      "is_bonded": true,
      "details": "Surety: NORTH RIVER INSURANCE COMPANY THE; Bond #: 46CF842686; Amount: $30,000; Effective: 2025-08-05; Expires: Until Canceled"
    },
    "insured": {
      "has_insurance": true,
      "details": "Carrier: State National Ins Co Inc; Policy: NXT9PTHTLT-01-GL; Coverage: $1,000,000; Agency: Next Insurance Inc; Effective: 2026-06-12; Expires: 2027-06-12"
    },
    "effective_date": "2025-08-15",
    "expiration_date": "2027-08-15"
  },
  "source_url": "https://data.wa.gov/resource/m8qx-ubtq",
  "retrieved_at": "2026-06-26T01:34:37.598Z",
  "raw": { ... }
}
```

`status` is always one of: `active` | `expired` | `suspended` | `revoked` | `unknown`.

On failure: `{ "found": false, "error": "SESSION_ERROR|NETWORK_ERROR|...", "message": "..." }` — never a crash, never a charge.

### Local test

```bash
npm install
npm run build
echo '{"jurisdiction":"WA","license_number":"ECOSTSC758NN"}' \
  > storage/key_value_stores/default/INPUT.json
npx apify run
```

---

## MCP Server (stdio)

For use with Claude Desktop, Smithery, or any MCP-compatible agent.

### Tools

**`verify_license`** — verify a contractor's license status.
- `jurisdiction` (required): `"WA"` or `"CA"`
- `license_number` and/or `business_name` (at least one required)

**`list_supported_jurisdictions`** — list all states with their status and data source.

### Config (Claude Desktop)

```json
{
  "mcpServers": {
    "license-verify": {
      "command": "node",
      "args": ["/absolute/path/to/license-verify-mcp/dist/index.js"]
    }
  }
}
```

### Run

```bash
npm install && npm run build
npm run start:mcp   # stdio MCP server
npm run smoke       # hit real WA + CA endpoints, must be 8/8 PASS
```

---

## Adding a State

1. Create `src/providers/<CODE>.ts` implementing the `Provider` interface (`{ info, verify() }`)
2. Register it in `src/providers/index.ts`

No other changes needed in server or Actor.

## License

MIT
