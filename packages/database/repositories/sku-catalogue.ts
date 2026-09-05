import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { SkuPolicy } from "@repo/policy/contracts";

import { skuPoliciesTable } from "../models/merchant";

/**
 * TICKET-204 — read-only catalogue lookup, mirroring the frozen
 * `SkuPolicy` contract (`packages/policy/contracts/merchant-policy.ts`).
 *
 * No repository read this table before this ticket (`merchant-policies.ts`
 * only reads `merchant_policies` / `commitment_values`) — every SKU-policy
 * caller so far has been a `packages/policy` pure function taking a
 * `readonly SkuPolicy[]` as a plain argument. This is the missing
 * database-backed source of that argument: `generateCandidates`,
 * `checkEligibility` and `computeBasketContribution` all need the whole
 * merchant catalogue (not just the SKUs already in a basket, so `ADD_SKU`
 * can search beyond the cart — `generation/candidates.ts`'s own doc).
 *
 * `SkuPolicy.skuId` is the frozen contract's name for what this table calls
 * `id` (its primary key) — every other field name already matches the
 * column name 1:1, so only that one field is renamed here.
 */
export async function getSkuCatalogueForMerchant(
  database: NodePgDatabase,
  merchantId: string,
): Promise<SkuPolicy[]> {
  const rows = await database
    .select()
    .from(skuPoliciesTable)
    .where(eq(skuPoliciesTable.merchantId, merchantId));

  return rows.map((row) => ({
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
}
