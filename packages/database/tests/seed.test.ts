import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../index";
import {
  commitmentValuesTable,
  merchantPoliciesTable,
  merchantsTable,
  skuPoliciesTable,
} from "../schema";
import { REFERENCE_CART, SEED_CATALOGUE, SEED_MERCHANT_ID, seedDatabase } from "../seed";

/**
 * TICKET-507 — Seed data and demo fixtures.
 *
 * Runs the real seed function against the real `dev` Postgres database (see
 * CONTRACTS.md §8: seam 1 is "a tRPC caller against a real Postgres" — no
 * mocking). TICKET-001 was meant to provide a separate, disposable test
 * database, but never did (issue-tracker.md ISSUE-003); until that lands,
 * this suite seeds and reads back from the same `dev` database the seed
 * script targets, which is exactly what this ticket's job is anyway.
 *
 * The worked-example arithmetic below is plain arithmetic on the raw
 * numbers read back from the database — it deliberately imports nothing
 * from `packages/policy` to compute it, so this suite stays decoupled from
 * TICKET-102 (the contribution calculator), which is being built
 * independently and concurrently.
 */

describe("TICKET-507 seed data (PRD §18.2)", () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it("is idempotent: seeding again does not throw and does not duplicate any row", async () => {
    await expect(seedDatabase()).resolves.toBeUndefined();

    const merchants = await db.select().from(merchantsTable).where(eq(merchantsTable.id, SEED_MERCHANT_ID));
    const policies = await db
      .select()
      .from(merchantPoliciesTable)
      .where(eq(merchantPoliciesTable.merchantId, SEED_MERCHANT_ID));
    const commitments = await db
      .select()
      .from(commitmentValuesTable)
      .where(eq(commitmentValuesTable.merchantId, SEED_MERCHANT_ID));
    const skus = await db.select().from(skuPoliciesTable).where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));

    expect(merchants).toHaveLength(1);
    expect(policies).toHaveLength(1);
    expect(commitments).toHaveLength(3);
    expect(skus).toHaveLength(SEED_CATALOGUE.length);
  });

  it("seeds a merchant policy with the ticket's campaign budget, per-deal cap, and PRD §5.1 MVP defaults", async () => {
    const rows = await db
      .select()
      .from(merchantPoliciesTable)
      .where(eq(merchantPoliciesTable.merchantId, SEED_MERCHANT_ID));

    expect(rows).toHaveLength(1);
    const policy = rows[0]!;

    expect(policy.campaignBudgetTotalMinor).toBe(5_000_000); // ₹50,000
    expect(policy.perDealCapMinor).toBe(20_000); // ₹200
    expect(policy.negotiationEnabled).toBe(true);
    expect(policy.maxRounds).toBe(3);
    expect(policy.concessionCurve).toEqual([0.4, 0.7, 1.0]);
    expect(policy.offerTtlSeconds).toBe(600);
    expect(policy.slowMovingTolerance).toBeCloseTo(0.03);
    // MVP default: willingness to charge is never assumed (PRD §5.1, §9.2).
    expect(policy.autonomousPaymentExecution).toBe(false);
  });

  it("seeds the three allowed commitments with their PRD §5.3 rupee values", async () => {
    const rows = await db
      .select()
      .from(commitmentValuesTable)
      .where(eq(commitmentValuesTable.merchantId, SEED_MERCHANT_ID));

    expect(rows).toHaveLength(3);
    const byType = Object.fromEntries(rows.map((r) => [r.commitmentType, r.valueMinor]));
    expect(byType["PREPAID"]).toBe(12_000); // ₹120
    expect(byType["NON_RETURNABLE"]).toBe(9_000); // ₹90
    expect(byType["EXTENDED_DELIVERY_WINDOW"]).toBe(6_000); // ₹60
  });

  it("seeds ~20 SKUs with exactly 3 flagged slow-moving, all negotiable", async () => {
    const rows = await db.select().from(skuPoliciesTable).where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));

    expect(rows.length).toBeGreaterThanOrEqual(20);

    // No duplicate SKU codes -- one row per natural key even after re-seeding.
    const skuCodes = rows.map((r) => r.sku);
    expect(new Set(skuCodes).size).toBe(skuCodes.length);

    const slowMoving = rows.filter((r) => r.slowMoving);
    expect(slowMoving).toHaveLength(3);
    expect(slowMoving.map((r) => r.name).sort()).toEqual(
      ["Night Cream", "Overnight Repair Oil", "Under-Eye Cream"].sort(),
    );

    expect(rows.every((r) => r.negotiable)).toBe(true);
  });

  it("includes the three named SKUs from PRD §18.2 with their exact list and floor prices", async () => {
    const rows = await db.select().from(skuPoliciesTable).where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));
    const bySku = (sku: string) => rows.find((r) => r.sku === sku);

    const serum = bySku("VITC-SERUM-30ML");
    expect(serum?.name).toBe("Vitamin C Serum");
    expect(serum?.listPriceMinor).toBe(180_000); // ₹1,800
    expect(serum?.floorPriceMinor).toBe(110_000); // ₹1,100
    expect(serum?.slowMoving).toBe(false);

    const cleanser = bySku("GENTLE-CLNSR-100ML");
    expect(cleanser?.name).toBe("Gentle Cleanser");
    expect(cleanser?.listPriceMinor).toBe(70_000); // ₹700
    expect(cleanser?.floorPriceMinor).toBe(45_000); // ₹450
    expect(cleanser?.slowMoving).toBe(false);

    const nightCream = bySku("NIGHT-CREAM-50G");
    expect(nightCream?.name).toBe("Night Cream");
    expect(nightCream?.listPriceMinor).toBe(90_000); // ₹900
    expect(nightCream?.floorPriceMinor).toBe(52_000); // ₹520
    expect(nightCream?.slowMoving).toBe(true);
  });

  it("reference cart fixture is Serum + Cleanser, qty 1 each, at list = ₹2,500", () => {
    expect(REFERENCE_CART.currency).toBe("INR");
    expect(REFERENCE_CART.commitments).toEqual([]);
    expect(REFERENCE_CART.lines).toHaveLength(2);

    const totalMinor = REFERENCE_CART.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
    expect(totalMinor).toBe(250_000); // ₹2,500

    expect(REFERENCE_CART.lines.every((line) => line.quantity === 1)).toBe(true);
  });

  describe("worked example (PRD §18.2) — plain arithmetic on the seeded rows, no @repo/policy import", () => {
    it("reproduces ₹950 / ₹3,020 / ₹2,300 / walk-away at ₹2,200 exactly", async () => {
      const skuRows = await db.select().from(skuPoliciesTable).where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));
      const policyRows = await db
        .select()
        .from(merchantPoliciesTable)
        .where(eq(merchantPoliciesTable.merchantId, SEED_MERCHANT_ID));

      const serum = skuRows.find((r) => r.sku === "VITC-SERUM-30ML")!;
      const cleanser = skuRows.find((r) => r.sku === "GENTLE-CLNSR-100ML")!;
      const nightCream = skuRows.find((r) => r.sku === "NIGHT-CREAM-50G")!;
      const policy = policyRows[0]!;

      // Contribution for a basket = Σ(line_price - line_floor) * qty. Every
      // figure below is computed from raw seeded numbers only.

      // --- Original cart: Serum + Cleanser at list (the counterfactual). ---
      const originalCartTotalMinor = serum.listPriceMinor + cleanser.listPriceMinor;
      const originalCartFloorMinor = serum.floorPriceMinor + cleanser.floorPriceMinor;
      const counterfactualContributionMinor = originalCartTotalMinor - originalCartFloorMinor;

      expect(originalCartTotalMinor).toBe(250_000); // ₹2,500
      expect(counterfactualContributionMinor).toBe(95_000); // ₹950

      // --- Round 1, Tier 1: bundle of all three SKUs, offered at ₹3,020. ---
      const bundleFloorMinor = serum.floorPriceMinor + cleanser.floorPriceMinor + nightCream.floorPriceMinor;
      const tier1OfferedTotalMinor = 302_000; // ₹3,020 -- the merchant's stated Tier-1 bundle price (PRD §18.2)
      const tier1ContributionMinor = tier1OfferedTotalMinor - bundleFloorMinor;

      expect(tier1ContributionMinor).toBe(95_000); // ₹950 -- neutral: matches the counterfactual exactly
      expect(tier1ContributionMinor).toBe(counterfactualContributionMinor);

      // --- Round 2, Tier 2: original cart only, offered at ₹2,300. ---
      const tier2OfferedTotalMinor = 230_000; // ₹2,300
      const tier2ContributionMinor = tier2OfferedTotalMinor - originalCartFloorMinor;
      const tier2ShortfallMinor = counterfactualContributionMinor - tier2ContributionMinor;

      expect(tier2ContributionMinor).toBe(75_000); // ₹750
      expect(tier2ShortfallMinor).toBe(20_000); // ₹200
      expect(tier2ShortfallMinor).toBe(policy.perDealCapMinor); // exactly at the per-deal cap
      expect(tier2ShortfallMinor).toBeLessThanOrEqual(policy.perDealCapMinor); // passes the cap check

      // --- Round 3: buyer holds at ₹2,200. ---
      const round3TotalMinor = 220_000; // ₹2,200
      const round3ContributionMinor = round3TotalMinor - originalCartFloorMinor;
      const round3ShortfallMinor = counterfactualContributionMinor - round3ContributionMinor;

      expect(round3ContributionMinor).toBe(65_000); // ₹650
      expect(round3ShortfallMinor).toBe(30_000); // ₹300
      expect(round3ShortfallMinor).toBeGreaterThan(policy.perDealCapMinor); // fails the cap check -> DILUTION_EXCEEDS_PER_DEAL_CAP -> walk away

      // Walking away leaves the campaign budget untouched by this deal; even
      // the most this session could ever have drawn down (a shortfall
      // capped at perDealCapMinor) would have left the rest of the ₹50,000
      // campaign budget unused -- the constraint that binds here is the
      // per-deal cap, not the campaign budget (PRD §18.2's point: "the agent
      // refusing a deal it could afford, because a different limit binds").
      const campaignBudgetUnusedMinor = policy.campaignBudgetTotalMinor - policy.perDealCapMinor;
      expect(campaignBudgetUnusedMinor).toBe(4_980_000); // ₹49,800
    });
  });
});
