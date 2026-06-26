#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { providers } from "./providers/index.js";
import type { JurisdictionInfo } from "./types.js";

const server = new Server(
  { name: "license-verify-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "verify_license",
      description: `Verify a contractor's current license or registration status before awarding work, signing a contract, or performing due diligence.

Call this tool when you need to:
- Confirm a contractor is currently licensed and in good standing
- Check whether a license is active, expired, suspended, or revoked
- Look up a contractor by license/registration number (preferred — exact match) or by business name (partial match, may return multiple)
- Retrieve license type, effective and expiration dates from official government records

Currently supports: WA (Washington State) via WA L&I open data (includes real bond + insurance data); CA (California) via CSLB Check-A-License.
Call list_supported_jurisdictions first if unsure whether a state is supported.

Returns structured JSON with found status, normalized status enum (active|expired|suspended|revoked|unknown), license type, dates, bond/insurance notes, and the raw source record. If business_name matches multiple contractors, a "matches" array (up to 10) is returned instead of a single result.

At least one of license_number or business_name must be provided.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          jurisdiction: {
            type: "string",
            description:
              "Two-letter US state code. Supported: 'WA' (Washington, via WA L&I open data), 'CA' (California, via CSLB). Call list_supported_jurisdictions to see all options.",
          },
          license_number: {
            type: "string",
            description:
              "Contractor license or registration number to look up (e.g. 'ECOSTSC758NN'). Case-insensitive exact match. Preferred over business_name for unambiguous results.",
          },
          business_name: {
            type: "string",
            description:
              "Business name or partial business name to search for. Case-insensitive partial match. May return multiple results if ambiguous — check the 'matches' array in that case.",
          },
        },
        required: ["jurisdiction"],
      },
    },
    {
      name: "list_supported_jurisdictions",
      description: `List all US states (jurisdictions) supported by this contractor license verification server, with their data source and availability status.

Call this tool when:
- You need to check whether a specific state is supported before calling verify_license
- You want to display available options to the user
- You need the authoritative data source URL for a jurisdiction

Returns an array of jurisdictions with code, full name, source, and status (live or coming_soon).`,
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "list_supported_jurisdictions") {
    const jurisdictions: JurisdictionInfo[] = Array.from(providers.values()).map((p) => p.info);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(jurisdictions, null, 2) }],
    };
  }

  if (name === "verify_license") {
    const typedArgs = args as {
      jurisdiction?: string;
      license_number?: string;
      business_name?: string;
    };

    const jurisdiction = (typedArgs.jurisdiction ?? "").toUpperCase().trim();

    if (!jurisdiction) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "MISSING_JURISDICTION",
            message: "jurisdiction is required. Call list_supported_jurisdictions to see options.",
          }),
        }],
      };
    }

    const provider = providers.get(jurisdiction);
    if (!provider) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "UNSUPPORTED_JURISDICTION",
            message: `'${jurisdiction}' is not currently supported. Call list_supported_jurisdictions to see available options.`,
          }),
        }],
      };
    }

    const { license_number, business_name } = typedArgs;
    if (!license_number && !business_name) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "MISSING_QUERY",
            message: "At least one of license_number or business_name is required.",
          }),
        }],
      };
    }

    const result = await provider.verify({ license_number, business_name });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` }),
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
