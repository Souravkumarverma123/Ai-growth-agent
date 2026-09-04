import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { evaluatePerDealCap } from "@repo/policy/economics";
import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import {
  campaignHoldsTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
} from "../schema";
import { reserveCampaignBudget } from "../repositories/campaign-holds";

/**
 * TICKET-107 — the real point of this ticket: a concurrency test against the
 * real database (CONTRACTS.md §8, "do not mock the database; use the real
 * one"), proving campaign-budget reservation cannot be jointly overspent no
 * matter how many callers race it, and that the per-deal cap fires
 * independently of the campaign-budget check.
 *
 * Fixture numbers here are this ticket's own — deliberately not TICKET-507's
 * seed numbers, which are demo fixture data for the real `dev` database and
 * unrelated to this sibling `dev_test` database.
 *
 * FK chain (read models/negotiation.ts, models/offer.ts): campaign_holds.offer_id
 * is NOT NULL, UNIQUE, and FKs to offers.id; offers.session_id FKs to
 * negotiation_sessions.id; negotiation_sessions.merchant_id and
 * merchant_policies.merchant_id both FK to merchants.id. Because
 * campaign_holds.offer_id is unique (one hold per offer), N concurrent
 * reservation attempts need N distinct offers — modeling N different buyer
 * sessions for the same merchant simultaneously reaching a tier-2 mint.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

async function insertMerchantWithPolicy(params: {
  campaignBudgetTotalMinor: number;
  perDealCapMinor: number;
}): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-107 concurrency test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: params.campaignBudgetTotalMinor,
    perDealCapMinor: params.perDealCapMinor,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

/** One negotiation session + one offer, modeling one concurrent buyer's mint attempt. */
async function insertSessionAndOffer(params: {
  merchantId: string;
  index: number;
  shortfallMinor: number;
}): Promise<string> {
  const db = await getTestDb();
  const { merchantId, index, shortfallMinor } = params;

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: `concurrency-test-buyer-${index}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  const expiresAt = new Date(Date.now() + 600_000);

  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: session!.id,
      candidateRef: `tier2-candidate-${index}`,
      roundIndex: 2,
      basket: fixtureBasket(230_000),
      totalMinor: 230_000,
      tier: 2,
      campaignSpendMinor: shortfallMinor,
      policyVersion: 1,
      // Cosmetic pick only — no mint-flow ticket exists yet to decide this
      // "correctly"; the reservation outcome is what this test evaluates.
      reasonCode: "DILUTION_WITHIN_CAPS",
      expiresAt,
      engineSignature: "ticket-107-test-fixture-signature",
    })
    .returning({ id: offersTable.id });

  return offer!.id;
}

async function sumOutstandingMinor(merchantId: string): Promise<number> {
  const db = await getTestDb();
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${campaignHoldsTable.amountMinor}), 0)` })
    .from(campaignHoldsTable)
    .where(
      and(
        eq(campaignHoldsTable.merchantId, merchantId),
        inArray(campaignHoldsTable.state, ["RESERVED", "COMMITTED"]),
      ),
    );
  return Number(row!.total);
}

