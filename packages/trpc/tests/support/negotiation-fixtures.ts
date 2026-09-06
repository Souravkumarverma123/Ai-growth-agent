import { eq } from "drizzle-orm";

import { getTestDb } from "@repo/database/testing/db";
import {
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
  ordersTable,
  skuPoliciesTable,
} from "@repo/database/schema";
import { computeCounterfactualContribution } from "@repo/policy";
import type { SkuPolicy } from "@repo/policy/contracts";

/**
 * Shared tRPC-integration-test fixtures (CONTRACTS.md §1 explicitly permits
 * shared test helpers). Everything here writes to `getTestDb()`'s sibling
 * test database — the primary seam (CONTRACTS.md §8), no mocking.
 */

/**
 * Stand-in for `@repo/payments`'s `createOrder` in tRPC integration tests:
 * inserts a real `orders` row into the sibling test database (so the
 * downstream `getOrderByOfferId` read still finds one) and returns a
 * Razorpay-shaped order — without the live Razorpay HTTP call, and without
 * the `@repo/database` singleton / test-db mismatch `createOrder` itself has
 * (ISSUE-012). Amount and currency are read from the real offer row, never
 * hardcoded, so the local order can never silently disagree with the offer
 * it was authorized against.
 */
export async function insertTestOrderForOffer(offerId: string) {
  const db = await getTestDb();
  const [offer] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
  if (!offer) throw new Error(`test createOrder mock: no offer found for offerId "${offerId}"`);
  const railOrderId = `rzp_test_order_${offerId.slice(0, 8)}`;
  await db.insert(ordersTable).values({
    offerId,
    railOrderId,
    amountMinor: offer.totalMinor,
    currency: offer.currency,
  });
  return {
    id: railOrderId,
    entity: "order",
    amount: offer.totalMinor,
    currency: offer.currency,
    receipt: offerId,
    status: "created",
    notes: {},
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Seeds one merchant + policy + negotiable SKU + a single-line session, and
 * returns the session id. `state` chooses whether the merchant's own engine
 * has flagged the session (`"AT_RISK"`) or not (`"IDLE"`) — the only
 * flagging signal the frozen schema offers (see `route.ts`'s module doc).
 */
export async function seedNegotiationSession(
  opts: { state: "IDLE" | "AT_RISK"; autonomousPaymentExecution?: boolean } = { state: "AT_RISK" },
): Promise<{ sessionId: string; merchantId: string }> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "MCP negotiation test merchant" })
    .returning({ id: merchantsTable.id });
  const merchantId = merchant!.id;

  await db.insert(merchantPoliciesTable).values({
    merchantId,
    negotiationEnabled: true,
    campaignBudgetTotalMinor: 500_000,
    perDealCapMinor: 50_000,
    maxRounds: 3,
    concessionCurve: [0.4, 0.7, 1.0],
    offerTtlSeconds: 600,
    autonomousPaymentExecution: opts.autonomousPaymentExecution ?? false,
  });

  const [sku] = await db
    .insert(skuPoliciesTable)
    .values({
      merchantId,
      sku: "VITC-SERUM",
      name: "Vitamin C Serum",
      listPriceMinor: 100_000,
      floorPriceMinor: 80_000,
      negotiable: true,
      slowMoving: false,
    })
    .returning();

  const skuPolicy: SkuPolicy = {
    skuId: sku!.id,
    merchantId,
    sku: sku!.sku,
    name: sku!.name,
    listPriceMinor: sku!.listPriceMinor,
    floorPriceMinor: sku!.floorPriceMinor,
    negotiable: sku!.negotiable,
    slowMoving: sku!.slowMoving,
    affinityGroup: sku!.affinityGroup,
  };

  const originalBasket = {
    lines: [{ skuId: skuPolicy.skuId, quantity: 1, unitPriceMinor: skuPolicy.listPriceMinor }],
    commitments: [] as const,
    currency: "INR" as const,
  };

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: "buyer-agent-1",
      state: opts.state,
      roundIndex: 0,
      tier1Refused: false,
      policyVersion: 1,
      originalBasket,
      counterfactualContributionMinor: computeCounterfactualContribution(originalBasket, [skuPolicy]),
    })
    .returning({ id: negotiationSessionsTable.id });

  return { sessionId: session!.id, merchantId };
}
