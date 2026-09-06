import "dotenv/config";

import { computeCounterfactualContribution } from "@repo/policy";
import type { Basket, SkuPolicy } from "@repo/policy/contracts";

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { db } from "./index";
import {
  commitmentValuesTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  skuPoliciesTable,
} from "./schema";
import { REFERENCE_CART, SEED_MERCHANT_ID } from "./seed";
import {
  DEMO_ALLOWED_COMMITMENTS,
  DEMO_CART,
  DEMO_CATALOGUE,
  DEMO_MERCHANT_ID,
  DEMO_MERCHANT_NAME,
  DEMO_MERCHANT_POLICY_ID,
  DEMO_POLICY_FIELDS,
} from "./demo-scenario";

/**
 * DEV-ONLY helper — `pnpm --filter @repo/database db:seed-session [demo]`.
 *
 * Not part of the product. Nothing in the MVP creates a `negotiation_sessions`
 * row from a UI: a real deployment's checkout system flags a cart `AT_RISK`
 * and hands the buyer agent the id (see `route.ts`'s own module doc). This
 * script stands in for that one step so the `apps/web` console
 * (`/buyer/[sessionId]`, `/merchant/sessions/[sessionId]/*`) can be exercised
 * end to end against a local database.
 *
 * It inserts ONE fresh session (new random id every run) in state `AT_RISK`
 * and prints the id and the console URLs. It never updates or deletes an
 * existing session — the audit ledger is append-only (migration 0002), so a
 * used session cannot be cleanly reset; just run this again for a new one.
 *
 * Two scenarios:
 *   - default: the seeded "Glow Theory" merchant, PRD §18.2's ₹200 per-deal
 *     cap. Requires `db:seed` to have run. A negotiation here shows Tier 1
 *     offers then a round-limit walk-away — no campaign-funded Tier 2 is
 *     feasible under the ₹200 cap (issue-tracker.md ISSUE-017).
 *   - `demo`: a dedicated demo merchant with a ₹700 cap, provisioned by this
 *     script itself (idempotent, does not touch `db:seed`'s data). A
 *     negotiation here shows the whole arc: Tier 1 offer → refuse → a
 *     campaign-funded Tier 2 rescue at a lower total → accept it to close the
 *     deal, or keep declining and the next proposal hits the 2-round limit
 *     (`ROUND_LIMIT_REACHED` → `WALKED_AWAY`). See `demo-scenario.ts` on why
 *     this is a round-limit, not a cap-bound, walk-away.
 */

const DEV_BUYER_AGENT_ID = "dev-buyer-agent";

export type SeedSessionScenario = "default" | "demo";

// ---------------------------------------------------------------------------
// Demo merchant provisioning — idempotent upsert by fixed id, same discipline
// as seed.ts. Only runs for `--scenario demo`.
// ---------------------------------------------------------------------------

async function provisionDemoMerchant(database: NodePgDatabase): Promise<void> {
  await database
    .insert(merchantsTable)
    .values({ id: DEMO_MERCHANT_ID, name: DEMO_MERCHANT_NAME })
    .onConflictDoUpdate({ target: merchantsTable.id, set: { name: DEMO_MERCHANT_NAME } });

  await database
    .insert(merchantPoliciesTable)
    .values({ id: DEMO_MERCHANT_POLICY_ID, merchantId: DEMO_MERCHANT_ID, ...DEMO_POLICY_FIELDS })
    .onConflictDoUpdate({ target: merchantPoliciesTable.id, set: DEMO_POLICY_FIELDS });

  for (const commitment of DEMO_ALLOWED_COMMITMENTS) {
    await database
      .insert(commitmentValuesTable)
      .values({ merchantId: DEMO_MERCHANT_ID, ...commitment })
      .onConflictDoUpdate({
        target: [commitmentValuesTable.merchantId, commitmentValuesTable.commitmentType],
        set: { valueMinor: commitment.valueMinor },
      });
  }

  for (const item of DEMO_CATALOGUE) {
    const fields = {
      name: item.name,
      listPriceMinor: item.listPriceMinor,
      floorPriceMinor: item.floorPriceMinor,
      negotiable: true,
      slowMoving: item.slowMoving,
      affinityGroup: item.affinityGroup,
    };
    await database
      .insert(skuPoliciesTable)
      .values({ id: item.id, merchantId: DEMO_MERCHANT_ID, sku: item.sku, ...fields })
      .onConflictDoUpdate({
        target: [skuPoliciesTable.merchantId, skuPoliciesTable.sku],
        set: fields,
      });
  }
}

