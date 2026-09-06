import type { Basket, MerchantPolicy, SkuPolicy } from "@repo/policy";

/**
 * TICKET-206 — the fixture the buyer agent harness negotiates against.
 *
 * The catalogue and cart are PRD §18.2's reference scenario: the three named
 * SKUs (Vitamin C Serum, Gentle Cleanser, Night Cream) with their exact list
 * and floor prices, a campaign budget of ₹50,000, and the original cart of
 * Serum + Cleanser at list (₹2,500). It is the same catalogue
 * `packages/database/seed.ts` (TICKET-507) writes for the live demo —
 * reproduced here as a plain constant because `packages/agent` cannot import
 * `@repo/database` (CONTRACTS.md §2, B2) and the harness must run with no
 * database at all. A handful of extra affinity SKUs are included so the
 * candidate generator has real `ADD_SKU` / `INCREASE_QUANTITY` moves.
 *
 * ONE DELIBERATE DIVERGENCE FROM §18.2: the per-deal cap here is ₹700, not
 * ₹200. On this cart the frozen concession curve ([0.4, 0.7, 1.0] of
 * ₹950 floor-derived headroom) produces a round-1 `PRICE_CONCESSION` of
 * ~₹380 — already far past a ₹200 cap — so with §18.2's own ₹200 cap NO
 * Tier 2 candidate is ever feasible and a Tier 2 offer can never be minted
 * end to end (issue-tracker.md, ISSUE-012 sub-issue 12e, which names this
 * ticket as the one that needs a fixture that can). Widening the cap to ₹700
 * makes rounds 1 and 2 Tier 2-feasible and round 3 infeasible — the exact
 * "feasible, feasible, then the cap binds and it walks" shape §18.2's worked
 * example describes. Nothing frozen changed: the cap is a fixture value, and
 * `packages/database/seed.ts` still seeds ₹200 for the live surface.
 *
 * All money is integer minor units (paise), CONTRACTS.md §3.
 */

const MERCHANT_ID = "212eda77-06c0-46ef-ae17-24b6d4088188";

export const REFERENCE_SKU_IDS = {
  vitaminCSerum: "beb6d832-d269-4c76-b6e2-9d16fec26796",
  gentleCleanser: "9e1ce79a-b9e6-41d1-9aa8-438d6c2a0083",
  nightCream: "9c447ec1-3039-4d1f-b58e-ff97c557b501",
  hyaluronicAcidSerum: "9ba72a57-bacc-40df-abf7-b3f3da9cdc5d",
  foamingFaceWash: "825e68af-c867-4577-9735-cd4422f6bb8c",
  clayDetoxMask: "0ac8e762-1c3e-4aa4-8c73-59ead61f0c97",
} as const;

export const REFERENCE_CATALOGUE: readonly SkuPolicy[] = [
  // --- PRD §18.2 named SKUs — exact figures the worked example depends on ---
  {
    skuId: REFERENCE_SKU_IDS.vitaminCSerum,
    merchantId: MERCHANT_ID,
    sku: "VITC-SERUM-30ML",
    name: "Vitamin C Serum",
    listPriceMinor: 180_000, // ₹1,800
    floorPriceMinor: 110_000, // ₹1,100
    negotiable: true,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    skuId: REFERENCE_SKU_IDS.gentleCleanser,
    merchantId: MERCHANT_ID,
    sku: "GENTLE-CLNSR-100ML",
    name: "Gentle Cleanser",
    listPriceMinor: 70_000, // ₹700
    floorPriceMinor: 45_000, // ₹450
    negotiable: true,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    skuId: REFERENCE_SKU_IDS.nightCream,
    merchantId: MERCHANT_ID,
    sku: "NIGHT-CREAM-50G",
    name: "Night Cream",
    listPriceMinor: 90_000, // ₹900
    floorPriceMinor: 52_000, // ₹520
    negotiable: true,
    slowMoving: true,
    affinityGroup: "moisturizers",
  },
  // --- extra affinity SKUs so ADD_SKU / bundle moves have material ---
  {
    skuId: REFERENCE_SKU_IDS.hyaluronicAcidSerum,
    merchantId: MERCHANT_ID,
    sku: "HYAL-SERUM-30ML",
    name: "Hyaluronic Acid Serum",
    listPriceMinor: 160_000,
    floorPriceMinor: 95_000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    skuId: REFERENCE_SKU_IDS.foamingFaceWash,
    merchantId: MERCHANT_ID,
    sku: "FOAM-FACEWASH-100ML",
    name: "Foaming Face Wash",
    listPriceMinor: 55_000,
    floorPriceMinor: 34_000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    skuId: REFERENCE_SKU_IDS.clayDetoxMask,
    merchantId: MERCHANT_ID,
    sku: "CLAY-MASK-100G",
    name: "Clay Detox Face Mask",
    listPriceMinor: 75_000,
    floorPriceMinor: 46_000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "masks",
  },
];

export const REFERENCE_POLICY: MerchantPolicy = {
  merchantId: MERCHANT_ID,
  negotiationEnabled: true,
  campaignBudgetTotalMinor: 5_000_000, // ₹50,000
  perDealCapMinor: 70_000, // ₹700 — widened from §18.2's ₹200, see module doc
  maxRounds: 3,
  concessionCurve: [0.4, 0.7, 1.0],
  offerTtlSeconds: 600,
  slowMovingTolerance: 0.03,
  allowedCommitments: [
    { commitmentType: "PREPAID", valueMinor: 12_000 },
    { commitmentType: "NON_RETURNABLE", valueMinor: 9_000 },
    { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 6_000 },
  ],
  autonomousPaymentExecution: false,
  policyVersion: 1,
};

/** PRD §18.2's "original cart" — Serum + Cleanser, qty 1 each, at list. */
export const REFERENCE_CART: Basket = {
  lines: [
    { skuId: REFERENCE_SKU_IDS.vitaminCSerum, quantity: 1, unitPriceMinor: 180_000 },
    { skuId: REFERENCE_SKU_IDS.gentleCleanser, quantity: 1, unitPriceMinor: 70_000 },
  ],
  commitments: [],
  currency: "INR",
};

export interface ReferenceScenario {
  readonly policy: MerchantPolicy;
  readonly catalogue: readonly SkuPolicy[];
  readonly originalBasket: Basket;
}

export const REFERENCE_SCENARIO: ReferenceScenario = {
  policy: REFERENCE_POLICY,
  catalogue: REFERENCE_CATALOGUE,
  originalBasket: REFERENCE_CART,
};
