import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WalkAwayInsightCardView,
} from "~/app/merchant/sessions/[sessionId]/audit/walk-away-insight-card";
import { buildWalkAwayInsight, type LedgerEvent } from "~/lib/walk-away-insight";

/**
 * TICKET-508 — "Card figures match ledger contents."
 *
 * The walk-away narrative from PRD §18.2: bundle refused, Tier 2 funded at the
 * cap, then round 3's ask exceeds the per-deal cap and the engine walks away.
 * Every figure the card shows is asserted against the ledger it was built
 * from — nothing is hardcoded in the component.
 */

function ledgerEvent(
  overrides: Partial<LedgerEvent> & Pick<LedgerEvent, "sequence" | "reasonCode">,
): LedgerEvent {
  return {
    eventId: `evt-${overrides.sequence}`,
    timestamp: new Date(Date.UTC(2026, 8, 6, 10, 0, overrides.sequence)).toISOString(),
    eventType: "STATE_TRANSITION",
    fromState: "OPEN",
    toState: "OPEN",
    payload: {},
    policyVersion: 1,
    offerId: null,
    campaignSpendMinor: null,
    modelExplanation: null,
    modelExplanationIsAuthoritative: false,
    prevHash: overrides.sequence === 0 ? null : `hash-${overrides.sequence - 1}`,
    eventHash: `hash-${overrides.sequence}`,
    ...overrides,
  };
}

/**
 * The first nine events — flag → open → round 1 (bundle refused) → round 2
 * (Tier 2 funded at the cap, then declined). Every test appends its own
 * round-3 terminal event at sequence 9.
 */
const RUN_THROUGH_ROUND_2: LedgerEvent[] = [
  ledgerEvent({ sequence: 0, eventType: "ELIGIBILITY_RULES_MATCH", fromState: "IDLE", toState: "AT_RISK", reasonCode: "SESSION_FLAGGED_AT_RISK" }),
  ledgerEvent({ sequence: 1, eventType: "NEGOTIATION_REQUESTED", fromState: "AT_RISK", toState: "OPEN", reasonCode: "NEGOTIATION_OPENED" }),
  // Round 1
  ledgerEvent({ sequence: 2, eventType: "CANDIDATES_GENERATED", reasonCode: "CANDIDATES_EVALUATED", payload: { evaluatedCount: 12, selfFundingCount: 4 } }),
  ledgerEvent({ sequence: 3, eventType: "OFFER_MINTED", fromState: "OPEN", toState: "OFFER_PENDING", reasonCode: "TIER1_OFFERED", payload: { candidateId: "C1" } }),
  ledgerEvent({ sequence: 4, eventType: "BUYER_DECLINES", fromState: "OFFER_PENDING", toState: "OPEN", reasonCode: "TIER1_REFUSED_BY_BUYER", payload: { offerId: "o1" } }),
  // Round 2 — Tier 2 offer funded at the cap, then declined
  ledgerEvent({ sequence: 5, eventType: "CANDIDATES_GENERATED", reasonCode: "CANDIDATES_EVALUATED", payload: { evaluatedCount: 10, selfFundingCount: 0 } }),
  ledgerEvent({ sequence: 6, eventType: "OFFER_MINTED", fromState: "OPEN", toState: "OFFER_PENDING", reasonCode: "DILUTION_WITHIN_CAPS", payload: { candidateId: "C2" }, campaignSpendMinor: 20_000 }),
  ledgerEvent({ sequence: 7, eventType: "BUDGET_RESERVED", fromState: "OFFER_PENDING", toState: "OFFER_PENDING", reasonCode: "HOLD_RESERVED", payload: { amountMinor: 20_000 }, campaignSpendMinor: 20_000 }),
  ledgerEvent({ sequence: 8, eventType: "BUYER_DECLINES", fromState: "OFFER_PENDING", toState: "OPEN", reasonCode: "HOLD_RELEASED", payload: { offerId: "o2" } }),
];

/**
 * Round 3 — the engine generates candidates, nothing clears the per-deal cap,
 * and the CANDIDATES_GENERATED event IS the walk-away (one event per round).
 */
const NO_FEASIBLE_BASKET_WALK_AWAY = ledgerEvent({
  sequence: 9,
  eventType: "CANDIDATES_GENERATED",
  fromState: "OPEN",
  toState: "WALKED_AWAY",
  reasonCode: "NO_FEASIBLE_BASKET",
  payload: {
    evaluatedCount: 8,
    selfFundingCount: 0,
    perDealCapMinor: 20_000,
    availableCampaignBudgetMinor: 4_980_000,
    smallestRescueShortfallMinor: 30_000,
  },
});

const WALK_AWAY_RUN: LedgerEvent[] = [...RUN_THROUGH_ROUND_2, NO_FEASIBLE_BASKET_WALK_AWAY];

