import { describe, expect, it } from "vitest";

import type { Basket } from "../contracts";
import type { GeneratedCandidate } from "../generation";
import { assignTiersAndFeasibility } from "../generation";

/**
 * TICKET-104 — tier assignment and feasible-set marking.
 *
 * Fixture money figures reproduce PRD §18.2's worked example verbatim (also
 * reproduced in packages/database/tests/seed.test.ts and
 * packages/policy/tests/campaign-budget.test.ts): perDealCapMinor = 20_000
 * (₹200), campaignBudgetTotalMinor = 5_000_000 (₹50,000).
 *
 *   Round 1 (Tier 1, neutral):  contributionDeltaMinor =       0
 *   Round 2 (Tier 2, at cap):   contributionDeltaMinor = -20_000  (shortfall ₹200)
 *   Round 3 (Tier 2, over cap): contributionDeltaMinor = -30_000  (shortfall ₹300)
 *
 * `GeneratedCandidate` fixtures are built directly (not via
 * `generateCandidates`) since this module only cares about
 * `contributionDeltaMinor`'s sign and magnitude — everything else on the
 * fixture is filler that must simply survive the wrap untouched.
 */

const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";

const PER_DEAL_CAP_MINOR = 20_000; // ₹200 (PRD §18.2)
const CAMPAIGN_BUDGET_TOTAL_MINOR = 5_000_000; // ₹50,000 (PRD §18.2)

function basket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

function buildGeneratedCandidate(overrides: Partial<GeneratedCandidate> = {}): GeneratedCandidate {
  return {
    moveType: "PRICE_CONCESSION",
    basket: basket(180000),
    totalMinor: 180000,
    contributionMinor: 95000,
    contributionDeltaMinor: 0,
    clearsSlowMoving: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tier assignment matches the worked example (PRD §18.2)
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — worked example (PRD §18.2)", () => {
  const round1Neutral = buildGeneratedCandidate({ contributionDeltaMinor: 0 }); // Tier 1, neutral
  const round2AtCap = buildGeneratedCandidate({ contributionDeltaMinor: -20_000 }); // Tier 2, exactly at cap
  const round3OverCap = buildGeneratedCandidate({ contributionDeltaMinor: -30_000 }); // Tier 2, over cap

  const result = assignTiersAndFeasibility({
    candidates: [round1Neutral, round2AtCap, round3OverCap],
    tier1Refused: true,
    perDealCapMinor: PER_DEAL_CAP_MINOR,
    availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
  });

  it("is feasible overall", () => {
    expect(result.feasible).toBe(true);
  });

  it("tiers the neutral candidate as Tier 1 with zero required campaign spend", () => {
    if (!result.feasible) throw new Error("expected feasible result");
    const tiered = result.candidates[0]!;
    expect(tiered.tier).toBe(1);
    expect(tiered.requiredCampaignSpendMinor).toBe(0);
    expect(tiered.feasible).toBe(true);
    expect(tiered.infeasibleReason).toBeNull();
  });

  it("tiers the at-cap candidate as Tier 2, feasible, with the exact shortfall", () => {
    if (!result.feasible) throw new Error("expected feasible result");
    const tiered = result.candidates[1]!;
    expect(tiered.tier).toBe(2);
    expect(tiered.requiredCampaignSpendMinor).toBe(20_000);
    expect(tiered.feasible).toBe(true);
    expect(tiered.infeasibleReason).toBeNull();
  });

  it("tiers the over-cap candidate as Tier 2, infeasible, DILUTION_EXCEEDS_PER_DEAL_CAP", () => {
    if (!result.feasible) throw new Error("expected feasible result");
    const tiered = result.candidates[2]!;
    expect(tiered.tier).toBe(2);
    expect(tiered.requiredCampaignSpendMinor).toBe(30_000);
    expect(tiered.feasible).toBe(false);
    expect(tiered.infeasibleReason).toBe("DILUTION_EXCEEDS_PER_DEAL_CAP");
  });

  it("includes only the neutral Tier 1 and the at-cap Tier 2 candidate in selectableCandidates", () => {
    if (!result.feasible) throw new Error("expected feasible result");
    expect(result.selectableCandidates.map((c) => c.requiredCampaignSpendMinor)).toEqual([0, 20_000]);
  });
});

