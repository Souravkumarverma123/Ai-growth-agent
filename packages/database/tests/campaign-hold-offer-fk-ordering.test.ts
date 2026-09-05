import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { campaignHoldsTable, merchantPoliciesTable, merchantsTable, negotiationSessionsTable, offersTable } from "../schema";
import { reserveCampaignBudget } from "../repositories/campaign-holds";

/**
 * Regression test for the FK-ordering bug fixed by migration
 * `0003_defer_campaign_hold_offer_fk.sql`.
 *
 * `packages/trpc/server/routes/negotiation/route.ts`'s `propose` procedure
 * must reserve a Tier 2 offer's campaign budget BEFORE the offer itself is
 * minted and persisted — `mintOffer` requires the reservation's outcome
 * (including the offer id it was reserved under) as a plain input, so the
 * `offers` row cannot exist yet at reservation time. Every other test in
 * this package (`campaign-budget-reservation.test.ts` and siblings) inserts
 * the `offers` row FIRST and only then calls `reserveCampaignBudget` — the
 * opposite order — so none of them would ever have caught
 * `campaign_holds.offer_id`'s FK (`campaign_holds_offer_id_offers_id_fk`)
 * rejecting a hold whose referenced offer doesn't exist yet.
 *
 * The fix is two parts, both required and both asserted here: the FK is now
 * `DEFERRABLE INITIALLY DEFERRED` (checked at transaction COMMIT, not at the
 * `INSERT` statement), and the caller (route.ts) now performs the
 * reservation and the later offer insert inside ONE transaction — so by the
 * time that transaction commits, the referenced offer row exists and the
 * constraint's actual guarantee (a hold can never permanently outlive or
 * outreach its offer) still holds.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

describe("campaign_holds.offer_id FK ordering — reserve-before-mint", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reserving a hold for an offer id that does not exist yet, then creating that offer, commits successfully inside one transaction", async () => {
    const db = await getTestDb();

    const [merchant] = await db
      .insert(merchantsTable)
      .values({ name: "FK-ordering test merchant" })
      .returning({ id: merchantsTable.id });
    const merchantId = merchant!.id;

    await db.insert(merchantPoliciesTable).values({
      merchantId,
      campaignBudgetTotalMinor: 500_000,
      perDealCapMinor: 50_000,
      concessionCurve: [0.4, 0.7, 1.0],
    });

    const [session] = await db
      .insert(negotiationSessionsTable)
      .values({
        merchantId,
        buyerAgentId: "fk-ordering-test-buyer",
        policyVersion: 1,
        originalBasket: fixtureBasket(250_000),
        counterfactualContributionMinor: 95_000,
      })
      .returning({ id: negotiationSessionsTable.id });
    const sessionId = session!.id;

    const reservationOfferId = randomUUID();
    const expiresAt = new Date(Date.now() + 600_000);

    // The exact sequence route.ts's `propose` follows: reserve first (no
    // `offers` row exists for `reservationOfferId` yet — before this fix,
    // this INSERT would have thrown a foreign-key violation immediately),
    // then mint/persist the offer under that same id, all in one transaction.
    await db.transaction(async (tx) => {
      const reserveResult = await reserveCampaignBudget(tx, {
        merchantId,
        offerId: reservationOfferId,
        amountMinor: 20_000,
        expiresAt,
        ledger: {
          sessionId,
          eventType: "BUDGET_RESERVED",
          fromState: "OFFER_PENDING",
          toState: "OFFER_PENDING",
          reasonCode: "HOLD_RESERVED",
        },
      });
      expect(reserveResult.reserved).toBe(true);

      await tx.insert(offersTable).values({
        id: reservationOfferId,
        sessionId,
        candidateRef: "tier2-candidate-1",
        roundIndex: 1,
        basket: fixtureBasket(230_000),
        totalMinor: 230_000,
        tier: 2,
        campaignSpendMinor: 20_000,
        policyVersion: 1,
        reasonCode: "DILUTION_WITHIN_CAPS",
        expiresAt,
        engineSignature: "fk-ordering-test-fixture-signature",
      });
    });

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, reservationOfferId));
    expect(hold).toBeDefined();
    expect(hold!.state).toBe("RESERVED");

    const [offer] = await db.select().from(offersTable).where(eq(offersTable.id, reservationOfferId));
    expect(offer).toBeDefined();
    expect(offer!.tier).toBe(2);
  });

  it("still rejects a hold whose offer never gets created within the same transaction (the FK's actual guarantee is unchanged, only deferred)", async () => {
    const db = await getTestDb();

    const [merchant] = await db
      .insert(merchantsTable)
      .values({ name: "FK-ordering test merchant 2" })
      .returning({ id: merchantsTable.id });
    const merchantId = merchant!.id;

    await db.insert(merchantPoliciesTable).values({
      merchantId,
      campaignBudgetTotalMinor: 500_000,
      perDealCapMinor: 50_000,
      concessionCurve: [0.4, 0.7, 1.0],
    });

    const [session] = await db
      .insert(negotiationSessionsTable)
      .values({
        merchantId,
        buyerAgentId: "fk-ordering-test-buyer-2",
        policyVersion: 1,
        originalBasket: fixtureBasket(250_000),
        counterfactualContributionMinor: 95_000,
      })
      .returning({ id: negotiationSessionsTable.id });
    const sessionId = session!.id;

    const orphanOfferId = randomUUID();
    const expiresAt = new Date(Date.now() + 600_000);

    await expect(
      db.transaction(async (tx) => {
        await reserveCampaignBudget(tx, {
          merchantId,
          offerId: orphanOfferId,
          amountMinor: 20_000,
          expiresAt,
          ledger: {
            sessionId,
            eventType: "BUDGET_RESERVED",
            fromState: "OFFER_PENDING",
            toState: "OFFER_PENDING",
            reasonCode: "HOLD_RESERVED",
          },
        });
        // Deliberately never inserting the offers row — the deferred FK
        // check must still fire, just at COMMIT instead of at the INSERT.
      }),
    ).rejects.toThrow();

    const holds = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, orphanOfferId));
    expect(holds).toHaveLength(0);
  });
});
