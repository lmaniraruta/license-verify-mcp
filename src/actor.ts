import { Actor } from "apify";
import { providers } from "./providers/index.js";

interface ActorInput {
  jurisdiction?: string;
  license_number?: string;
  business_name?: string;
}

await Actor.init();

async function run(): Promise<void> {
  const input = await Actor.getInput<ActorInput>();

  // ── Validate jurisdiction ────────────────────────────────────────────────
  const jurisdiction = (input?.jurisdiction ?? "").toUpperCase().trim();
  if (!jurisdiction) {
    await Actor.setStatusMessage("❌ Invalid input: jurisdiction is required (WA or CA).");
    return;
  }

  const provider = providers.get(jurisdiction);
  if (!provider) {
    const supported = [...providers.keys()].join(", ");
    await Actor.setStatusMessage(
      `❌ Unsupported jurisdiction '${jurisdiction}'. Supported: ${supported}.`
    );
    return;
  }

  // ── Validate query ───────────────────────────────────────────────────────
  if (!input?.license_number && !input?.business_name) {
    await Actor.setStatusMessage(
      "❌ Invalid input: provide at least one of license_number or business_name."
    );
    return;
  }

  // ── Verify ───────────────────────────────────────────────────────────────
  await Actor.setStatusMessage(`🔍 Verifying ${jurisdiction} license…`);

  const result = await provider.verify({
    license_number: input?.license_number,
    business_name: input?.business_name,
  });

  await Actor.pushData(result);

  // ── Charge only on successful lookup (fair pricing → better reviews) ─────
  if (result.found) {
    await Actor.charge({ eventName: "license-verification" });
    const name   = result.result?.business_name ?? result.matches?.[0]?.business_name ?? "";
    const status = result.result?.status ?? (result.matches ? `${result.matches.length} matches` : "");
    await Actor.setStatusMessage(
      `✅ Found: ${name} — ${status}. $0.03 charged.`
    );
  } else if (result.error) {
    await Actor.setStatusMessage(
      `⚠️ Source unavailable (${result.error}): ${result.message ?? ""}. Not charged.`
    );
  } else {
    await Actor.setStatusMessage(
      "ℹ️ No license found for the given query. Not charged."
    );
  }
}

await run();
await Actor.exit();
