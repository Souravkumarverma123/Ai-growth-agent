import type { Basket } from "@repo/policy/contracts";
import { CURRENCY } from "@repo/policy/contracts";

/**
 * DEV-ONLY — the "full walkthrough" scenario for `db:seed-session --scenario demo`.
 *
 * The seeded `Glow Theory` merchant (`seed.ts`) carries PRD §18.2's exact
 * figures, including its ₹200 per-deal cap. On the reference cart the frozen
 * concession curve's smallest step (0.4 × ₹950 headroom ≈ ₹380) already
 * exceeds ₹200, so NO campaign-funded Tier 2 offer is ever feasible there
 * (issue-tracker.md ISSUE-017) — a live negotiation against that merchant can
 * only ever show Tier 1 offers that don't move the price, then a round-limit
 * walk-away.
 *
 * This is a SEPARATE demo merchant with a ₹700 per-deal cap — the same widen
 * the pure-engine demo harness uses (`packages/agent/demo/reference-scenario.ts`).
 * With it, a `propose` negotiation shows the whole story: a Tier 1 offer,
 * then (after a refusal unlocks Tier 2) a campaign-funded rescue at a lower
 * total — the per-deal cap is what bounds that rescue to ₹665 rather than
 * the full ₹950 of headroom. Accept the rescue to close the deal, or keep
 * declining: with `maxRounds: 2` the next proposal hits the round limit and
 * the session ends `WALKED_AWAY` (`ROUND_LIMIT_REACHED`). Nothing frozen
 * changes — this merchant is not seeded by `db:seed` and no test asserts
 * against it; `seed.ts` still writes ₹200 for §18.2.
 *
 * NOTE: a *cap-bound* walk-away (`NO_FEASIBLE_BASKET` /
 * `DILUTION_EXCEEDS_PER_DEAL_CAP`, the reason code that makes the walk-away
 * card say "a cap of ₹X would have closed it") is deliberately NOT what this
 * scenario produces — a feasible self-funding Tier 1 candidate always exists
 * on a normal catalogue, so the round limit is reached first (issue-tracker.md
 * ISSUE-022). Reproducing a cap-bound walk-away end to end needs a contrived
 * catalogue with no reachable self-funding move, out of scope for this dev
 * fixture.
 *
 * All ids are fixed v4 UUIDs so the upsert is idempotent. All money is
 * integer minor units (CONTRACTS.md §3).
 */

export const DEMO_MERCHANT_ID = "d3300000-0000-4000-8000-000000000001";
export const DEMO_MERCHANT_POLICY_ID = "d3300000-0000-4000-8000-000000000002";
export const DEMO_MERCHANT_NAME = "Glow Theory (demo scenario)";

export const DEMO_POLICY_FIELDS = {
  negotiationEnabled: true,
  campaignBudgetTotalMinor: 5_000_000, // ₹50,000
  perDealCapMinor: 70_000, // ₹700 — widened from §18.2's ₹200, see module doc
  // 2 rounds, not the §18.2 default of 3: round 1 is a Tier 1 offer, round 2
  // (after a refusal) is the campaign-funded Tier 2 rescue — the whole story.
  // A 3rd round would only ever be the merchant's weak "cheapest Tier 1"
  // fallback once the deeper concession outgrows the ₹700 cap (the price
  // appears to bounce back up), which reads worse than a clean round-limit
  // walk-away. Fixture value, nothing frozen.
  maxRounds: 2,
  concessionCurve: [0.4, 0.7, 1.0],
  offerTtlSeconds: 600,
  slowMovingTolerance: 0.03,
  autonomousPaymentExecution: false,
  policyVersion: 1,
};

export const DEMO_ALLOWED_COMMITMENTS = [
  { commitmentType: "PREPAID" as const, valueMinor: 12_000 },
  { commitmentType: "NON_RETURNABLE" as const, valueMinor: 9_000 },
  { commitmentType: "EXTENDED_DELIVERY_WINDOW" as const, valueMinor: 6_000 },
];

interface DemoSku {
  id: string;
  sku: string;
  name: string;
  listPriceMinor: number;
  floorPriceMinor: number;
  slowMoving: boolean;
  affinityGroup: string;
}

export const DEMO_SKU_IDS = {
  vitaminCSerum: "d3310000-0000-4000-8000-000000000001",
  gentleCleanser: "d3310000-0000-4000-8000-000000000002",
  nightCream: "d3310000-0000-4000-8000-000000000003",
  hyaluronicAcidSerum: "d3310000-0000-4000-8000-000000000004",
  foamingFaceWash: "d3310000-0000-4000-8000-000000000005",
  clayDetoxMask: "d3310000-0000-4000-8000-000000000006",
} as const;

export const DEMO_CATALOGUE: readonly DemoSku[] = [
  { id: DEMO_SKU_IDS.vitaminCSerum, sku: "VITC-SERUM-30ML", name: "Vitamin C Serum", listPriceMinor: 180_000, floorPriceMinor: 110_000, slowMoving: false, affinityGroup: "serums" },
  { id: DEMO_SKU_IDS.gentleCleanser, sku: "GENTLE-CLNSR-100ML", name: "Gentle Cleanser", listPriceMinor: 70_000, floorPriceMinor: 45_000, slowMoving: false, affinityGroup: "cleansers" },
  { id: DEMO_SKU_IDS.nightCream, sku: "NIGHT-CREAM-50G", name: "Night Cream", listPriceMinor: 90_000, floorPriceMinor: 52_000, slowMoving: true, affinityGroup: "moisturizers" },
  { id: DEMO_SKU_IDS.hyaluronicAcidSerum, sku: "HYAL-SERUM-30ML", name: "Hyaluronic Acid Serum", listPriceMinor: 160_000, floorPriceMinor: 95_000, slowMoving: false, affinityGroup: "serums" },
  { id: DEMO_SKU_IDS.foamingFaceWash, sku: "FOAM-FACEWASH-100ML", name: "Foaming Face Wash", listPriceMinor: 55_000, floorPriceMinor: 34_000, slowMoving: false, affinityGroup: "cleansers" },
  { id: DEMO_SKU_IDS.clayDetoxMask, sku: "CLAY-MASK-100G", name: "Clay Detox Face Mask", listPriceMinor: 75_000, floorPriceMinor: 46_000, slowMoving: false, affinityGroup: "masks" },
];

/** Serum + Cleanser, qty 1 each, at list — PRD §18.2's "original cart" (₹2,500). */
export const DEMO_CART: Basket = {
  lines: [
    { skuId: DEMO_SKU_IDS.vitaminCSerum, quantity: 1, unitPriceMinor: 180_000 },
    { skuId: DEMO_SKU_IDS.gentleCleanser, quantity: 1, unitPriceMinor: 70_000 },
  ],
  commitments: [],
  currency: CURRENCY,
};
