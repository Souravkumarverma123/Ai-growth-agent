import { describe, expect, it } from "vitest";

import type { Basket, CommitmentValue, SkuPolicy } from "../contracts";
import { computeBasketContribution, computeCounterfactualContribution } from "../economics";

/**
 * TICKET-102 — basket contribution calculator.
 *
 * Fixtures are the PRD §18.2 reference scenario — Vitamin C Serum, Gentle
 * Cleanser, Night Cream — and the three worked figures every test here
 * ultimately checks against: original cart ₹950, Tier 1 bundle at ₹3,020
 * gives ₹950 (neutral), Tier 2 at ₹2,300 gives ₹750. Money is minor units
 * throughout — ×100 of the PRD's rupee figures — per CONTRACTS.md §3.
 */

const MERCHANT_ID = "99999999-9999-4999-8999-999999999999";
const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";
const CLEANSER_SKU_ID = "22222222-2222-4222-8222-222222222222";
const NIGHT_CREAM_SKU_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_SKU_ID = "44444444-4444-4444-8444-444444444444";

// PRD §18.2's reference table.
const skuPolicies: SkuPolicy[] = [
  {
    skuId: SERUM_SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "VIT-C-SERUM",
    name: "Vitamin C Serum",
    listPriceMinor: 180000, // ₹1,800
    floorPriceMinor: 110000, // ₹1,100
    negotiable: true,
    slowMoving: false,
    affinityGroup: null,
  },
  {
    skuId: CLEANSER_SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "GENTLE-CLEANSER",
    name: "Gentle Cleanser",
    listPriceMinor: 70000, // ₹700
    floorPriceMinor: 45000, // ₹450
    negotiable: true,
    slowMoving: false,
    affinityGroup: null,
  },
  {
    skuId: NIGHT_CREAM_SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "NIGHT-CREAM",
    name: "Night Cream",
    listPriceMinor: 90000, // ₹900
    floorPriceMinor: 52000, // ₹520
    negotiable: true,
    slowMoving: true, // flagged slow-moving, PRD §18.2
    affinityGroup: null,
  },
];

// PRD §5.3 — the closed set of merchant-valued commitments.
const allowedCommitments: CommitmentValue[] = [
  { commitmentType: "PREPAID", valueMinor: 12000 }, // ₹120
  { commitmentType: "NON_RETURNABLE", valueMinor: 9000 }, // ₹90
  { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 6000 }, // ₹60
];

function basketTotalMinor(basket: Basket): number {
  return basket.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
}

describe("computeBasketContribution — PRD §18.2 worked example", () => {
  it("original cart (Serum + Cleanser at list) contributes exactly ₹950", () => {
    const originalBasket: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 70000 },
      ],
    };

    expect(basketTotalMinor(originalBasket)).toBe(250000); // ₹2,500, PRD §18.2
    expect(computeBasketContribution(originalBasket, skuPolicies, allowedCommitments)).toBe(
      95000,
    );
  });

  it("Tier 1 bundle (all three SKUs) at ₹3,020 contributes exactly ₹950 — neutral", () => {
    const tier1Bundle: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 160000 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 60000 },
        { skuId: NIGHT_CREAM_SKU_ID, quantity: 1, unitPriceMinor: 82000 },
      ],
    };

    expect(basketTotalMinor(tier1Bundle)).toBe(302000); // ₹3,020, PRD §18.2
    expect(computeBasketContribution(tier1Bundle, skuPolicies, allowedCommitments)).toBe(95000);
  });

  it("Tier 2 (original cart only) at ₹2,300 contributes exactly ₹750", () => {
    const tier2Basket: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 160000 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 70000 },
      ],
    };

    expect(basketTotalMinor(tier2Basket)).toBe(230000); // ₹2,300, PRD §18.2
    expect(computeBasketContribution(tier2Basket, skuPolicies, allowedCommitments)).toBe(75000);
  });

  it("evaluates a multi-line trade as one basket, revealing an offset no per-line score could see (PRD §6.3)", () => {
    // Serum's and Cleanser's discounted lines, judged on their own, contribute
    // ₹300 less than the ₹950 counterfactual — a plain loss if nothing else in
    // the basket is considered. Night Cream's addition contributes exactly
    // that ₹300 back (its own ₹380 headroom, evaluated as part of the same
    // basket). Only a basket-level sum can see this offset.
    const serumAndCleanserOnly: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 160000 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 60000 },
      ],
    };
    const fullTier1Bundle: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        ...serumAndCleanserOnly.lines,
        { skuId: NIGHT_CREAM_SKU_ID, quantity: 1, unitPriceMinor: 82000 },
      ],
    };

    const partialContribution = computeBasketContribution(
      serumAndCleanserOnly,
      skuPolicies,
      allowedCommitments,
    );
    const fullContribution = computeBasketContribution(
      fullTier1Bundle,
      skuPolicies,
      allowedCommitments,
    );

    expect(partialContribution).toBe(65000); // ₹650 — ₹300 short of the ₹950 counterfactual
    expect(fullContribution).toBe(95000); // ₹950 — Night Cream's headroom closes the gap
    expect(fullContribution - partialContribution).toBe(30000); // Night Cream's own headroom
  });
});