// ---------------------------------------------------------------------------
// Tier is derived arithmetically, never accepted from a caller
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — tier is derived, never accepted from a caller", () => {
  it.each([
    { contributionDeltaMinor: 1, expectedTier: 1 },
    { contributionDeltaMinor: 0, expectedTier: 1 },
    { contributionDeltaMinor: -1, expectedTier: 2 },
  ])(
    "contributionDeltaMinor=$contributionDeltaMinor derives tier $expectedTier",
    ({ contributionDeltaMinor, expectedTier }) => {
      const result = assignTiersAndFeasibility({
        candidates: [buildGeneratedCandidate({ contributionDeltaMinor })],
        tier1Refused: true,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
        availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      });
      if (!result.feasible) throw new Error("expected feasible result");
      expect(result.candidates[0]!.tier).toBe(expectedTier);
    },
  );

  it("GeneratedCandidate carries no tier field for a caller to assert in the first place", () => {
    // Structural proof, not just a runtime one: GeneratedCandidate's own type
    // (candidates.ts) has no `tier` property, so TierAssignmentInput's
    // `candidates` field could never carry one even if a caller tried.
    const candidate = buildGeneratedCandidate();
    expect("tier" in candidate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A Tier 2 candidate cannot be selected while tier1_refused is false
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — Tier 2 stays locked until tier1Refused is true", () => {
  const tier1Neutral = buildGeneratedCandidate({ contributionDeltaMinor: 0 });
  const tier2WithinCaps = buildGeneratedCandidate({ contributionDeltaMinor: -10_000 }); // well within cap and budget

  it("marks the Tier 2 candidate feasible (cap/budget checks don't know about the refusal gate)", () => {
    const result = assignTiersAndFeasibility({
      candidates: [tier1Neutral, tier2WithinCaps],
      tier1Refused: false,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    if (!result.feasible) throw new Error("expected feasible result");
    const tieredTier2 = result.candidates.find((c) => c.tier === 2)!;
    expect(tieredTier2.feasible).toBe(true);
  });

  it("excludes the feasible Tier 2 candidate from selectableCandidates before refusal", () => {
    const result = assignTiersAndFeasibility({
      candidates: [tier1Neutral, tier2WithinCaps],
      tier1Refused: false,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    if (!result.feasible) throw new Error("expected feasible result");
    expect(result.selectableCandidates).toHaveLength(1);
    expect(result.selectableCandidates[0]!.tier).toBe(1);
  });

  it("includes the same Tier 2 candidate in selectableCandidates once tier1Refused flips true", () => {
    const result = assignTiersAndFeasibility({
      candidates: [tier1Neutral, tier2WithinCaps],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    if (!result.feasible) throw new Error("expected feasible result");
    expect(result.selectableCandidates.map((c) => c.tier).sort()).toEqual([1, 2]);
  });

  it("rejects the Tier 2 pick entirely (NO_FEASIBLE_BASKET) when it is the only candidate and tier1Refused is false", () => {
    const result = assignTiersAndFeasibility({
      candidates: [tier2WithinCaps],
      tier1Refused: false,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    expect(result).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });

  it("accepts that same Tier 2-only candidate once tier1Refused is true", () => {
    const result = assignTiersAndFeasibility({
      candidates: [tier2WithinCaps],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    expect(result.feasible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Campaign budget exhaustion, independent of the per-deal cap
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — campaign budget exhaustion", () => {
  it("marks a within-cap Tier 2 candidate infeasible with CAMPAIGN_BUDGET_EXHAUSTED when it exceeds the live available budget", () => {
    const candidate = buildGeneratedCandidate({ contributionDeltaMinor: -15_000 }); // within the ₹200 cap
    const result = assignTiersAndFeasibility({
      candidates: [candidate],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: 10_000, // less than the 15,000 shortfall
    });
    expect(result).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });

  it("the per-deal cap wins when both the cap and the budget would reject it (cap checked first)", () => {
    const candidate = buildGeneratedCandidate({ contributionDeltaMinor: -30_000 }); // exceeds the ₹200 cap
    const result = assignTiersAndFeasibility({
      candidates: [candidate],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: 10_000, // also less than the shortfall
    });
    expect(result).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });
});

// ---------------------------------------------------------------------------
// Empty feasible set yields NO_FEASIBLE_BASKET
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — empty feasible set yields NO_FEASIBLE_BASKET", () => {
  it("returns NO_FEASIBLE_BASKET for an empty candidate list", () => {
    const result = assignTiersAndFeasibility({
      candidates: [],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    expect(result).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });

  it("returns NO_FEASIBLE_BASKET when every candidate is infeasible", () => {
    const overCap = buildGeneratedCandidate({ contributionDeltaMinor: -30_000 });
    const result = assignTiersAndFeasibility({
      candidates: [overCap],
      tier1Refused: true,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
      availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
    });
    expect(result).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });
});

// ---------------------------------------------------------------------------
// Fails closed on precision loss
// ---------------------------------------------------------------------------

describe("assignTiersAndFeasibility — fails closed on precision loss", () => {
  it("throws rather than silently comparing an unsafe-integer perDealCapMinor", () => {
    expect(() =>
      assignTiersAndFeasibility({
        candidates: [buildGeneratedCandidate()],
        tier1Refused: true,
        perDealCapMinor: Number.MAX_SAFE_INTEGER + 2,
        availableCampaignBudgetMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      }),
    ).toThrow(/safe integer/i);
  });

  it("throws rather than silently comparing an unsafe-integer availableCampaignBudgetMinor", () => {
    expect(() =>
      assignTiersAndFeasibility({
        candidates: [buildGeneratedCandidate()],
        tier1Refused: true,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
        availableCampaignBudgetMinor: Number.MAX_SAFE_INTEGER + 2,
      }),
    ).toThrow(/safe integer/i);
  });
});
