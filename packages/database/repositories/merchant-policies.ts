import { asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { CommitmentType } from "@repo/policy/contracts";

import { commitmentValuesTable, merchantPoliciesTable } from "../schema";
import type { SelectMerchantPolicy } from "../models/merchant";

/**
 * TICKET-501 — merchant policy configuration and approval (PRD §5, §6.6,
 * §19, CONTRACTS.md §8).
 *
 * The approval moment is the point: this module reads and writes the one
 * `merchant_policies` row per merchant plus its `commitment_values` rows, and
 * increments `policy_version` on every approval. No generation logic lives
 * here — bounds arrive from the caller already decided; this only persists
 * them.
 *
 * Follows the style of `campaign-holds.ts` / `audit-events.ts`: typed params
 * objects, drizzle query builder, no raw SQL beyond the one increment
 * expression that has no query-builder equivalent. Deliberately generic over
 * `NodePgDatabase` (not the real exported `db`) so this runs against
 * `getTestDb()` in tests and the real `db` in production without a fork.
 *
 * No row-lock is required here, unlike `reserveCampaignBudget` /
 * `appendAuditEvent`: this ticket states no concurrency requirement, and a
 * lost update on a rare double-submit of the same merchant's policy form is
 * an acceptable, non-money-safety risk (unlike budget reservation or ledger
 * sequencing).
 */

export type AllowedCommitment = {
  commitmentType: CommitmentType;
  valueMinor: number;
};

export type MerchantPolicyWithCommitments = SelectMerchantPolicy & {
  allowedCommitments: AllowedCommitment[];
};

/**
 * Reads one merchant's policy row plus its allowed-commitment values.
 * Returns `undefined` if the merchant has no policy row yet — this module
 * never fabricates one; seeding/provisioning a merchant is another ticket's
 * job.
 */
export async function getMerchantPolicy(
  database: NodePgDatabase,
  merchantId: string,
): Promise<MerchantPolicyWithCommitments | undefined> {
  const [policy] = await database
    .select()
    .from(merchantPoliciesTable)
    .where(eq(merchantPoliciesTable.merchantId, merchantId));

  if (!policy) return undefined;

  const allowedCommitments = await database
    .select({
      commitmentType: commitmentValuesTable.commitmentType,
      valueMinor: commitmentValuesTable.valueMinor,
    })
    .from(commitmentValuesTable)
    .where(eq(commitmentValuesTable.merchantId, merchantId))
    .orderBy(asc(commitmentValuesTable.commitmentType));

  return { ...policy, allowedCommitments };
}

export type ApproveMerchantPolicyParams = {
  merchantId: string;
  campaignBudgetTotalMinor: number;
  perDealCapMinor: number;
  maxRounds: number;
  offerTtlSeconds: number;
  allowedCommitments: AllowedCommitment[];
};

export type ApproveMerchantPolicyResult = { policyVersion: number };

/**
 * The delegation moment. Writes the merchant-edited fields and increments
 * `policyVersion` — a plain `SET policy_version = policy_version + 1`, read
 * and written in the same statement, so it can never be lost to a
 * read-then-write race even without an explicit row lock.
 *
 * Note what is deliberately NOT accepted here, mirroring the frozen
 * `approvePolicy` tRPC input: `concessionCurve` and `slowMovingTolerance`
 * are not merchant-editable (RA-4 / the 3% rule is fixed), so this function
 * has no parameter for either and never touches those columns.
 *
 * `allowedCommitments` is upserted by the `(merchantId, commitmentType)`
 * unique index, same pattern as `seed.ts` — one row per commitment type,
 * value replaced in place.
 *
 * Throws if the merchant has no existing policy row: approval edits an
 * existing delegation, it does not create one out of thin air.
 */
export async function approveMerchantPolicy(
  database: NodePgDatabase,
  params: ApproveMerchantPolicyParams,
): Promise<ApproveMerchantPolicyResult> {
  const { merchantId, allowedCommitments, campaignBudgetTotalMinor, perDealCapMinor, maxRounds, offerTtlSeconds } =
    params;

  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(merchantPoliciesTable)
      .set({
        campaignBudgetTotalMinor,
        perDealCapMinor,
        maxRounds,
        offerTtlSeconds,
        policyVersion: sql`${merchantPoliciesTable.policyVersion} + 1`,
      })
      .where(eq(merchantPoliciesTable.merchantId, merchantId))
      .returning({ policyVersion: merchantPoliciesTable.policyVersion });

    if (!updated) {
      throw new Error(`approveMerchantPolicy: no merchant_policies row for merchant ${merchantId}`);
    }

    for (const commitment of allowedCommitments) {
      await tx
        .insert(commitmentValuesTable)
        .values({
          merchantId,
          commitmentType: commitment.commitmentType,
          valueMinor: commitment.valueMinor,
        })
        .onConflictDoUpdate({
          target: [commitmentValuesTable.merchantId, commitmentValuesTable.commitmentType],
          set: { valueMinor: commitment.valueMinor },
        });
    }

    return { policyVersion: updated.policyVersion };
  });
}

export type SetNegotiationEnabledResult = { negotiationEnabled: boolean };

/**
 * The kill switch (RA-1). Exempt from the policy freeze: writable at any
 * time, including mid-negotiation, independent of `approveMerchantPolicy` —
 * flipping it never touches `policyVersion`, because it halts sessions
 * rather than re-pricing them.
 *
 * A bare conditional `UPDATE`, same pattern as `transitionHoldFromReserved`
 * in campaign-holds.ts: no separate read step, no row lock — Postgres's
 * row-level MVCC makes a single `UPDATE ... WHERE merchant_id = $1` atomic
 * under concurrency on its own.
 *
 * Returns `undefined` if the merchant has no policy row.
 */
export async function setNegotiationEnabled(
  database: NodePgDatabase,
  merchantId: string,
  enabled: boolean,
): Promise<SetNegotiationEnabledResult | undefined> {
  const [updated] = await database
    .update(merchantPoliciesTable)
    .set({ negotiationEnabled: enabled })
    .where(eq(merchantPoliciesTable.merchantId, merchantId))
    .returning({ negotiationEnabled: merchantPoliciesTable.negotiationEnabled });

  return updated;
}