describe("computeCounterfactualContribution — PRD §6.2", () => {
  const originalBasket: Basket = {
    currency: "INR",
    commitments: [],
    lines: [
      { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 },
      { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 70000 },
    ],
  };

  it("matches the original cart's own contribution when it is already at list", () => {
    expect(computeCounterfactualContribution(originalBasket, skuPolicies)).toBe(95000);
  });

  it("re-prices every line at list even if the stored basket carries a different price", () => {
    const staleBasket: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 1 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 1 },
      ],
    };

    expect(computeCounterfactualContribution(staleBasket, skuPolicies)).toBe(95000);
  });

  it("ignores any commitment already on the stored basket — at list nothing is negotiated yet", () => {
    const basketWithCommitment: Basket = {
      ...originalBasket,
      commitments: ["PREPAID"],
    };

    expect(computeCounterfactualContribution(basketWithCommitment, skuPolicies)).toBe(95000);
  });
});

describe("commitment values contribute correctly — PRD §5.3", () => {
  const singleLineBasket: Basket = {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 }],
  };

  it("adds a single commitment's exact rupee value on top of line headroom", () => {
    const withoutCommitment = computeBasketContribution(
      singleLineBasket,
      skuPolicies,
      allowedCommitments,
    );
    const withPrepaid = computeBasketContribution(
      { ...singleLineBasket, commitments: ["PREPAID"] },
      skuPolicies,
      allowedCommitments,
    );

    expect(withoutCommitment).toBe(70000); // (180,000 - 110,000) × 1
    expect(withPrepaid).toBe(82000);
    expect(withPrepaid - withoutCommitment).toBe(12000); // exactly PRD §5.3's ₹120
  });

  it("sums every commitment on the basket, each contributing its own value", () => {
    const allThreeCommitments = computeBasketContribution(
      {
        ...singleLineBasket,
        commitments: ["PREPAID", "NON_RETURNABLE", "EXTENDED_DELIVERY_WINDOW"],
      },
      skuPolicies,
      allowedCommitments,
    );

    // 70,000 line headroom + 12,000 + 9,000 + 6,000 commitment value
    expect(allThreeCommitments).toBe(97000);
  });
});

describe("rounding is exact — no float ever enters the calculation", () => {
  it("stays exact for quantities greater than one and non-round unit prices", () => {
    const basket: Basket = {
      currency: "INR",
      commitments: ["NON_RETURNABLE"],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 3, unitPriceMinor: 150001 },
        { skuId: CLEANSER_SKU_ID, quantity: 7, unitPriceMinor: 50003 },
      ],
    };

    const result = computeBasketContribution(basket, skuPolicies, allowedCommitments);

    // Deliberately non-round numbers: if anything in the calculation path
    // ever divided (e.g. to average or to apply a percentage) instead of
    // only adding, subtracting and multiplying, this is the kind of input
    // that would expose drift.
    const expected = (150001 - 110000) * 3 + (50003 - 45000) * 7 + 9000;
    expect(result).toBe(expected);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("every PRD §18.2 worked figure is an exact integer, never a rounded float", () => {
    const originalBasket: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 },
        { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 70000 },
      ],
    };

    const contribution = computeBasketContribution(originalBasket, skuPolicies, allowedCommitments);
    const counterfactual = computeCounterfactualContribution(originalBasket, skuPolicies);

    expect(Number.isInteger(contribution)).toBe(true);
    expect(Number.isInteger(counterfactual)).toBe(true);
  });
});

describe("fails closed on inconsistent policy data (CONTRACTS.md §6)", () => {
  it("throws rather than silently under-counting a basket line with no matching SKU policy", () => {
    const basketWithUnknownSku: Basket = {
      currency: "INR",
      commitments: [],
      lines: [{ skuId: UNKNOWN_SKU_ID, quantity: 1, unitPriceMinor: 1000 }],
    };

    expect(() =>
      computeBasketContribution(basketWithUnknownSku, skuPolicies, allowedCommitments),
    ).toThrow(/sku policy/i);
  });

  it("throws rather than silently under-counting a commitment absent from allowedCommitments", () => {
    const basketWithUnknownCommitment: Basket = {
      currency: "INR",
      commitments: ["PREPAID"],
      lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 }],
    };

    expect(() =>
      computeBasketContribution(basketWithUnknownCommitment, skuPolicies, []),
    ).toThrow(/commitment/i);
  });

  it("computeCounterfactualContribution also throws on a SKU absent from skuPolicies", () => {
    const basketWithUnknownSku: Basket = {
      currency: "INR",
      commitments: [],
      lines: [{ skuId: UNKNOWN_SKU_ID, quantity: 1, unitPriceMinor: 1000 }],
    };

    expect(() => computeCounterfactualContribution(basketWithUnknownSku, skuPolicies)).toThrow(
      /sku policy/i,
    );
  });
});
