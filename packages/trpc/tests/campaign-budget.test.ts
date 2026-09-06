import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import {
  campaignHoldsTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
} from "@repo/database/schema";
import {
  commitCampaignHold,
  releaseCampaignHold,
  reserveCampaignBudget,
  type CampaignHoldLedgerContext,
} from "@repo/database/repositories/campaign-holds";
import type { Basket } from "@repo/policy/contracts";

import { serverRouter } from "../server";

/**
 * TICKET-503 — campaign budget countdown.
 *
 * Acceptance criterion: "Reserved and available update visibly when a Tier 2
 * offer is minted and again when it expires." "Display matches engine state
 * across a hold lifecycle."
 *
 * This is the API half of that: `merchant.getCampaignBudget` must report
 * `total / reserved / committed / available` that tracks `campaign_holds` as
 * the real reservation engine (`reserveCampaignBudget` / `releaseCampaignHold`,
 * TICKET-107/108) moves a hold through its lifecycle. Real Postgres, no
 * mocking — CONTRACTS.md §8's primary seam. The `apps/web` render half is
 * `apps/web/tests/campaign-budget.test.tsx`.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

function reserveLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
  };
}

function releaseLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "HOLD_RELEASED",
  };
}

function commitLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "HOLD_COMMITTED",
    fromState: "SETTLED",
    toState: "SETTLED",
    reasonCode: "HOLD_COMMITTED",
  };
}

async function insertMerchantWithPolicy(campaignBudgetTotalMinor: number): Promise<string> {
  const db = await getTestDb();
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-503 campaign-budget test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor,
    perDealCapMinor: 5_000_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

/** One negotiation session + one Tier 2 offer — the shape a Tier 2 mint leaves behind. */
async function insertSessionAndOffer(params: {
  merchantId: string;
  index: number;
  shortfallMinor: number;
}): Promise<{ offerId: string; sessionId: string }> {
  const db = await getTestDb();
  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId: params.merchantId,
      buyerAgentId: `ticket-503-test-buyer-${params.index}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: session!.id,
      candidateRef: `tier2-candidate-${params.index}`,
      roundIndex: 2,
      basket: fixtureBasket(230_000),
      totalMinor: 230_000,
      tier: 2,
      campaignSpendMinor: params.shortfallMinor,
      policyVersion: 1,
      reasonCode: "DILUTION_WITHIN_CAPS",
      expiresAt: new Date(Date.now() + 600_000),
      engineSignature: "ticket-503-test-fixture-signature",
    })
    .returning({ id: offersTable.id });

  return { offerId: offer!.id, sessionId: session!.id };
}

describe("TICKET-503 — merchant.getCampaignBudget", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reports the full budget as available when no hold has ever been placed", async () => {
    const merchantId = await insertMerchantWithPolicy(5_000_000);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const budget = await caller.merchant.getCampaignBudget({ merchantId });

    expect(budget).toEqual({
      totalMinor: 5_000_000,
      reservedMinor: 0,
      committedMinor: 0,
      availableMinor: 5_000_000,
    });
  });

  it("tracks the engine across a Tier 2 hold lifecycle: reserve lowers available, release restores it", async () => {
    const TOTAL = 1_000_000; // ₹10,000
    const SHORTFALL = 300_000; // ₹3,000
    const merchantId = await insertMerchantWithPolicy(TOTAL);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: SHORTFALL,
    });

    // Before the mint: nothing reserved.
    expect(await caller.merchant.getCampaignBudget({ merchantId })).toMatchObject({
      reservedMinor: 0,
      availableMinor: TOTAL,
    });

    // Tier 2 mint reserves the hold.
    const reserve = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: SHORTFALL,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    expect(reserve.reserved).toBe(true);

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toEqual({
      totalMinor: TOTAL,
      reservedMinor: SHORTFALL,
      committedMinor: 0,
      availableMinor: TOTAL - SHORTFALL,
    });

    // The offer is declined / abandoned — the hold releases.
    if (!reserve.reserved) throw new Error("unreachable");
    const release = await releaseCampaignHold(db, reserve.hold.id, releaseLedgerFor(sessionId));
    expect(release.resolved).toBe(true);

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toEqual({
      totalMinor: TOTAL,
      reservedMinor: 0,
      committedMinor: 0,
      availableMinor: TOTAL,
    });
  });

  it("moves a hold from reserved to committed on capture — committed still counts against available", async () => {
    const TOTAL = 1_000_000;
    const SHORTFALL = 250_000;
    const merchantId = await insertMerchantWithPolicy(TOTAL);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: SHORTFALL,
    });
    const reserve = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: SHORTFALL,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    if (!reserve.reserved) throw new Error("reservation unexpectedly failed");

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toMatchObject({
      reservedMinor: SHORTFALL,
      committedMinor: 0,
    });

    const commit = await commitCampaignHold(db, reserve.hold.id, commitLedgerFor(sessionId));
    expect(commit.resolved).toBe(true);

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toEqual({
      totalMinor: TOTAL,
      reservedMinor: 0,
      committedMinor: SHORTFALL,
      availableMinor: TOTAL - SHORTFALL,
    });
  });

  it("excludes a RESERVED hold past its expiry from `reserved` — available climbs back on TTL elapse with no explicit release", async () => {
    const TOTAL = 1_000_000;
    const SHORTFALL = 400_000;
    const merchantId = await insertMerchantWithPolicy(TOTAL);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: SHORTFALL,
    });
    const reserve = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: SHORTFALL,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    if (!reserve.reserved) throw new Error("reservation unexpectedly failed");

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toMatchObject({
      reservedMinor: SHORTFALL,
      availableMinor: TOTAL - SHORTFALL,
    });

    // Simulate TTL elapse: the row stays RESERVED, nothing sweeps it.
    await db
      .update(campaignHoldsTable)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(campaignHoldsTable.id, reserve.hold.id));

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toMatchObject({
      reservedMinor: 0,
      committedMinor: 0,
      availableMinor: TOTAL,
    });
  });

  it("counts two concurrent Tier 2 holds for the same merchant", async () => {
    const TOTAL = 2_000_000;
    const merchantId = await insertMerchantWithPolicy(TOTAL);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    for (const [index, amountMinor] of [200_000, 350_000].entries()) {
      const { offerId, sessionId } = await insertSessionAndOffer({ merchantId, index, shortfallMinor: amountMinor });
      const reserve = await reserveCampaignBudget(db, {
        merchantId,
        offerId,
        amountMinor,
        expiresAt: new Date(Date.now() + 600_000),
        ledger: reserveLedgerFor(sessionId),
      });
      if (!reserve.reserved) throw new Error("reservation unexpectedly failed");
    }

    expect(await caller.merchant.getCampaignBudget({ merchantId })).toEqual({
      totalMinor: TOTAL,
      reservedMinor: 550_000,
      committedMinor: 0,
      availableMinor: TOTAL - 550_000,
    });
  });

  it("floors availableMinor at zero when a budget cut leaves the merchant overcommitted (never a negative that breaks the output schema)", async () => {
    const TOTAL = 1_000_000;
    const SHORTFALL = 600_000;
    const merchantId = await insertMerchantWithPolicy(TOTAL);
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: SHORTFALL,
    });
    const reserve = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: SHORTFALL,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    if (!reserve.reserved) throw new Error("reservation unexpectedly failed");

    // The merchant approves a policy that cuts the budget below what is
    // already reserved (approvePolicy allows any nonnegative total).
    await db
      .update(merchantPoliciesTable)
      .set({ campaignBudgetTotalMinor: 400_000 })
      .where(eq(merchantPoliciesTable.merchantId, merchantId));

    const budget = await caller.merchant.getCampaignBudget({ merchantId });
    expect(budget).toEqual({
      totalMinor: 400_000,
      reservedMinor: SHORTFALL,
      committedMinor: 0,
      availableMinor: 0,
    });
    // The overcommitment is still visible: reserved > total.
    expect(budget.reservedMinor).toBeGreaterThan(budget.totalMinor);
  });

  it("fails with NOT_FOUND for a merchant that has no policy row", async () => {
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    await expect(
      caller.merchant.getCampaignBudget({ merchantId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });
});
