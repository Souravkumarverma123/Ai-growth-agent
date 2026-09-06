import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import {
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
} from "@repo/database/schema";
import { acceptOffer } from "@repo/database/repositories/offers";
import type { Basket } from "@repo/policy/contracts";

import { serverRouter } from "../server";

/**
 * TICKET-504 — offer status and TTL display.
 *
 * Acceptance criterion: "TTL counts down and the offer visibly expires";
 * "Expiry reflected in the UI state." This is the API half — `merchant`
 * `.getSessionOffers` must report every offer minted for a session with the
 * fields the merchant's watch card counts down from: `tier`, `status`,
 * `campaignSpendMinor`, and the `expiresAt` / `consumedAt` timestamps that
 * decide whether it is still live. Real Postgres, no mocking (CONTRACTS.md
 * §8 primary seam). The `apps/web` render + countdown half is
 * `apps/web/tests/offer-status.test.tsx`.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

async function insertMerchantWithPolicy(): Promise<string> {
  const db = await getTestDb();
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-504 offer-status test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: 5_000_000,
    perDealCapMinor: 5_000_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

async function insertSession(merchantId: string): Promise<string> {
  const db = await getTestDb();
  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: "ticket-504-test-buyer",
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });
  return session!.id;
}

async function insertOffer(params: {
  sessionId: string;
  roundIndex: number;
  tier: 1 | 2;
  totalMinor: number;
  campaignSpendMinor: number;
  expiresAt: Date;
}): Promise<string> {
  const db = await getTestDb();
  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: params.sessionId,
      candidateRef: `ticket-504-candidate-r${params.roundIndex}`,
      roundIndex: params.roundIndex,
      basket: fixtureBasket(params.totalMinor),
      totalMinor: params.totalMinor,
      tier: params.tier,
      campaignSpendMinor: params.campaignSpendMinor,
      policyVersion: 1,
      reasonCode: params.tier === 2 ? "DILUTION_WITHIN_CAPS" : "TIER1_OFFERED",
      expiresAt: params.expiresAt,
      engineSignature: "ticket-504-test-fixture-signature",
    })
    .returning({ id: offersTable.id });
  return offer!.id;
}

describe("TICKET-504 — merchant.getSessionOffers", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("returns an empty list for a session that has minted no offers", async () => {
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const result = await caller.merchant.getSessionOffers({ sessionId: randomUUID() });

    expect(result).toEqual({ offers: [] });
  });

  it("reports a live offer with its tier, TTL and campaign spend", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    const expiresAt = new Date(Date.now() + 600_000);
    const offerId = await insertOffer({
      sessionId,
      roundIndex: 1,
      tier: 2,
      totalMinor: 230_000,
      campaignSpendMinor: 30_000,
      expiresAt,
    });

    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });
    const { offers } = await caller.merchant.getSessionOffers({ sessionId });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      offerId,
      roundIndex: 1,
      tier: 2,
      status: "PENDING",
      totalMinor: 230_000,
      campaignSpendMinor: 30_000,
      currency: "INR",
      consumedAt: null,
    });
    expect(offers[0]!.expiresAt).toBe(expiresAt.toISOString());
    expect(offers[0]!.createdAt).not.toBeNull();
  });

  it("orders offers newest round first", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    const soon = new Date(Date.now() + 600_000);
    await insertOffer({ sessionId, roundIndex: 1, tier: 1, totalMinor: 240_000, campaignSpendMinor: 0, expiresAt: soon });
    await insertOffer({ sessionId, roundIndex: 2, tier: 2, totalMinor: 220_000, campaignSpendMinor: 20_000, expiresAt: soon });

    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });
    const { offers } = await caller.merchant.getSessionOffers({ sessionId });

    expect(offers.map((o) => o.roundIndex)).toEqual([2, 1]);
  });

  it("surfaces an expired offer: its expiresAt is in the past and it was never consumed", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    const expiredAt = new Date(Date.now() - 1_000);
    await insertOffer({
      sessionId,
      roundIndex: 1,
      tier: 2,
      totalMinor: 230_000,
      campaignSpendMinor: 30_000,
      expiresAt: expiredAt,
    });

    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });
    const { offers } = await caller.merchant.getSessionOffers({ sessionId });

    expect(offers[0]!.consumedAt).toBeNull();
    expect(Date.parse(offers[0]!.expiresAt)).toBeLessThan(Date.now());
  });

  it("reflects a consumed offer once the buyer accepts it", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    const basketTotal = 230_000;
    const offerId = await insertOffer({
      sessionId,
      roundIndex: 1,
      tier: 1,
      totalMinor: basketTotal,
      campaignSpendMinor: 0,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const db = await getTestDb();
    const accept = await acceptOffer(db, {
      offerId,
      acceptedBasket: fixtureBasket(basketTotal),
    });
    expect(accept.accepted).toBe(true);

    const caller = serverRouter.createCaller({ db });
    const { offers } = await caller.merchant.getSessionOffers({ sessionId });

    expect(offers[0]!.consumedAt).not.toBeNull();
  });
});
