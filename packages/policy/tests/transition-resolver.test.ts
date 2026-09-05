import { describe, expect, it } from "vitest";

import { REASON_CODES, TRANSITIONS } from "../contracts";
import type { StateTransition } from "../contracts/state-machine";
import type { TieredCandidate } from "../generation/tiering";
import {
  lookupTransition,
  resolveAgentTerminalIntentTransition,
  resolveBudgetReservedTransition,
  resolveBuyerDeclinesTransition,
  resolveBuyerEndsSessionTransition,
  resolveCandidatesGeneratedTransition,
  resolveEligibilityFlagTransition,
  resolveFloorBreachTransition,
  resolveHoldCommittedTransition,
  resolveHoldReleaseTransition,
  resolveMintAttemptedTransition,
  resolveNegotiationRequestedTransition,
  resolveOfferAcceptTransition,
  resolveOfferMintedTransition,
  resolvePaymentInitiationTransition,
  resolveRailReportTransition,
  resolveRoundIncrementedTransition,
  resolveTtlElapsedTransition,
} from "../ledger/transition-resolver";

/**
 * TICKET-402 — reason code enforcement at every transition (PRD §14, §15).
 *
 * This suite is the ticket's real center of gravity: an exhaustive walk of
 * every row in the frozen `TRANSITIONS` table, each exercised through a real
 * call to this module's resolver functions with inputs engineered to hit
 * that exact row — never by reading `TRANSITIONS` and asserting it agrees
 * with itself. `toBe` (not `toEqual`) is used throughout: every resolver
 * returns a *reference* to the actual `TRANSITIONS` element it found, so
 * reference equality against a `TRANSITIONS.find(...)` lookup proves the
 * resolver reached the identical row, not merely a structurally similar one.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_SKU_ID = "00000000-0000-0000-0000-000000000000";

function makeTieredCandidate(overrides: Partial<TieredCandidate>): TieredCandidate {
  return {
    moveType: "PRICE_CONCESSION",
    basket: {
      lines: [{ skuId: STUB_SKU_ID, quantity: 1, unitPriceMinor: 1000 }],
      commitments: [],
      currency: "INR",
    },
    totalMinor: 1000,
    contributionMinor: 100,
    contributionDeltaMinor: 0,
    clearsSlowMoving: false,
    tier: 1,
    requiredCampaignSpendMinor: 0,
    feasible: true,
    infeasibleReason: null,
    ...overrides,
  };
}

function findRow(reasonCode: string, from?: string): StateTransition {
  const row = TRANSITIONS.find((t) => t.reasonCode === reasonCode && (from === undefined || t.from === from));
  if (!row) throw new Error(`test fixture bug: no TRANSITIONS row for reasonCode="${reasonCode}", from="${from}"`);
  return row;
}

// ---------------------------------------------------------------------------
// Exhaustive walk — every one of the 30 rows in TRANSITIONS, reached via a
// real resolver call engineered to hit it.
// ---------------------------------------------------------------------------

describe("TICKET-402 — exhaustive walk of the transition table", () => {
  const cases: Array<{ name: string; call: () => StateTransition; expected: StateTransition }> = [
    {
      name: "IDLE -ELIGIBILITY_RULES_MATCH-> AT_RISK (SESSION_FLAGGED_AT_RISK)",
      call: () => resolveEligibilityFlagTransition(),
      expected: findRow("SESSION_FLAGGED_AT_RISK"),
    },
    {
      name: "IDLE -NEGOTIATION_REQUESTED-> IDLE (NOT_AT_RISK)",
      call: () => resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "NOT_AT_RISK" }),
      expected: findRow("NOT_AT_RISK"),
    },
    {
      name: "AT_RISK -NEGOTIATION_REQUESTED-> HALTED (NEGOTIATION_DISABLED)",
      call: () => resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "NEGOTIATION_DISABLED" }),
      expected: findRow("NEGOTIATION_DISABLED"),
    },
    {
      name: "AT_RISK -NEGOTIATION_REQUESTED-> WALKED_AWAY (SKU_NOT_NEGOTIABLE)",
      call: () => resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "SKU_NOT_NEGOTIABLE" }),
      expected: findRow("SKU_NOT_NEGOTIABLE"),
    },
    {
      name: "AT_RISK -NEGOTIATION_REQUESTED-> OPEN (NEGOTIATION_OPENED)",
      call: () => resolveNegotiationRequestedTransition({ eligible: true, reasonCode: "NEGOTIATION_OPENED" }),
      expected: findRow("NEGOTIATION_OPENED"),
    },
    {
      name: "OPEN -CANDIDATES_GENERATED-> OPEN (CANDIDATES_EVALUATED)",
      call: () =>
        resolveCandidatesGeneratedTransition({
          feasible: true,
          candidates: [makeTieredCandidate({})],
          selectableCandidates: [makeTieredCandidate({})],
        }),
      expected: findRow("CANDIDATES_EVALUATED"),
    },
    {
      name: "OPEN -CANDIDATES_GENERATED-> WALKED_AWAY (NO_FEASIBLE_BASKET)",
      call: () => resolveCandidatesGeneratedTransition({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" }),
      expected: findRow("NO_FEASIBLE_BASKET"),
    },
    {
      name: "OPEN -OFFER_MINTED-> OFFER_PENDING (TIER1_OFFERED)",
      call: () =>
        resolveOfferMintedTransition(
          makeTieredCandidate({ tier: 1, feasible: true, infeasibleReason: null }),
          false,
          false,
        ),
      expected: findRow("TIER1_OFFERED"),
    },
    {
      name: "OPEN -OFFER_MINTED-> OFFER_PENDING (DILUTION_WITHIN_CAPS)",
      call: () =>
        resolveOfferMintedTransition(
          makeTieredCandidate({
            tier: 2,
            feasible: true,
            infeasibleReason: null,
            contributionDeltaMinor: -500,
            requiredCampaignSpendMinor: 500,
          }),
          true,
          true,
        ),
      expected: findRow("DILUTION_WITHIN_CAPS"),
    },
    {
      name: "OPEN -MINT_ATTEMPTED-> WALKED_AWAY (DILUTION_EXCEEDS_PER_DEAL_CAP)",
      call: () =>
        resolveMintAttemptedTransition(
          makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: "DILUTION_EXCEEDS_PER_DEAL_CAP" }),
        ),
      expected: findRow("DILUTION_EXCEEDS_PER_DEAL_CAP"),
    },
    {
      name: "OPEN -MINT_ATTEMPTED-> WALKED_AWAY (CAMPAIGN_BUDGET_EXHAUSTED)",
      call: () =>
        resolveMintAttemptedTransition(
          makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
        ),
      expected: findRow("CAMPAIGN_BUDGET_EXHAUSTED"),
    },
    {
      name: "OPEN -ROUND_INCREMENTED-> WALKED_AWAY (ROUND_LIMIT_REACHED)",
      call: () => resolveRoundIncrementedTransition(4, 3),
      expected: findRow("ROUND_LIMIT_REACHED"),
    },
    {
      name: "OPEN -AGENT_TERMINAL_INTENT-> WALKED_AWAY (WALK_AWAY)",
      call: () =>
        resolveAgentTerminalIntentTransition({
          candidateId: "cand_1",
          messageFrame: "BUNDLE_VALUE",
          terminalAction: "WALK_AWAY",
        }),
      expected: findRow("WALK_AWAY"),
    },
    {
      name: "OFFER_PENDING -BUDGET_RESERVED-> OFFER_PENDING (HOLD_RESERVED)",
      call: () => resolveBudgetReservedTransition(2),
      expected: findRow("HOLD_RESERVED"),
    },
    {
      name: "OFFER_PENDING -BUYER_DECLINES-> OPEN (TIER1_REFUSED_BY_BUYER)",
      call: () => resolveBuyerDeclinesTransition(1),
      expected: findRow("TIER1_REFUSED_BY_BUYER"),
    },
    {
      name: "OFFER_PENDING -BUYER_DECLINES-> OPEN (HOLD_RELEASED)",
      call: () => resolveBuyerDeclinesTransition(2),
      expected: findRow("HOLD_RELEASED", "OFFER_PENDING"),
    },
    {
      name: "OFFER_PENDING -TTL_ELAPSED-> EXPIRED (OFFER_EXPIRED)",
      call: () => resolveTtlElapsedTransition(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z")),
      expected: findRow("OFFER_EXPIRED"),
    },
    {
      name: "OFFER_PENDING -BUYER_ENDS_SESSION-> DECLINED (BUYER_DECLINED)",
      call: () => resolveBuyerEndsSessionTransition(),
      expected: findRow("BUYER_DECLINED"),
    },
    {
      name: "OFFER_PENDING -ACCEPT_ATTEMPTED-> OFFER_PENDING (BASKET_MISMATCH)",
      call: () => resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: false }),
      expected: findRow("BASKET_MISMATCH"),
    },
    {
      name: "OFFER_PENDING -ACCEPT_ATTEMPTED-> OFFER_PENDING (OFFER_ALREADY_CONSUMED)",
      call: () => resolveOfferAcceptTransition({ alreadyConsumed: true, basketMatches: true }),
      expected: findRow("OFFER_ALREADY_CONSUMED"),
    },
    {
      name: "OFFER_PENDING -BUYER_ACCEPTS-> ACCEPTED (OFFER_ACCEPTED)",
      call: () => resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true }),
      expected: findRow("OFFER_ACCEPTED"),
    },
    {
      name: "ACCEPTED -TERMINAL_ACTION-> ACCEPTED (AUTONOMOUS_PAYMENT_NOT_AUTHORIZED)",
      call: () => resolvePaymentInitiationTransition(true),
      expected: findRow("AUTONOMOUS_PAYMENT_NOT_AUTHORIZED"),
    },
    {
      name: "ACCEPTED -ORDER_CREATED-> AWAITING_PAYMENT (ORDER_CREATED)",
      call: () => resolvePaymentInitiationTransition(false),
      expected: findRow("ORDER_CREATED"),
    },
    {
      name: "AWAITING_PAYMENT -RAIL_REPORTS_CAPTURED-> SETTLED (PAYMENT_CAPTURED)",
      call: () => resolveRailReportTransition("CAPTURED"),
      expected: findRow("PAYMENT_CAPTURED"),
    },
    {
      name: "SETTLED -HOLD_COMMITTED-> SETTLED (HOLD_COMMITTED)",
      call: () => resolveHoldCommittedTransition(2),
      expected: findRow("HOLD_COMMITTED"),
    },
    {
      name: "AWAITING_PAYMENT -RAIL_REPORTS_FAILED-> PAYMENT_FAILED (PAYMENT_FAILED)",
      call: () => resolveRailReportTransition("FAILED"),
      expected: findRow("PAYMENT_FAILED"),
    },
    {
      name: "AWAITING_PAYMENT -RAIL_CONTRADICTS_LOCAL-> PAYMENT_FAILED (RAIL_STATE_DIVERGENCE)",
      call: () => resolveRailReportTransition("CONTRADICTS_LOCAL"),
      expected: findRow("RAIL_STATE_DIVERGENCE"),
    },
    {
      name: "EXPIRED -HOLD_RELEASED-> EXPIRED (HOLD_RELEASED)",
      call: () => resolveHoldReleaseTransition("EXPIRED", 2),
      expected: findRow("HOLD_RELEASED", "EXPIRED"),
    },
    {
      name: "PAYMENT_FAILED -HOLD_RELEASED-> PAYMENT_FAILED (HOLD_RELEASED)",
      call: () => resolveHoldReleaseTransition("PAYMENT_FAILED", 2),
      expected: findRow("HOLD_RELEASED", "PAYMENT_FAILED"),
    },
    {
      name: "* -SUB_FLOOR_CANDIDATE_DETECTED-> HALTED (FLOOR_BREACH, defensive assertion)",
      call: () => resolveFloorBreachTransition(),
      expected: findRow("FLOOR_BREACH"),
    },
  ];

  it.each(cases)("$name", ({ call, expected }) => {
    expect(call()).toBe(expected);
  });

  it("covers every single row of TRANSITIONS exactly once — the walk above is a bijection, not just a sample", () => {
    const reachedRows = cases.map((c) => c.call());
    expect(reachedRows).toHaveLength(TRANSITIONS.length);
    // Every TRANSITIONS row appears in the reached set...
    for (const row of TRANSITIONS) {
      expect(reachedRows).toContain(row);
    }
    // ...and every reached row is a distinct TRANSITIONS element (no row hit twice).
    expect(new Set(reachedRows).size).toBe(TRANSITIONS.length);
  });
});

// ---------------------------------------------------------------------------
// Every one of the 28 reason codes is reachable via a resolver call path.
// ---------------------------------------------------------------------------

describe("TICKET-402 — every reason code is reachable through the resolver, not merely present in TRANSITIONS", () => {
  it("collects all 28 codes purely from resolver return values", () => {
    const reached = new Set<string>([
      resolveEligibilityFlagTransition().reasonCode,
      resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "NOT_AT_RISK" }).reasonCode,
      resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "NEGOTIATION_DISABLED" }).reasonCode,
      resolveNegotiationRequestedTransition({ eligible: false, reasonCode: "SKU_NOT_NEGOTIABLE" }).reasonCode,
      resolveNegotiationRequestedTransition({ eligible: true, reasonCode: "NEGOTIATION_OPENED" }).reasonCode,
      resolveCandidatesGeneratedTransition({
        feasible: true,
        candidates: [makeTieredCandidate({})],
        selectableCandidates: [makeTieredCandidate({})],
      }).reasonCode,
      resolveCandidatesGeneratedTransition({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" }).reasonCode,
      resolveOfferMintedTransition(makeTieredCandidate({ tier: 1 }), false, false).reasonCode,
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 2, feasible: true, infeasibleReason: null }),
        true,
        true,
      ).reasonCode,
      resolveMintAttemptedTransition(
        makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: "DILUTION_EXCEEDS_PER_DEAL_CAP" }),
      ).reasonCode,
      resolveMintAttemptedTransition(
        makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
      ).reasonCode,
      resolveRoundIncrementedTransition(4, 3).reasonCode,
      resolveAgentTerminalIntentTransition({
        candidateId: "cand_1",
        messageFrame: "BUNDLE_VALUE",
        terminalAction: "WALK_AWAY",
      }).reasonCode,
      resolveBudgetReservedTransition(2).reasonCode,
      resolveBuyerDeclinesTransition(1).reasonCode,
      resolveBuyerDeclinesTransition(2).reasonCode,
      resolveTtlElapsedTransition(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z")).reasonCode,
      resolveBuyerEndsSessionTransition().reasonCode,
      resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: false }).reasonCode,
      resolveOfferAcceptTransition({ alreadyConsumed: true, basketMatches: true }).reasonCode,
      resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true }).reasonCode,
      resolvePaymentInitiationTransition(true).reasonCode,
      resolvePaymentInitiationTransition(false).reasonCode,
      resolveRailReportTransition("CAPTURED").reasonCode,
      resolveHoldCommittedTransition(2).reasonCode,
      resolveRailReportTransition("FAILED").reasonCode,
      resolveRailReportTransition("CONTRADICTS_LOCAL").reasonCode,
      resolveHoldReleaseTransition("EXPIRED", 2).reasonCode,
      resolveHoldReleaseTransition("PAYMENT_FAILED", 2).reasonCode,
      resolveFloorBreachTransition().reasonCode,
    ]);

    expect(reached).toEqual(new Set(REASON_CODES));
    expect(reached.size).toBe(28);
  });

  it("FLOOR_BREACH is reachable only through the defensive resolveFloorBreachTransition path", () => {
    // Every other resolver call above, none of which touches
    // resolveFloorBreachTransition, never produces FLOOR_BREACH.
    const nonDefensiveResults = [
      resolveEligibilityFlagTransition(),
      resolveNegotiationRequestedTransition({ eligible: true, reasonCode: "NEGOTIATION_OPENED" }),
      resolveCandidatesGeneratedTransition({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" }),
      resolveOfferMintedTransition(makeTieredCandidate({ tier: 1 }), false, false),
      resolveRoundIncrementedTransition(4, 3),
      resolveBudgetReservedTransition(2),
      resolveBuyerEndsSessionTransition(),
      resolvePaymentInitiationTransition(false),
      resolveRailReportTransition("CAPTURED"),
      resolveHoldCommittedTransition(2),
    ];
    for (const result of nonDefensiveResults) {
      expect(result.reasonCode).not.toBe("FLOOR_BREACH");
    }
    expect(resolveFloorBreachTransition().reasonCode).toBe("FLOOR_BREACH");
  });
});

// ---------------------------------------------------------------------------
// Failure paths — a resolver never silently defaults to a code.
// ---------------------------------------------------------------------------

describe("TICKET-402 — a resolver fails loudly instead of guessing", () => {
  it("lookupTransition throws for a fabricated nonsense from/event/reasonCode triple not in TRANSITIONS", () => {
    // IDLE never fires TTL_ELAPSED in the real table at all.
    expect(() => lookupTransition("IDLE", "TTL_ELAPSED", "OFFER_EXPIRED")).toThrow();
    // A real event/reasonCode pair, but from a from-state that never pairs with it.
    expect(() => lookupTransition("SETTLED", "BUYER_DECLINES", "TIER1_REFUSED_BY_BUYER")).toThrow();
  });

  it("resolveOfferMintedTransition throws for an infeasible tier 2 candidate rather than minting it", () => {
    expect(() =>
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
        true,
        true,
      ),
    ).toThrow();
  });

  it("resolveOfferMintedTransition throws for a tier 2 candidate before tier1Refused is true", () => {
    expect(() =>
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 2, feasible: true, infeasibleReason: null }),
        false,
        true,
      ),
    ).toThrow();
  });

  it("resolveOfferMintedTransition throws when the RA-3 re-check fails", () => {
    expect(() =>
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 2, feasible: true, infeasibleReason: null }),
        true,
        false,
      ),
    ).toThrow();
  });

  it("resolveMintAttemptedTransition throws for a feasible candidate", () => {
    expect(() => resolveMintAttemptedTransition(makeTieredCandidate({ feasible: true, infeasibleReason: null }))).toThrow();
  });

  it("resolveMintAttemptedTransition throws when infeasibleReason isn't one of its two codes", () => {
    expect(() =>
      resolveMintAttemptedTransition(makeTieredCandidate({ tier: 2, feasible: false, infeasibleReason: null })),
    ).toThrow();
  });

  it("resolveOfferMintedTransition throws for a malformed tier 1 candidate marked infeasible", () => {
    expect(() =>
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 1, feasible: false, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
        false,
        false,
      ),
    ).toThrow();
  });

  it("resolveOfferMintedTransition throws for a malformed tier 1 candidate carrying a stray infeasibleReason", () => {
    expect(() =>
      resolveOfferMintedTransition(
        makeTieredCandidate({ tier: 1, feasible: true, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
        false,
        false,
      ),
    ).toThrow();
  });

  it("resolveMintAttemptedTransition throws for a malformed tier 1 candidate marked infeasible", () => {
    expect(() =>
      resolveMintAttemptedTransition(
        makeTieredCandidate({ tier: 1, feasible: false, infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED" }),
      ),
    ).toThrow();
  });

  it("resolveRoundIncrementedTransition throws when the round has not exceeded maxRounds", () => {
    expect(() => resolveRoundIncrementedTransition(3, 3)).toThrow();
  });

  it("resolveAgentTerminalIntentTransition throws without a WALK_AWAY terminalAction", () => {
    expect(() =>
      resolveAgentTerminalIntentTransition({ candidateId: "cand_1", messageFrame: "FINAL_POSITION" }),
    ).toThrow();
  });

  it("resolveBudgetReservedTransition throws for a tier 1 offer", () => {
    expect(() => resolveBudgetReservedTransition(1)).toThrow();
  });

  it("resolveTtlElapsedTransition throws when now has not passed expiresAt", () => {
    expect(() =>
      resolveTtlElapsedTransition(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z")),
    ).toThrow();
  });

  it("resolveHoldCommittedTransition throws for a tier 1 offer", () => {
    expect(() => resolveHoldCommittedTransition(1)).toThrow();
  });

  it("resolveHoldReleaseTransition throws for a tier 1 offer", () => {
    expect(() => resolveHoldReleaseTransition("EXPIRED", 1)).toThrow();
  });
});
