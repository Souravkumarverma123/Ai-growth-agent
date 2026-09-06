import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { campaignHoldsTable, type SelectCampaignHold } from "../models/offer";
import { merchantPoliciesTable } from "../models/merchant";

export type CampaignBudgetBreakdown = {
  totalMinor: number;
  reservedMinor: number;
  committedMinor: number;
  /** `total − reserved − committed` (PRD §6.5). */
  availableMinor: number;
};

/**
 * The single source of what "outstanding" campaign budget means for a
 * merchant, split by hold state:
 *
 * - `reservedMinor` — RESERVED holds that have not passed `expires_at`. An
 *   expired-but-still-RESERVED hold is excluded: nothing sweeps an abandoned
 *   hold to RELEASED yet, and `campaignHoldsTable.expiresAt`'s own doc ("An
 *   abandoned offer returns its budget on expiry") is a hold-visible
 *   invariant — its amount has already returned to `available`. This is the
 *   same predicate `reserveCampaignBudget` (TICKET-107/ISSUE-004) uses for
 *   its outstanding read.
 * - `committedMinor` — COMMITTED holds, always. A permanent spend, never
 *   time-limited.
 *
 * `reserved` and `committed` are never stored columns — the frozen schema
 * (CONTRACTS.md §1) forbids adding one — so both are derived here by summing
 * `campaign_holds.amount_minor` per state.
 *
 * Read-only snapshot, no row lock: a display / feasibility read, never the
 * decision input. The safe-under-concurrency check still happens at mint time
 * inside `reserveCampaignBudget`.
 *
 * Returns `null` when the merchant has no policy row (mirrors
 * `getMerchantPolicy`).
 */
export async function getCampaignBudgetBreakdown(
  database: NodePgDatabase,
  merchantId: string,
): Promise<CampaignBudgetBreakdown | null> {
  const [policy] = await database
    .select({ campaignBudgetTotalMinor: merchantPoliciesTable.campaignBudgetTotalMinor })
    .from(merchantPoliciesTable)
    .where(eq(merchantPoliciesTable.merchantId, merchantId));

  if (!policy) {
    return null;
  }

  const breakdownResult = await database.execute<{
    reserved_minor: string;
    committed_minor: string;
  }>(sql`
    SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE state = 'RESERVED' AND expires_at > now()), 0) AS reserved_minor,
      COALESCE(SUM(amount_minor) FILTER (WHERE state = 'COMMITTED'), 0) AS committed_minor
    FROM campaign_holds
    WHERE merchant_id = ${merchantId}
  `);

  const row = breakdownResult.rows[0];
  const reservedMinor = Number(row?.reserved_minor ?? 0);
  const committedMinor = Number(row?.committed_minor ?? 0);
  const totalMinor = policy.campaignBudgetTotalMinor;

  return {
    totalMinor,
    reservedMinor,
    committedMinor,
    availableMinor: totalMinor - reservedMinor - committedMinor,
  };
}

/**
 * TICKET-204 — `available` alone, for tiering-time feasibility checks
 * (`assignTiersAndFeasibility`'s `availableCampaignBudgetMinor` input,
 * `packages/policy/generation/tiering.ts`).
 *
 * A thin projection of `getCampaignBudgetBreakdown` so the "outstanding"
 * predicate (RESERVED-and-unexpired, or COMMITTED) is defined in exactly one
 * place and this can never drift from `reserveCampaignBudget` or from the
 * merchant countdown (TICKET-503). Throws on a missing policy row — a
 * tiering read for a merchant with no policy is a bug, not a not-found.
 */
export async function getAvailableCampaignBudgetMinor(
  database: NodePgDatabase,
  merchantId: string,
): Promise<number> {
  const breakdown = await getCampaignBudgetBreakdown(database, merchantId);
  if (!breakdown) {
    throw new Error(`getAvailableCampaignBudgetMinor: no merchant_policies row for merchant ${merchantId}`);
  }
  return breakdown.availableMinor;
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
