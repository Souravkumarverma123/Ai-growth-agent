import { describe, expect, it } from "vitest";

import type { GeneratedCandidate } from "@repo/policy";

import {
  smallestRescueShortfallMinor,
  summarizeWalkAwayEconomics,
} from "../server/routes/negotiation/walk-away-economics";

/**
 * TICKET-508 — the "what cap would have closed it" figure that the walk-away
 * card (`apps/web/lib/walk-away-insight.ts`) reads back off the ledger. This
 * is the pure summariser; the ledger round-trip and the card rendering are
 * covered by `apps/web/tests/walk-away-insight.test.tsx`.
 */

function candidate(contributionDeltaMinor: number): GeneratedCandidate {
  return {
    moveType: "PRICE_CONCESSION",
    basket: { currency: "INR", commitments: [], lines: [] },
    totalMinor: 0,
    contributionMinor: 0,
    contributionDeltaMinor,
    clearsSlowMoving: false,
  };
}

describe("smallestRescueShortfallMinor", () => {
  it("returns the lowest -contributionDeltaMinor among the dilutive candidates", () => {
    expect(
      smallestRescueShortfallMinor([candidate(1_000), candidate(-30_000), candidate(-20_000)]),
    ).toBe(20_000);
  });

  it("ignores self-funding candidates (delta >= 0)", () => {
    expect(smallestRescueShortfallMinor([candidate(5_000), candidate(0)])).toBeNull();
  });

  it("is null when there are no candidates at all", () => {
    expect(smallestRescueShortfallMinor([])).toBeNull();
  });
});

describe("summarizeWalkAwayEconomics", () => {
  it("carries the caps through verbatim and reports the smallest rescue shortfall once Tier 1 was refused", () => {
    expect(
      summarizeWalkAwayEconomics({
        candidates: [candidate(-30_000), candidate(-25_000)],
        tier1Refused: true,
        perDealCapMinor: 20_000,
        availableCampaignBudgetMinor: 4_980_000,
      }),
    ).toEqual({
      perDealCapMinor: 20_000,
      availableCampaignBudgetMinor: 4_980_000,
      smallestRescueShortfallMinor: 25_000,
    });
  });

  it("reports a null shortfall when the round produced nothing dilutive to rescue", () => {
    expect(
      summarizeWalkAwayEconomics({
        candidates: [candidate(10_000)],
        tier1Refused: true,
        perDealCapMinor: 20_000,
        availableCampaignBudgetMinor: 4_980_000,
      }).smallestRescueShortfallMinor,
    ).toBeNull();
  });

  it("reports a null shortfall when Tier 1 has not been refused — a locked Tier 2 candidate no cap change could reach", () => {
    expect(
      summarizeWalkAwayEconomics({
        candidates: [candidate(-30_000), candidate(-25_000)],
        tier1Refused: false,
        perDealCapMinor: 20_000,
        availableCampaignBudgetMinor: 4_980_000,
      }).smallestRescueShortfallMinor,
    ).toBeNull();
  });
});
