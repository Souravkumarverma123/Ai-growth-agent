import { describe, expect, it } from "vitest";

import type { Basket } from "../contracts";
import type { TieredCandidate } from "../generation";
import { SLOW_MOVING_TOLERANCE_PERCENT, selectCandidate } from "../generation";

/**
 * TICKET-109 — objective ordering and slow-moving tolerance (PRD §6.6).
 *
 * Fixtures build `TieredCandidate` directly (not via `generateCandidates` +
 * `assignTiersAndFeasibility`) since this module only cares about
 * `contributionMinor`, `clearsSlowMoving` and `requiredCampaignSpendMinor` —
 * everything else on the fixture is filler that must simply pass through
 * untouched. `bestContributionMinor` is fixed at 100_000 (₹1,000) across
 * these tests so the 3% band's edges land on clean integers: 2% behind is
 * 98_000 (inside the band), 4% behind is 96_000 (outside it).
 */

const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";
const BEST_CONTRIBUTION_MINOR = 100_000; // ₹1,000

function basket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

let nextUnitPrice = 1;

function buildTieredCandidate(overrides: Partial<TieredCandidate> = {}): TieredCandidate {
  // Each fixture gets its own unit price so, absent an explicit `basket`
  // override, distinct candidates are also structurally distinct — matters
  // for the final content tiebreak the determinism tests exercise.
  nextUnitPrice += 1;
  return {
    moveType: "PRICE_CONCESSION",
    basket: basket(nextUnitPrice),
    totalMinor: nextUnitPrice,
    contributionMinor: BEST_CONTRIBUTION_MINOR,
    contributionDeltaMinor: 0,
    clearsSlowMoving: false,
    tier: 1,
    requiredCampaignSpendMinor: 0,
    feasible: true,
    infeasibleReason: null,
    ...overrides,
  };
}

