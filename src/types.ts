export interface NormalizedLicense {
  license_number: string;
  business_name: string;
  status: "active" | "expired" | "suspended" | "revoked" | "unknown";
  license_type: string;
  bonded: { is_bonded: boolean; details?: string };
  insured: { has_insurance: boolean; details?: string };
  effective_date?: string;
  expiration_date?: string;
}

export interface VerifyQuery {
  license_number?: string;
  business_name?: string;
}

export interface VerifyResult {
  found: boolean;
  jurisdiction: string;
  query: VerifyQuery;
  result?: NormalizedLicense;
  matches?: NormalizedLicense[];
  source_url: string;
  retrieved_at: string;
  raw?: unknown;
  error?: string;
  message?: string;
}

export interface JurisdictionInfo {
  code: string;
  name: string;
  source: string;
  status: "live" | "coming_soon";
}

export interface Provider {
  info: JurisdictionInfo;
  verify(query: VerifyQuery): Promise<VerifyResult>;
}
