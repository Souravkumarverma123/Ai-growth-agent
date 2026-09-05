import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { campaignHoldsTable, type SelectCampaignHold } from "../models/offer";
import { merchantPoliciesTable } from "../models/merchant";

/**
 * TICKET-204 — read-only campaign-budget snapshot, for tiering-time
 * feasibility checks (`assignTiersAndFeasibility`'s
 * `availableCampaignBudgetMinor` input, `packages/policy/generation/
 * tiering.ts`).
 *
 * Deliberately NOT the row-locked, transactional read inside
 * `campaign-holds.ts`'s `reserveCampaignBudget` (TICKET-107/ISSUE-004) — this
 * is only a snapshot to decide which candidates *look* feasible before the
 * model picks one; the real, safe-under-concurrency check still happens at
 * mint time via `reserveCampaignBudget` itself, which every Tier 2 mint in
 * this ticket's `propose` procedure goes through before calling `mintOffer`.
 * A stale snapshot here can only make a Tier 2 candidate look feasible when
 * it (rarely) no longer is by mint time — `mintOffer`'s own
 * `CampaignBudgetReservationOutcome` handling (`{ reserved: false,
 * reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" }`) is exactly the documented,
 * expected outcome for that race, not a bug this snapshot needs to prevent.
 *
 * Mirrors `reserveCampaignBudget`'s own `available = total - outstanding`
 * arithmetic (RESERVED-and-unexpired, or COMMITTED) so the two never
 * disagree about what "outstanding" means.
 */
export async function getAvailableCampaignBudgetMinor(
  database: NodePgDatabase,
  merchantId: string,
): Promise<number> {
  const [policy] = await database
    .select({ campaignBudgetTotalMinor: merchantPoliciesTable.campaignBudgetTotalMinor })
    .from(merchantPoliciesTable)
    .where(eq(merchantPoliciesTable.merchantId, merchantId));

  if (!policy) {
    throw new Error(`getAvailableCampaignBudgetMinor: no merchant_policies row for merchant ${merchantId}`);
  }

  const outstandingResult = await database.execute<{ outstanding_minor: string }>(sql`
    SELECT COALESCE(SUM(amount_minor), 0) AS outstanding_minor
    FROM campaign_holds
    WHERE merchant_id = ${merchantId}
      AND (
        state = 'COMMITTED'
        OR (state = 'RESERVED' AND expires_at > now())
      )
  `);

  const outstandingMinor = Number(outstandingResult.rows[0]?.outstanding_minor ?? 0);
  return policy.campaignBudgetTotalMinor - outstandingMinor;
}

/** One hold per offer (`campaignHoldsTable.offerId` is unique) — used by
 *  `respondToOffer` to find the Tier 2 hold to release on a buyer decline. */
export async function getCampaignHoldByOfferId(
  database: NodePgDatabase,
  offerId: string,
): Promise<SelectCampaignHold | undefined> {
  const [hold] = await database
    .select()
    .from(campaignHoldsTable)
    .where(eq(campaignHoldsTable.offerId, offerId));
  return hold;
}
