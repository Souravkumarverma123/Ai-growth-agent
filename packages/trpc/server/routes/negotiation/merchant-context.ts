import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getMerchantPolicy, type MerchantPolicyWithCommitments } from "@repo/database/repositories/merchant-policies";
import { getSkuCatalogueForMerchant } from "@repo/database/repositories/sku-catalogue";
import type { MerchantPolicy, SkuPolicy } from "@repo/policy/contracts";

/**
 * TICKET-204 — maps the database's `merchant_policies` (+ `commitment_
 * values`) row shape onto the frozen `MerchantPolicy` contract
 * (`packages/policy/contracts/merchant-policy.ts`) that every pure engine
 * function in `packages/policy` takes as a plain input. Every field name
 * already matches 1:1 (same discipline `merchant/route.ts`'s `getPolicy`
 * uses, just extracted here so `negotiation/route.ts` doesn't repeat it).
 */
export function toMerchantPolicyContract(policy: MerchantPolicyWithCommitments): MerchantPolicy {
  return {
    merchantId: policy.merchantId,
    negotiationEnabled: policy.negotiationEnabled,
    campaignBudgetTotalMinor: policy.campaignBudgetTotalMinor,
    perDealCapMinor: policy.perDealCapMinor,
    maxRounds: policy.maxRounds,
    concessionCurve: policy.concessionCurve,
    offerTtlSeconds: policy.offerTtlSeconds,
    slowMovingTolerance: policy.slowMovingTolerance,
    allowedCommitments: policy.allowedCommitments,
    autonomousPaymentExecution: policy.autonomousPaymentExecution,
    policyVersion: policy.policyVersion,
  };
}

export type MerchantNegotiationContext = {
  policy: MerchantPolicy;
  skuCatalogue: SkuPolicy[];
};

/** Fetches everything `checkEligibility`/`generateCandidates`/
 *  `assignTiersAndFeasibility` need about a merchant, in one call. Throws if
 *  the merchant has no policy row — same fail-closed discipline as
 *  `getMerchantPolicy`'s own callers in `merchant/route.ts`. */
export async function loadMerchantNegotiationContext(
  database: NodePgDatabase,
  merchantId: string,
): Promise<MerchantNegotiationContext> {
  const policy = await getMerchantPolicy(database, merchantId);
  if (!policy) {
    throw new Error(`loadMerchantNegotiationContext: no merchant_policies row for merchant ${merchantId}`);
  }
  const skuCatalogue = await getSkuCatalogueForMerchant(database, merchantId);
  return { policy: toMerchantPolicyContract(policy), skuCatalogue };
}
