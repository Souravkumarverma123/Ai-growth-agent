import "dotenv/config";

import { computeCounterfactualContribution } from "@repo/policy";
import type { SkuPolicy } from "@repo/policy/contracts";

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { db } from "./index";
import { merchantPoliciesTable, negotiationSessionsTable, skuPoliciesTable } from "./schema";
import { REFERENCE_CART, SEED_MERCHANT_ID } from "./seed";

/**
 * DEV-ONLY helper — `pnpm --filter @repo/database db:seed-session`.
 *
 * Not part of the product. Nothing in the MVP creates a `negotiation_sessions`
 * row from a UI: a real deployment's checkout system flags a cart `AT_RISK`
 * and hands the buyer agent the id (see `route.ts`'s own module doc). This
 * script stands in for that one step so the `apps/web` console
 * (`/buyer/[sessionId]`, `/merchant/sessions/[sessionId]/*`) can be exercised
 * end to end against a local database.
 *
 * It inserts ONE fresh session (new random id every run) in state `AT_RISK`,
 * against the seeded "Glow Theory" merchant and PRD §18.2's reference cart
 * (Vitamin C Serum + Gentle Cleanser at list), and prints the id and the
 * URLs. It never updates or deletes an existing session — the audit ledger is
 * append-only (migration 0002), so a used session cannot be cleanly reset;
 * just run this again for a new one, or recreate the database for a clean
 * slate.
 *
 * Requires `pnpm --filter @repo/database db:seed` to have run first (this
 * needs the merchant, its policy, and the catalogue).
 */

const DEV_BUYER_AGENT_ID = "dev-buyer-agent";

async function seedSession(database: NodePgDatabase = db): Promise<string> {
  const [policy] = await database
    .select()
    .from(merchantPoliciesTable)
    .where(eq(merchantPoliciesTable.merchantId, SEED_MERCHANT_ID));

  if (!policy) {
    throw new Error(
      `No policy found for the seed merchant ${SEED_MERCHANT_ID}. ` +
        "Run `pnpm --filter @repo/database db:seed` first.",
    );
  }

  const skuRows = await database
    .select()
    .from(skuPoliciesTable)
    .where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));

  if (skuRows.length === 0) {
    throw new Error(
      "The seed merchant has no SKU catalogue. Run `pnpm --filter @repo/database db:seed` first.",
    );
  }

  // `id` on the row → `skuId` on the contract type; every other field lines up.
  const skuPolicies: SkuPolicy[] = skuRows.map((row) => ({
    skuId: row.id,
    merchantId: row.merchantId,
    sku: row.sku,
    name: row.name,
    listPriceMinor: row.listPriceMinor,
    floorPriceMinor: row.floorPriceMinor,
    negotiable: row.negotiable,
    slowMoving: row.slowMoving,
    affinityGroup: row.affinityGroup,
  }));

  const counterfactualContributionMinor = computeCounterfactualContribution(
    REFERENCE_CART,
    skuPolicies,
  );

  const [session] = await database
    .insert(negotiationSessionsTable)
    .values({
      merchantId: SEED_MERCHANT_ID,
      buyerAgentId: DEV_BUYER_AGENT_ID,
      state: "AT_RISK",
      roundIndex: 0,
      tier1Refused: false,
      policyVersion: policy.policyVersion,
      originalBasket: REFERENCE_CART,
      counterfactualContributionMinor,
      eligibilitySignals: {
        note: "inserted by db:seed-session for local UI testing — not a real eligibility signal",
      },
    })
    .returning({ id: negotiationSessionsTable.id });

  return session!.id;
}

if (require.main === module) {
  seedSession()
    .then((sessionId) => {
      // apps/web dev server (`next dev --port 3000`).
      const web = "http://localhost:3000";
      console.log(
        [
          "",
          `Seeded an AT_RISK negotiation session: ${sessionId}`,
          "",
          "  Buyer console:   " + `${web}/buyer/${sessionId}`,
          "  Merchant monitor:" + `${web}/merchant/sessions/${sessionId}`,
          "  Offer status:    " + `${web}/merchant/sessions/${sessionId}/offers`,
          "  Audit trail:     " + `${web}/merchant/sessions/${sessionId}/audit`,
          "",
          "To reach the walk-away card: in the buyer console, send a message,",
          'then "Decline & continue" each offer. After round 3 the next proposal',
          "hits the round cap and the session ends WALKED_AWAY — the card then",
          "renders at the top of the audit trail.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("seed-session failed:", error);
      process.exit(1);
    });
}

export { seedSession };
