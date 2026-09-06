import type { GeneratedCandidate } from "@repo/policy";

/**
 * TICKET-508 — the "what cap would have closed it" figure, recorded on the
 * ledger at the moment a round produces no selectable basket.
 *
 * PRD §20: "The ledger holds every walk-away code **and shortfall**; a
 * scheduled job is the extension." The reason code
 * (`NO_FEASIBLE_BASKET` / `DILUTION_EXCEEDS_PER_DEAL_CAP` /
 * `CAMPAIGN_BUDGET_EXHAUSTED`) already lands on the walk-away event; this adds
 * the raw economic facts of that round so the merchant console's walk-away
 * card (`apps/web/lib/walk-away-insight.ts`) can compute what a different
 * per-deal cap would have done — never hardcoding a figure downstream.
 *
 * This is a pure summary of the engine's own already-computed candidate
 * arithmetic (`generateCandidates`), assembled here only because the ledger
 * write happens in the transport layer. It decides nothing and prices
 * nothing — the number it reports is a candidate's own
 * `-contributionDeltaMinor`, straight from the engine.
 */

export type WalkAwayEconomics = {
  /** Merchant policy's per-deal cap at the time of the walk-away. */
  perDealCapMinor: number;
  /** `available = total − reserved − committed` for the campaign at that moment. */
  availableCampaignBudgetMinor: number;
  /**
   * The smallest campaign top-up that would have made at least one rescue
   * basket feasible this round — i.e. the lowest `-contributionDeltaMinor`
   * among the dilutive candidates the engine generated. `null` when the round
   * produced no dilutive candidate at all (nothing a larger cap could rescue).
   */
  smallestRescueShortfallMinor: number | null;
};

/**
 * Lowest shortfall (`-contributionDeltaMinor`) across the round's dilutive
 * candidates, or `null` if there were none. A dilutive candidate is one whose
 * contribution falls below the counterfactual — exactly the set tier
 * assignment would mark Tier 2.
 */
export function smallestRescueShortfallMinor(
  candidates: readonly GeneratedCandidate[],
): number | null {
  let smallest: number | null = null;
  for (const candidate of candidates) {
    if (candidate.contributionDeltaMinor >= 0) continue;
    const shortfall = -candidate.contributionDeltaMinor;
    if (smallest === null || shortfall < smallest) smallest = shortfall;
  }
  return smallest;
}

export function summarizeWalkAwayEconomics(input: {
  candidates: readonly GeneratedCandidate[];
  perDealCapMinor: number;
  availableCampaignBudgetMinor: number;
}): WalkAwayEconomics {
  return {
    perDealCapMinor: input.perDealCapMinor,
    availableCampaignBudgetMinor: input.availableCampaignBudgetMinor,
    smallestRescueShortfallMinor: smallestRescueShortfallMinor(input.candidates),
  };
}
