import type { NegotiationModel, NegotiationRoundInput } from "@repo/agent";
import type {
  Candidate,
  CandidateMoveType,
  MessageFrame,
  NegotiationIntent,
} from "@repo/policy/contracts";
import type { TieredCandidate } from "@repo/policy";

/**
 * TICKET-204 — negotiation protocol procedures (PRD §18, CONTRACTS.md §9).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS INSTEAD OF A REAL MODEL FROM `packages/agent`
 * ============================================================================
 * TICKET-201 (`packages/agent/model/negotiation-model.ts`) defines the
 * `NegotiationModel` interface and ships exactly one implementation,
 * `ScriptedNegotiationModel` — a fixed-sequence test double, by design. A
 * real, LLM-backed implementation is downstream work; the buyer-facing
 * surface still needs SOME implementation to drive a negotiation end to end.
 *
 * `DeterministicMerchantModel` below is that honest stand-in. It satisfies
 * `NegotiationModel` without violating any invariant:
 *   - It only ever returns a `candidateId` that was in the `candidates` it
 *     was given (`pickConcessionCandidate` below never invents one).
 *   - `messageFrame` is a pure function of the chosen candidate's
 *     `moveType` — no free text, no numbers, nothing conversation-derived.
 *   - It never selects `terminalAction: "WALK_AWAY"` itself; the caller
 *     (`route.ts`) decides WALK_AWAY paths (round-limit, no-feasible-basket)
 *     before ever invoking a model at all.
 *
 * ============================================================================
 * IT CONCEDES TOWARD THE BUYER — it does not upsell (ISSUE-012 sub-issue 12e)
 * ============================================================================
 * The original stand-in picked the highest-*contribution* candidate via
 * `packages/policy`'s `selectCandidate` (PRD §6.6's merchant objective
 * ordering). On any real cart that is almost always a self-funding
 * `INCREASE_QUANTITY` bundle — i.e. the model answered "give me a discount"
 * with "buy three instead of one", the identical offer every round, until
 * the round cap. A Tier 2 rescue was never reached end to end through
 * `propose`, and the negotiation never visibly moved.
 *
 * This model instead plays a merchant genuinely chasing a deal with a
 * price-sensitive buyer: each round it offers the **lowest-total candidate
 * the engine is exposing** (`pickConcessionCandidate`). While only Tier 1 is
 * available that is a light structural concession; once a Tier 1 refusal has
 * unlocked Tier 2 (RA-2) it becomes the plain discounted cart — a
 * campaign-funded `PRICE_CONCESSION` — and the offer total drops round over
 * round as the concession envelope widens, until the Tier 2 shortfall
 * outgrows the per-deal cap and the engine walks away (PRD §18.2). Same
 * lowest-total rule the demo harness's `DemoMerchantModel`
 * (`packages/agent/demo`) uses; kept as a separate small function here rather
 * than importing that demo code into the transport layer.
 *
 * Still B4-legal (CONTRACTS.md §2): it chooses among an already-generated,
 * already-tiered, already-exposed set and never sees or forwards buyer text.
 */

/**
 * The candidate this stand-in offers, out of the set the caller is exposing
 * this round (already Tier-1-only-until-refusal gated —
 * `selectExposedCandidates` / `selectableCandidates`): the cheapest one, with
 * a deterministic tiebreak on `candidateId` so the choice is reproducible.
 * Throws on an empty array — the caller only invokes a model once at least
 * one candidate is selectable this round.
 */
export function pickConcessionCandidate(candidates: readonly Candidate[]): Candidate {
  if (candidates.length === 0) {
    throw new Error("pickConcessionCandidate: no candidates were exposed for this round");
  }
  return [...candidates].sort(
    (a, b) => a.totalMinor - b.totalMinor || a.candidateId.localeCompare(b.candidateId),
  )[0]!;
}

/** One frame per move type — a deterministic tag, never free text. */
const MOVE_TYPE_MESSAGE_FRAME: Record<CandidateMoveType, MessageFrame> = {
  PRICE_CONCESSION: "FINAL_POSITION",
  ADD_SKU: "BUNDLE_VALUE",
  ADD_SLOW_MOVING_SKU: "SLOW_MOVING_CLEARANCE",
  INCREASE_QUANTITY: "QUANTITY_VALUE",
  COMMITMENT_SWAP: "COMMITMENT_TRADE",
};

export function messageFrameForMoveType(moveType: CandidateMoveType): MessageFrame {
  return MOVE_TYPE_MESSAGE_FRAME[moveType];
}

/**
 * The stand-in merchant model — see module doc. Never reads
 * `input.conversation` (nothing free-form-text to handle) and never emits
 * `terminalAction`. Offers the cheapest exposed candidate each round, so the
 * negotiation actually concedes toward a price-sensitive buyer.
 */
export class DeterministicMerchantModel implements NegotiationModel {
  nextIntent(input: NegotiationRoundInput): NegotiationIntent {
    const chosen = pickConcessionCandidate(input.candidates);
    return { candidateId: chosen.candidateId, messageFrame: messageFrameForMoveType(chosen.moveType) };
  }
}

/**
 * Deterministic candidate identity assignment — TICKET-204's own job per
 * `generation/candidates.ts`'s and `generation/tiering.ts`'s module docs
 * ("assigning candidateId/sessionId/roundIndex is a future orchestration
 * ticket's job"). `generateCandidates`/`assignTiersAndFeasibility` both
 * produce output in a fixed, deterministic order (their own module docs:
 * "same input always produces the identical set in the identical order"),
 * so a plain positional ref (`C1`, `C2`, ...) is itself deterministic and
 * reproducible — never derived from anything a buyer said (B4).
 */
export function assignCandidateIdentity(
  tieredCandidates: readonly TieredCandidate[],
  sessionId: string,
  roundIndex: number,
): Candidate[] {
  return tieredCandidates.map((candidate, index) => ({
    ...candidate,
    candidateId: `C${index + 1}`,
    sessionId,
    roundIndex,
  }));
}

/**
 * A safe, constrained stand-in for TICKET-203's real message composer (see
 * module doc — that ticket owns the actual "constrained template with
 * slots" work and is being built concurrently). Deliberately minimal: one
 * fixed sentence per `MessageFrame`, no interpolation of any field from the
 * offer at all — so there is no way for this function to leak a floor,
 * budget, cap, curve value, or even `totalMinor` formatted into prose
 * (CONTRACTS.md §3: rupee formatting belongs only at the React render
 * boundary, never in an API response). The structured `totalMinor`/`lines`/
 * `commitments` fields on the same response already carry every number the
 * buyer is entitled to see.
 */
const MESSAGE_FRAME_TEXT: Record<MessageFrame, string> = {
  BUNDLE_VALUE: "We've put together a bundle that adds more value to your order.",
  SLOW_MOVING_CLEARANCE: "We can offer extra value if you're open to a couple of additional items.",
  COMMITMENT_TRADE: "We can offer better terms in exchange for a small commitment on your end.",
  QUANTITY_VALUE: "We can offer better value if you add a bit more to your order.",
  FINAL_POSITION: "Here's the best offer we're able to make right now.",
};

export function composeOfferMessage(messageFrame: MessageFrame): string {
  return MESSAGE_FRAME_TEXT[messageFrame];
}

/** Fixed, safe copy for a terminal walk-away — never references a number. */
export const WALK_AWAY_MESSAGE = "We're not able to reach a deal on this basket right now.";
