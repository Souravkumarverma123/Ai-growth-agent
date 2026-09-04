import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { SelectCampaignHold } from "../models/offer";

/**
 * TICKET-107 — atomic campaign-budget reservation (PRD §6.5, CONTRACTS.md §8).
 *
 * `available = total − reserved − committed` (the comment above
 * `campaignHoldsTable` in `models/offer.ts`). `reserved` and `committed` are
 * never stored as columns — frozen schema (CONTRACTS.md §1) forbids adding
 * one — they are derived by summing `campaign_holds.amount_minor` for the
 * merchant across the RESERVED and COMMITTED states every time this runs.
 *
 * "Reservation is an atomic conditional decrement under a row lock — not
 * read, then check, then write" (PRD §6.5).
 *
 * ISSUE-004: the initially-attempted design — one single `WITH ... FOR
 * UPDATE, outstanding AS (...), INSERT ... SELECT ... WHERE ...` CTE
 * statement — was measured, under this ticket's own real-concurrency test,
 * to be UNSAFE: it over-admitted (18 of 20 reservations succeeded against a
 * budget sized for exactly 10). Root cause: PostgreSQL fixes one MVCC
 * snapshot per *statement* at read-committed level. `FOR UPDATE`'s wait-then-
 * recheck behaviour (EvalPlanQual) only refreshes the specific locked row
 * (`merchant_policies`); the sibling "outstanding" CTE, reading the
 * unrelated `campaign_holds` table in the same statement, keeps using the
 * *original* pre-wait snapshot — so it can miss holds committed by other
 * transactions while we were blocked waiting for the lock. See
 * issue-tracker.md ISSUE-004 for the full account.
 *
 * The safe replacement below still satisfies "not read, then check, then
 * write" in the sense that matters — no other transaction can observe or
 * mutate this merchant's outstanding holds between the read and the write —
 * but does it with three sequential statements inside **one database
 * transaction**, not one SQL statement:
 *
 *   1. `SELECT campaign_budget_total_minor FROM merchant_policies WHERE
 *      merchant_id = $1 FOR UPDATE` — blocks until any other transaction
 *      reserving for this merchant commits and releases the same row lock.
 *   2. A **fresh** statement summing `campaign_holds` for RESERVED/COMMITTED
 *      states. Because it is a new statement, read-committed gives it a
 *      new snapshot taken *after* step 1 acquired the lock — and since every
 *      other reservation attempt for this merchant must also pass through
 *      step 1's lock before it can insert anything, nothing in flight can be
 *      invisible here: a concurrent attempt has either already committed
 *      (and this read sees it) or is still blocked on step 1 (and cannot
 *      have inserted anything yet).
 *   3. A conditional `INSERT` in application code, still inside the same
 *      transaction and therefore still holding the row lock, so nothing can
 *      interleave between the read in step 2 and this write.
 *
 * Deliberately generic over the drizzle client (`NodePgDatabase`, not the
 * real exported `db`) so this can run against `getTestDb()` in tests and the
 * real `db` in production without a code fork.
 */

export type ReserveCampaignBudgetParams = {
  merchantId: string;
  offerId: string;
  amountMinor: number;
  expiresAt: Date;
};

export type ReserveCampaignBudgetResult =
  | { reserved: true; hold: SelectCampaignHold }
  | { reserved: false; reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };

type CampaignHoldRow = {
  id: string;
  merchant_id: string;
  offer_id: string;
  amount_minor: number;
  state: SelectCampaignHold["state"];
  expires_at: Date;
  resolved_at: Date | null;
  created_at: Date | null;
};

function toSelectCampaignHold(row: CampaignHoldRow): SelectCampaignHold {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    offerId: row.offer_id,
    amountMinor: row.amount_minor,
    state: row.state,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/**
 * Attempts to reserve `amountMinor` of campaign budget for `merchantId`
 * against `offerId`. Returns the inserted hold row on success, or
 * `CAMPAIGN_BUDGET_EXHAUSTED` if the amount doesn't fit within `available`
 * once every concurrent reservation for this merchant has been forced to
 * serialize on the `merchant_policies` row lock (see the module comment for
 * why this needs three statements in one transaction, not one).
 *
 * Callers are expected to run the per-deal-cap check
 * (`@repo/policy` `evaluatePerDealCap`) first — that check is a fixed
 * ceiling on `amountMinor` alone and needs no database, so it should never
 * reach this function if it fails (PRD §17 row 3: a shortfall over the
 * per-deal cap walks away without ever touching campaign budget). That check
 * only bounds `amountMinor` from above, so this function still validates it
 * is a positive integer itself before opening a transaction: a non-positive
 * or non-integer value must never reach the comparison at step 2 or the
 * `INSERT` at step 3, since a negative amount would inflate `available` for
 * later callers and a zero amount would consume this offer's one hold slot
 * without reserving any real funds.
 */
export async function reserveCampaignBudget(
  database: NodePgDatabase,
  params: ReserveCampaignBudgetParams,
): Promise<ReserveCampaignBudgetResult> {
  const { merchantId, offerId, amountMinor, expiresAt } = params;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(
      `reserveCampaignBudget: amountMinor must be a positive integer (${amountMinor})`,
    );
  }

  return database.transaction(async (tx): Promise<ReserveCampaignBudgetResult> => {
    // Step 1: lock this merchant's policy row. Blocks until any other
    // in-flight reservation for the same merchant commits and releases it.
    const policyResult = await tx.execute<{ campaign_budget_total_minor: number }>(sql`
      SELECT campaign_budget_total_minor
      FROM merchant_policies
      WHERE merchant_id = ${merchantId}
      FOR UPDATE
    `);

    const policyRow = policyResult.rows[0];
    if (!policyRow) {
      return { reserved: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };
    }

    // Step 2: a fresh statement, so read-committed hands it a fresh
    // snapshot taken only now — after we hold the lock from step 1. Every
    // other concurrent reservation attempt for this merchant is either
    // already committed (and counted here) or still blocked on step 1 (and
    // therefore cannot have inserted anything yet). Never stale.
    const outstandingResult = await tx.execute<{ outstanding_minor: string }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0) AS outstanding_minor
      FROM campaign_holds
      WHERE merchant_id = ${merchantId}
        AND state IN ('RESERVED', 'COMMITTED')
    `);

    const outstandingMinor = Number(outstandingResult.rows[0]?.outstanding_minor ?? 0);
    const availableMinor = policyRow.campaign_budget_total_minor - outstandingMinor;

    if (amountMinor > availableMinor) {
      return { reserved: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };
    }

    // Step 3: still inside the same transaction, still holding the lock
    // from step 1 — nothing could have interleaved since step 2's read.
    const insertResult = await tx.execute<CampaignHoldRow>(sql`
      INSERT INTO campaign_holds (merchant_id, offer_id, amount_minor, state, expires_at)
      VALUES (${merchantId}, ${offerId}, ${amountMinor}, 'RESERVED', ${expiresAt})
      RETURNING
        id,
        merchant_id,
        offer_id,
        amount_minor,
        state,
        expires_at,
        resolved_at,
        created_at
    `);

    const row = insertResult.rows[0]!;
    return { reserved: true, hold: toSelectCampaignHold(row) };
  });
}