describe("TICKET-107 — campaign budget accounting with atomic reservation", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it(
    "20 concurrent reservations of ₹100 each against a ₹1,000 campaign budget " +
      "(each individually within a ₹150 per-deal cap; jointly ₹2,000, double the budget) " +
      "leave available >= 0 and admit exactly 10",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000; // ₹1,000
      const PER_DEAL_CAP_MINOR = 15_000; // ₹150 — comfortably above each individual attempt
      const RESERVATION_AMOUNT_MINOR = 10_000; // ₹100 per attempt
      const ATTEMPT_COUNT = 20;
      const EXPECTED_SUCCESSES = 10; // 100_000 / 10_000

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const offerIds = await Promise.all(
        Array.from({ length: ATTEMPT_COUNT }, (_, index) =>
          insertSessionAndOffer({ merchantId, index, shortfallMinor: RESERVATION_AMOUNT_MINOR }),
        ),
      );

      // Each attempt individually fits the per-deal cap (10_000 <= 15_000):
      // confirm that before firing any of them at the database, exactly as
      // the real mint flow will (pure check first, DB call only if it
      // passes) — the point of this test is the campaign-budget race, not
      // the per-deal cap, which is covered separately below.
      const perDealDecisions = offerIds.map(() =>
        evaluatePerDealCap(RESERVATION_AMOUNT_MINOR, PER_DEAL_CAP_MINOR),
      );
      expect(perDealDecisions.every((decision) => decision.allowed)).toBe(true);

      const db = await getTestDb();
      const expiresAt = new Date(Date.now() + 600_000);

      const results = await Promise.all(
        offerIds.map((offerId) =>
          reserveCampaignBudget(db, {
            merchantId,
            offerId,
            amountMinor: RESERVATION_AMOUNT_MINOR,
            expiresAt,
          }),
        ),
      );

      const successes = results.filter((result) => result.reserved);
      const failures = results.filter((result) => !result.reserved);

      expect(successes).toHaveLength(EXPECTED_SUCCESSES);
      expect(failures).toHaveLength(ATTEMPT_COUNT - EXPECTED_SUCCESSES);

      for (const failure of failures) {
        expect(failure.reserved).toBe(false);
        if (!failure.reserved) {
          expect(failure.reasonCode).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
        }
      }

      // Every successful reservation produced a distinct hold row.
      const holdIds = successes.map((result) => (result.reserved ? result.hold.id : null));
      expect(new Set(holdIds).size).toBe(EXPECTED_SUCCESSES);
      for (const result of successes) {
        if (result.reserved) {
          expect(result.hold.amountMinor).toBe(RESERVATION_AMOUNT_MINOR);
          expect(result.hold.state).toBe("RESERVED");
        }
      }

      // The actual invariant this ticket exists to protect: read back the
      // true, committed state and check it against the exact arithmetic,
      // not just "is non-negative by luck."
      const outstandingMinor = await sumOutstandingMinor(merchantId);
      const availableMinor = CAMPAIGN_BUDGET_TOTAL_MINOR - outstandingMinor;

      expect(outstandingMinor).toBe(EXPECTED_SUCCESSES * RESERVATION_AMOUNT_MINOR);
      expect(availableMinor).toBe(0);
      expect(availableMinor).toBeGreaterThanOrEqual(0);
    },
    30_000,
  );

  it(
    "a shortfall exceeding the per-deal cap is rejected with DILUTION_EXCEEDS_PER_DEAL_CAP " +
      "even with campaign budget comfortably available, and never reaches the database",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000; // ₹1,000 — plenty left
      const PER_DEAL_CAP_MINOR = 15_000; // ₹150
      const SHORTFALL_MINOR = 20_000; // ₹200 — over the cap, but well within available budget

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const decision = evaluatePerDealCap(SHORTFALL_MINOR, PER_DEAL_CAP_MINOR);

      expect(decision).toEqual({
        allowed: false,
        reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
      });

      // The real mint flow would walk away right here, exactly as PRD §17
      // row 3 requires — reserveCampaignBudget is deliberately never called.
      // Confirm no campaign_holds row exists for this merchant at all.
      const outstandingMinor = await sumOutstandingMinor(merchantId);
      expect(outstandingMinor).toBe(0);

      const db = await getTestDb();
      const holds = await db
        .select()
        .from(campaignHoldsTable)
        .where(eq(campaignHoldsTable.merchantId, merchantId));
      expect(holds).toHaveLength(0);
    },
  );

  it("a shortfall exactly at the per-deal cap is allowed and can still be rejected independently by the campaign-budget check", async () => {
    const CAMPAIGN_BUDGET_TOTAL_MINOR = 5_000; // ₹50 — tiny budget, will exhaust immediately
    const PER_DEAL_CAP_MINOR = 15_000; // ₹150
    const SHORTFALL_MINOR = 15_000; // ₹150 — exactly at the per-deal cap

    const merchantId = await insertMerchantWithPolicy({
      campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
    });

    const decision = evaluatePerDealCap(SHORTFALL_MINOR, PER_DEAL_CAP_MINOR);
    expect(decision.allowed).toBe(true);

    const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: SHORTFALL_MINOR });
    const db = await getTestDb();

    const result = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: SHORTFALL_MINOR,
      expiresAt: new Date(Date.now() + 600_000),
    });

    // The per-deal cap check passed (both codes fire independently), but the
    // campaign budget (₹50) cannot cover a ₹150 shortfall — CAMPAIGN_BUDGET_EXHAUSTED.
    expect(result).toEqual({ reserved: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" });

    const outstandingMinor = await sumOutstandingMinor(merchantId);
    expect(outstandingMinor).toBe(0);
  });

  it.each([
    ["negative", -10_000],
    ["zero", 0],
    ["non-integer", 100.5],
  ])(
    "rejects a %s amountMinor before touching the database",
    async (_label, amountMinor) => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
      const PER_DEAL_CAP_MINOR = 15_000;

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });
      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: 10_000 });
      const db = await getTestDb();

      await expect(
        reserveCampaignBudget(db, {
          merchantId,
          offerId,
          amountMinor,
          expiresAt: new Date(Date.now() + 600_000),
        }),
      ).rejects.toThrow(/amountMinor must be a positive integer/);

      const outstandingMinor = await sumOutstandingMinor(merchantId);
      expect(outstandingMinor).toBe(0);
    },
  );
});