// ---------------------------------------------------------------------------

async function seedSession(
  database: NodePgDatabase = db,
  scenario: SeedSessionScenario = "default",
): Promise<string> {
  if (scenario === "demo") await provisionDemoMerchant(database);

  const merchantId = scenario === "demo" ? DEMO_MERCHANT_ID : SEED_MERCHANT_ID;
  const cart: Basket = scenario === "demo" ? DEMO_CART : REFERENCE_CART;

  const [policy] = await database
    .select()
    .from(merchantPoliciesTable)
    .where(eq(merchantPoliciesTable.merchantId, merchantId));

  if (!policy) {
    throw new Error(
      `No policy found for merchant ${merchantId}. ` +
        "Run `pnpm --filter @repo/database db:seed` first.",
    );
  }

  const skuRows = await database
    .select()
    .from(skuPoliciesTable)
    .where(eq(skuPoliciesTable.merchantId, merchantId));

  if (skuRows.length === 0) {
    throw new Error(
      `Merchant ${merchantId} has no SKU catalogue. Run \`pnpm --filter @repo/database db:seed\` first.`,
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

  const counterfactualContributionMinor = computeCounterfactualContribution(cart, skuPolicies);

  const [session] = await database
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: DEV_BUYER_AGENT_ID,
      state: "AT_RISK",
      roundIndex: 0,
      tier1Refused: false,
      policyVersion: policy.policyVersion,
      originalBasket: cart,
      counterfactualContributionMinor,
      eligibilitySignals: {
        note: `inserted by db:seed-session (${scenario}) for local UI testing — not a real eligibility signal`,
      },
    })
    .returning({ id: negotiationSessionsTable.id });

  return session!.id;
}

function parseScenario(argv: readonly string[]): SeedSessionScenario {
  for (const arg of argv) {
    if (arg === "demo" || arg === "--scenario=demo" || arg === "--demo") return "demo";
    if (arg === "--scenario") {
      const next = argv[argv.indexOf(arg) + 1];
      if (next === "demo") return "demo";
    }
  }
  return "default";
}

if (require.main === module) {
  const scenario = parseScenario(process.argv.slice(2));
  seedSession(db, scenario)
    .then((sessionId) => {
      // apps/web dev server (`next dev --port 3000`).
      const web = "http://localhost:3000";
      const lines = [
        "",
        `Seeded an AT_RISK negotiation session (${scenario} scenario): ${sessionId}`,
        "",
        "  Buyer console:   " + `${web}/buyer/${sessionId}`,
        "  Merchant monitor:" + `${web}/merchant/sessions/${sessionId}`,
        "  Offer status:    " + `${web}/merchant/sessions/${sessionId}/offers`,
        "  Audit trail:     " + `${web}/merchant/sessions/${sessionId}/audit`,
        "",
      ];
      if (scenario === "demo") {
        lines.push(
          "Walkthrough: in the buyer console send a message, then",
          '"Decline & continue". Round 1 is a Tier 1 offer; refuse it and',
          "round 2 is a campaign-funded Tier 2 rescue at a lower total —",
          "HOLD_RESERVED + DILUTION_WITHIN_CAPS with the campaign spend show",
          "live on the audit trail. Accept the rescue to close the deal, or",
          "decline again — the next proposal hits the 2-round limit and the",
          "session ends WALKED_AWAY, with the walk-away card on the audit trail.",
        );
      } else {
        lines.push(
          "This is the §18.2 scenario (₹200 cap): offers stay Tier 1 and the",
          "session ends at the round limit. For the Tier 2 rescue story, run:",
          "  pnpm --filter @repo/database db:seed-session demo",
        );
      }
      lines.push("");
      console.log(lines.join("\n"));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("seed-session failed:", error);
      process.exit(1);
    });
}

export { seedSession };