describe("buildWalkAwayInsight", () => {
  it("computes every figure from the ledger for the PRD §18.2 walk-away run", () => {
    const insight = buildWalkAwayInsight(WALK_AWAY_RUN)!;
    expect(insight).toEqual({
      terminalReasonCode: "NO_FEASIBLE_BASKET",
      roundsNegotiated: 3,
      offersRefused: 2,
      campaignFundedUpToMinor: 20_000,
      capOutcome: {
        kind: "cap-would-have-closed",
        requiredCapMinor: 30_000,
        perDealCapMinor: 20_000,
      },
    });
  });

  it("counts the walk-away round even though its event is NO_FEASIBLE_BASKET, not CANDIDATES_EVALUATED", () => {
    // Only rounds 1 and 2 write a CANDIDATES_EVALUATED event; round 3 walked away.
    expect(buildWalkAwayInsight(WALK_AWAY_RUN)!.roundsNegotiated).toBe(3);
  });

  it("returns null when the session did not walk away", () => {
    const settled = [
      ...RUN_THROUGH_ROUND_2,
      ledgerEvent({ sequence: 9, eventType: "BUYER_ACCEPTS", fromState: "OFFER_PENDING", toState: "ACCEPTED", reasonCode: "OFFER_ACCEPTED" }),
    ];
    expect(buildWalkAwayInsight(settled)).toBeNull();
  });

  it("reads the exact shortfall off the MINT_ATTEMPTED walk-away payload", () => {
    const events = [
      ...RUN_THROUGH_ROUND_2,
      ledgerEvent({
        sequence: 9,
        eventType: "MINT_ATTEMPTED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
        payload: { candidateId: "C3", requiredCampaignSpendMinor: 30_000, perDealCapMinor: 20_000, availableCampaignBudgetMinor: 4_980_000 },
      }),
    ];
    expect(buildWalkAwayInsight(events)!.capOutcome).toEqual({
      kind: "cap-would-have-closed",
      requiredCapMinor: 30_000,
      perDealCapMinor: 20_000,
    });
  });

  it("trusts the CAMPAIGN_BUDGET_EXHAUSTED reason code even when the payload omits the budget figure", () => {
    const events = [
      ...RUN_THROUGH_ROUND_2,
      ledgerEvent({
        sequence: 9,
        eventType: "MINT_ATTEMPTED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED",
        // reservation-race payload: shortfall within the (stale) snapshot budget
        payload: { candidateId: "C3", requiredCampaignSpendMinor: 30_000, perDealCapMinor: 20_000, availableCampaignBudgetMinor: 40_000 },
      }),
    ];
    expect(buildWalkAwayInsight(events)!.capOutcome).toEqual({
      kind: "budget-bound",
      shortfallMinor: 30_000,
      availableCampaignBudgetMinor: 40_000,
    });
  });

  it("reports budget-bound on a NO_FEASIBLE_BASKET walk-away when the shortfall exceeds the remaining budget", () => {
    const events = [
      ...RUN_THROUGH_ROUND_2,
      ledgerEvent({
        sequence: 9,
        eventType: "CANDIDATES_GENERATED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "NO_FEASIBLE_BASKET",
        payload: { perDealCapMinor: 20_000, availableCampaignBudgetMinor: 5_000, smallestRescueShortfallMinor: 30_000 },
      }),
    ];
    expect(buildWalkAwayInsight(events)!.capOutcome).toEqual({
      kind: "budget-bound",
      shortfallMinor: 30_000,
      availableCampaignBudgetMinor: 5_000,
    });
  });

  it("says the shortfall was not recorded when a Tier 1 refusal never happened (locked Tier 2, null shortfall)", () => {
    const events = [
      ...RUN_THROUGH_ROUND_2.slice(0, 2),
      ledgerEvent({
        sequence: 2,
        eventType: "CANDIDATES_GENERATED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "NO_FEASIBLE_BASKET",
        payload: { perDealCapMinor: 20_000, availableCampaignBudgetMinor: 4_980_000, smallestRescueShortfallMinor: null },
      }),
    ];
    expect(buildWalkAwayInsight(events)!.capOutcome).toEqual({ kind: "shortfall-unrecorded" });
  });

  it("marks a round-limit walk-away as not cap-related", () => {
    const events = [
      ...RUN_THROUGH_ROUND_2,
      ledgerEvent({
        sequence: 9,
        eventType: "ROUND_INCREMENTED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "ROUND_LIMIT_REACHED",
        payload: { roundIndex: 4, maxRounds: 3 },
      }),
    ];
    expect(buildWalkAwayInsight(events)!.capOutcome).toEqual({ kind: "not-cap-related" });
  });
});

describe("WalkAwayInsightCardView", () => {
  it("renders the ledger-derived figures and the cap that would have closed the deal", () => {
    render(<WalkAwayInsightCardView insight={buildWalkAwayInsight(WALK_AWAY_RUN)!} />);

    const card = screen.getByTestId("walk-away-card");
    expect(card.getAttribute("data-reason-code")).toBe("NO_FEASIBLE_BASKET");
    expect(within(card).getByText("NO_FEASIBLE_BASKET")).toBeInTheDocument();

    expect(card.querySelector('[data-figure="offersRefused"]')).toHaveTextContent("2");
    expect(card.querySelector('[data-figure="campaignFundedUpTo"]')).toHaveTextContent("₹200.00");

    const outcome = within(card).getByTestId("cap-outcome");
    expect(outcome.getAttribute("data-kind")).toBe("cap-would-have-closed");
    expect(outcome).toHaveTextContent("₹300.00");
    expect(outcome).toHaveTextContent("₹200.00");
  });

  it("shows a dash for campaign funding when no Tier 2 offer was ever minted", () => {
    const noTier2 = [
      ...RUN_THROUGH_ROUND_2.slice(0, 5),
      ledgerEvent({
        sequence: 5,
        eventType: "ROUND_INCREMENTED",
        fromState: "OPEN",
        toState: "WALKED_AWAY",
        reasonCode: "ROUND_LIMIT_REACHED",
        payload: {},
      }),
    ];
    render(<WalkAwayInsightCardView insight={buildWalkAwayInsight(noTier2)!} />);
    const card = screen.getByTestId("walk-away-card");
    expect(card.querySelector('[data-figure="campaignFundedUpTo"]')).toHaveTextContent("—");
    expect(within(card).getByTestId("cap-outcome").getAttribute("data-kind")).toBe("not-cap-related");
  });
});
