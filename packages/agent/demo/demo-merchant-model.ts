import type { Candidate, CandidateMoveType, MessageFrame, NegotiationIntent } from "@repo/policy";

import type { NegotiationModel, NegotiationRoundInput } from "../model";

/**
 * TICKET-206 — the merchant side of the demo harness.
 *
 * `packages/trpc`'s `DeterministicMerchantModel` (TICKET-204) always picks
 * the highest-contribution candidate via `selectCandidate`, which in a
 * single-shot pipeline is essentially always a self-funding Tier 1 "add more
 * value" bundle — so a Tier 2 offer is never actually reached end to end
 * (ISSUE-012, sub-issue 12e). That is fine for the tRPC surface's own tests,
 * but it means a buyer who wants to *spend less* only ever sees bundles that
 * cost more, and every negotiation ends the same way.
 *
 * This model plays a merchant genuinely trying to reach a deal with a
 * price-sensitive buyer: each round it offers the **lowest-total candidate
 * the engine is exposing** — a small structural concession (a commitment
 * swap, a light bundle) while only Tier 1 is available, then the plain
 * discounted cart (a feasible Tier 2 `PRICE_CONCESSION`) once a Tier 1
 * refusal has unlocked Tier 2, and back to the cheapest Tier 1 option in the
 * final round once the Tier 2 shortfall has grown past the per-deal cap and
 * the engine has marked it infeasible (PRD §18.2's round 3).
 *
 * This is B4-legal (CONTRACTS.md §2): B4 forbids conversation content from
 * reaching `packages/policy`'s candidate *generator*. This model chooses
 * among an already-generated, already-tiered, already-exposed set and never
 * sees or forwards buyer text. It emits a frozen `NegotiationIntent`
 * (`candidateId` + `messageFrame`), no number, exactly like every other
 * `NegotiationModel`.
 */

const MOVE_TYPE_MESSAGE_FRAME: Record<CandidateMoveType, MessageFrame> = {
  PRICE_CONCESSION: "FINAL_POSITION",
  ADD_SKU: "BUNDLE_VALUE",
  ADD_SLOW_MOVING_SKU: "SLOW_MOVING_CLEARANCE",
  INCREASE_QUANTITY: "QUANTITY_VALUE",
  COMMITMENT_SWAP: "COMMITMENT_TRADE",
};

/** Lowest total, deterministic tiebreak on candidateId. */
function lowestTotalCandidate(candidates: readonly Candidate[]): Candidate {
  return [...candidates].sort(
    (a, b) => a.totalMinor - b.totalMinor || a.candidateId.localeCompare(b.candidateId),
  )[0]!;
}

export class DemoMerchantModel implements NegotiationModel {
  nextIntent(input: NegotiationRoundInput): NegotiationIntent {
    const { candidates } = input;
    if (candidates.length === 0) {
      throw new Error("DemoMerchantModel: no candidates were exposed for this round");
    }

    // `candidates` is the already-exposed set (Tier 1, plus Tier 2 once a
    // Tier 1 refusal has unlocked it — RA-2, `selectExposedCandidates`).
    // Offer the cheapest thing on the table.
    const chosen = lowestTotalCandidate(candidates);

    return {
      candidateId: chosen.candidateId,
      messageFrame: MOVE_TYPE_MESSAGE_FRAME[chosen.moveType],
    };
  }
}
