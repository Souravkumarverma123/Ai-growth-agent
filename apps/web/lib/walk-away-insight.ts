/**
 * TICKET-508 — Walk-away policy-change card (PRD §19, §20; Q7, Q27).
 *
 * "The feedback narrative without building the feedback loop." The live
 * feedback loop is an explicit MVP cut (PRD §19) — replaced by one card
 * computed from a run's real walk-away data: how many offers the buyer
 * refused, and what per-deal cap would have let the agent close the deal.
 *
 * This is the pure shaping layer. Every figure it returns is read straight
 * out of the session's append-only ledger (`audit.getSessionLedger`) — the
 * walk-away reason code, the `BUYER_DECLINES` events, the campaign spend on
 * the Tier 2 offers that were funded, and the economic facts the engine
 * records on the walk-away event itself (PRD §20: "the ledger holds every
 * walk-away code and shortfall"). Nothing here is hardcoded and nothing is
 * inferred beyond arithmetic the ledger already supports.
 *
 * Money stays in minor units (CONTRACTS.md §3); the card formats.
 */

import type { LedgerEvent } from "./event-stream";

export type { LedgerEvent } from "./event-stream";

/**
 * Walk-away reason codes whose story is about a binding cap or an exhausted
 * budget — the ones a policy change could actually have changed.
 */
const CAP_RELATED_WALK_AWAY = new Set<string>([
  "NO_FEASIBLE_BASKET",
  "DILUTION_EXCEEDS_PER_DEAL_CAP",
  "CAMPAIGN_BUDGET_EXHAUSTED",
]);

export type WalkAwayCapOutcome =
  /** A higher per-deal cap would have let the agent fund the deal. */
  | { kind: "cap-would-have-closed"; requiredCapMinor: number; perDealCapMinor: number }
  /** The shortfall exceeded the remaining campaign budget — the cap was not
   *  the binding limit, the budget was. */
  | { kind: "budget-bound"; shortfallMinor: number; availableCampaignBudgetMinor: number }
  /** A cap/budget walk-away, but this run's ledger did not record the
   *  shortfall figure, so no "what cap" number can be shown. */
  | { kind: "shortfall-unrecorded" }
  /** The walk-away was not about a cap (round limit reached, agent ended it,
   *  no negotiable SKU) — no policy cap change would have altered it. */
  | { kind: "not-cap-related" };

export type WalkAwayInsight = {
  /** The reason code on the terminal walk-away event — shown raw. */
  terminalReasonCode: string;
  /** How many rounds the engine evaluated a basket for (one per round). */
  roundsNegotiated: number;
  /** Offers the buyer refused during the run (`BUYER_DECLINES` events). */
  offersRefused: number;
  /**
   * The largest campaign top-up that was actually funded on a Tier 2 offer in
   * this run (`max` campaign spend over `DILUTION_WITHIN_CAPS` events), or
   * `null` if no Tier 2 offer was ever minted.
   */
  campaignFundedUpToMinor: number | null;
  capOutcome: WalkAwayCapOutcome;
};

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function sortedBySequence(events: readonly LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Build the walk-away card's data, or `null` when the session did not walk
 * away (the card does not render for a settled, declined or still-live
 * session).
 */
export function buildWalkAwayInsight(events: readonly LedgerEvent[]): WalkAwayInsight | null {
  const ordered = sortedBySequence(events);
  const last = ordered.at(-1);
  if (!last || last.toState !== "WALKED_AWAY") return null;

  const roundsNegotiated = ordered.filter((e) => e.reasonCode === "CANDIDATES_EVALUATED").length;
  const offersRefused = ordered.filter((e) => e.eventType === "BUYER_DECLINES").length;

  const fundedSpends = ordered
    .filter((e) => e.reasonCode === "DILUTION_WITHIN_CAPS" && e.campaignSpendMinor !== null)
    .map((e) => e.campaignSpendMinor as number);
  const campaignFundedUpToMinor = fundedSpends.length > 0 ? Math.max(...fundedSpends) : null;

  return {
    terminalReasonCode: last.reasonCode,
    roundsNegotiated,
    offersRefused,
    campaignFundedUpToMinor,
    capOutcome: resolveCapOutcome(last),
  };
}

function resolveCapOutcome(walkAwayEvent: LedgerEvent): WalkAwayCapOutcome {
  if (!CAP_RELATED_WALK_AWAY.has(walkAwayEvent.reasonCode)) {
    return { kind: "not-cap-related" };
  }

  const payload = walkAwayEvent.payload;
  const perDealCapMinor = readNonNegativeInt(payload.perDealCapMinor);
  const availableCampaignBudgetMinor = readNonNegativeInt(payload.availableCampaignBudgetMinor);
  // `requiredCampaignSpendMinor` — the exact shortfall of a rejected mint
  // (the MINT_ATTEMPTED path). `smallestRescueShortfallMinor` — the lowest
  // shortfall the engine saw when a whole round produced no feasible basket.
  // Either is "the top-up that would have closed at least one basket."
  const shortfallMinor =
    readNonNegativeInt(payload.requiredCampaignSpendMinor) ??
    readNonNegativeInt(payload.smallestRescueShortfallMinor);

  if (shortfallMinor === null || perDealCapMinor === null) {
    return { kind: "shortfall-unrecorded" };
  }

  if (availableCampaignBudgetMinor !== null && shortfallMinor > availableCampaignBudgetMinor) {
    return { kind: "budget-bound", shortfallMinor, availableCampaignBudgetMinor };
  }

  if (shortfallMinor > perDealCapMinor) {
    return { kind: "cap-would-have-closed", requiredCapMinor: shortfallMinor, perDealCapMinor };
  }

  // The shortfall was within the cap and within budget, yet the round still
  // produced nothing selectable — e.g. Tier 2 was still locked (no Tier 1
  // refusal yet). No cap change is implicated.
  return { kind: "shortfall-unrecorded" };
}