describe("selectCandidate — the fixed constant", () => {
  it("is exactly 3", () => {
    expect(SLOW_MOVING_TOLERANCE_PERCENT).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — highest contribution wins when no slow-moving candidate qualifies
// ---------------------------------------------------------------------------

describe("selectCandidate — highest contribution wins with no slow-moving candidate in play", () => {
  it("picks the single highest-contribution candidate", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR });
    const middle = buildTieredCandidate({ contributionMinor: 90_000 });
    const worst = buildTieredCandidate({ contributionMinor: 10_000 });

    expect(selectCandidate([middle, worst, best])).toBe(best);
  });

  it("is unmoved by a slow-moving candidate that is far outside the 3% band", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const farSlowMover = buildTieredCandidate({ contributionMinor: 10_000, clearsSlowMoving: true });

    expect(selectCandidate([best, farSlowMover])).toBe(best);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion — the band changes selection at 2% behind, and does
// not at 4% behind
// ---------------------------------------------------------------------------

describe("selectCandidate — the 3% slow-moving band's boundary", () => {
  it("prefers the slow-moving candidate when it is 2% behind the best (inside the band)", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const slowMover2PercentBehind = buildTieredCandidate({
      contributionMinor: 98_000, // 2% behind 100_000
      clearsSlowMoving: true,
    });

    expect(selectCandidate([best, slowMover2PercentBehind])).toBe(slowMover2PercentBehind);
  });

  it("does not prefer the slow-moving candidate when it is 4% behind the best (outside the band)", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const slowMover4PercentBehind = buildTieredCandidate({
      contributionMinor: 96_000, // 4% behind 100_000
      clearsSlowMoving: true,
    });

    expect(selectCandidate([best, slowMover4PercentBehind])).toBe(best);
  });

  it("treats exactly 3% behind as inside the band ('within 3%' is inclusive)", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const slowMoverExactly3PercentBehind = buildTieredCandidate({
      contributionMinor: 97_000, // exactly 3% behind 100_000
      clearsSlowMoving: true,
    });

    expect(selectCandidate([best, slowMoverExactly3PercentBehind])).toBe(slowMoverExactly3PercentBehind);
  });

  it("does not prefer an in-band candidate that isn't slow-moving over the best", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const inBandButNotSlowMoving = buildTieredCandidate({
      contributionMinor: 98_000, // 2% behind, would qualify if slow-moving
      clearsSlowMoving: false,
    });

    expect(selectCandidate([best, inBandButNotSlowMoving])).toBe(best);
  });

  it("among several in-band slow-moving candidates, still picks the highest contribution of that group", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const weakerSlowMover = buildTieredCandidate({ contributionMinor: 97_500, clearsSlowMoving: true });
    const strongerSlowMover = buildTieredCandidate({ contributionMinor: 98_500, clearsSlowMoving: true });

    expect(selectCandidate([best, weakerSlowMover, strongerSlowMover])).toBe(strongerSlowMover);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — tiebreak on lowest campaign spend
// ---------------------------------------------------------------------------

describe("selectCandidate — tiebreak on lowest campaign spend", () => {
  it("picks the cheaper-to-fund candidate when contribution is tied", () => {
    const cheaper = buildTieredCandidate({
      contributionMinor: BEST_CONTRIBUTION_MINOR,
      tier: 2,
      requiredCampaignSpendMinor: 5_000,
    });
    const pricier = buildTieredCandidate({
      contributionMinor: BEST_CONTRIBUTION_MINOR,
      tier: 2,
      requiredCampaignSpendMinor: 20_000,
    });

    expect(selectCandidate([pricier, cheaper])).toBe(cheaper);
  });

  it("applies the campaign-spend tiebreak within the preferred slow-moving bucket too", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const cheaperSlowMover = buildTieredCandidate({
      contributionMinor: 98_000,
      clearsSlowMoving: true,
      tier: 2,
      requiredCampaignSpendMinor: 1_000,
    });
    const pricierSlowMover = buildTieredCandidate({
      contributionMinor: 98_000,
      clearsSlowMoving: true,
      tier: 2,
      requiredCampaignSpendMinor: 9_000,
    });

    expect(selectCandidate([best, pricierSlowMover, cheaperSlowMover])).toBe(cheaperSlowMover);
  });
});

// ---------------------------------------------------------------------------
// Ordering determinism
// ---------------------------------------------------------------------------

describe("selectCandidate — determinism", () => {
  it("returns the same winner regardless of the input array's order", () => {
    const best = buildTieredCandidate({ contributionMinor: BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const inBandSlowMover = buildTieredCandidate({ contributionMinor: 98_000, clearsSlowMoving: true });
    const middle = buildTieredCandidate({ contributionMinor: 50_000 });
    const cheapTier2 = buildTieredCandidate({
      contributionMinor: 30_000,
      tier: 2,
      requiredCampaignSpendMinor: 2_000,
    });

    const orderings = [
      [best, inBandSlowMover, middle, cheapTier2],
      [cheapTier2, middle, inBandSlowMover, best],
      [middle, best, cheapTier2, inBandSlowMover],
      [inBandSlowMover, cheapTier2, best, middle],
    ];

    const winners = orderings.map((candidates) => selectCandidate(candidates));
    for (const winner of winners) {
      expect(winner).toBe(inBandSlowMover);
    }
  });

  it("is a total order even when candidates tie all the way through contribution and campaign spend", () => {
    // Two structurally distinct candidates, tied on contribution and spend:
    // the content tiebreak must still pick the same one regardless of order.
    const tiedA = buildTieredCandidate({ contributionMinor: 50_000, requiredCampaignSpendMinor: 0 });
    const tiedB = buildTieredCandidate({ contributionMinor: 50_000, requiredCampaignSpendMinor: 0 });

    const winnerForwards = selectCandidate([tiedA, tiedB]);
    const winnerBackwards = selectCandidate([tiedB, tiedA]);

    expect(winnerForwards).toBe(winnerBackwards);
  });

  it("never depends on a weighted combination of contribution and slow-moving status", () => {
    // A slow-moving candidate arbitrarily far outside the band never wins
    // over the best, no matter how much lower its campaign spend is —
    // proving there is no scoring formula where a big enough spend
    // advantage could compensate for being outside the band.
    const best = buildTieredCandidate({
      contributionMinor: BEST_CONTRIBUTION_MINOR,
      clearsSlowMoving: false,
      tier: 2,
      requiredCampaignSpendMinor: 50_000,
    });
    const cheapButFarSlowMover = buildTieredCandidate({
      contributionMinor: 1_000,
      clearsSlowMoving: true,
      tier: 2,
      requiredCampaignSpendMinor: 0,
    });

    expect(selectCandidate([best, cheapButFarSlowMover])).toBe(best);
  });
});

// ---------------------------------------------------------------------------
// Large-value boundary — the tolerance check must stay exact even where
// `bestContributionMinor * SLOW_MOVING_TOLERANCE_PERCENT` would overflow
// Number.MAX_SAFE_INTEGER (~9.007e15) if computed as a direct product
// ---------------------------------------------------------------------------

describe("selectCandidate — the 3% band stays exact for very large contributions", () => {
  // A concrete value, found by scanning past bestContributionMinor ~3.0e15
  // (where best * 3 first exceeds Number.MAX_SAFE_INTEGER), at which the old
  // `gapMinor * 100 <= bestContributionMinor * 3` formula silently rounded
  // `bestContributionMinor * 3` to the wrong nearest double and let a
  // candidate one minor unit past the true 3% boundary through as if it
  // were still inside the band.
  const HUGE_BEST_CONTRIBUTION_MINOR = 3_002_399_751_580_333;
  // floor(HUGE_BEST_CONTRIBUTION_MINOR * 3 / 100), the true exact threshold.
  const EXACT_THRESHOLD_MINOR = 90_071_992_547_409;

  it("still prefers a slow-moving candidate exactly at the true 3% threshold", () => {
    const best = buildTieredCandidate({ contributionMinor: HUGE_BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const atThreshold = buildTieredCandidate({
      contributionMinor: HUGE_BEST_CONTRIBUTION_MINOR - EXACT_THRESHOLD_MINOR,
      clearsSlowMoving: true,
    });

    expect(selectCandidate([best, atThreshold])).toBe(atThreshold);
  });

  it("does not prefer a slow-moving candidate one minor unit past the true 3% threshold", () => {
    const best = buildTieredCandidate({ contributionMinor: HUGE_BEST_CONTRIBUTION_MINOR, clearsSlowMoving: false });
    const justPastThreshold = buildTieredCandidate({
      contributionMinor: HUGE_BEST_CONTRIBUTION_MINOR - (EXACT_THRESHOLD_MINOR + 1),
      clearsSlowMoving: true,
    });

    expect(selectCandidate([best, justPastThreshold])).toBe(best);
  });
});

// ---------------------------------------------------------------------------
// Fails closed
// ---------------------------------------------------------------------------

describe("selectCandidate — fails closed", () => {
  it("throws on an empty candidate array rather than returning undefined", () => {
    expect(() => selectCandidate([])).toThrow(/non-empty/i);
  });
});
