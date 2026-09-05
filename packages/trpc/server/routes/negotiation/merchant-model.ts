import type { NegotiationModel, NegotiationRoundInput } from "@repo/agent";
import { selectCandidate } from "@repo/policy";
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
 * `ScriptedNegotiationModel` — a fixed-sequence test double, by design (its
 * own module doc: "faithful by construction because the intent carries no
 * numbers"). A real, LLM-backed implementation is not this ticket's job —
 * that is downstream of TICKET-203 (constrained message composition, P1,
 * still TODO, being built by a sibling agent in a separate worktree this
 * ticket must not touch) and the buyer-facing surface still needs SOME
 * implementation to actually drive a negotiation end to end today.
 *
 * `DeterministicMerchantModel` below is that minimal, honest stand-in. It is
 * NOT an attempt to pre-empt TICKET-203's constrained template work — it is
 * intentionally the simplest thing that satisfies `NegotiationModel` without
 * violating any invariant this system cares about:
 *   - It only ever returns a `candidateId` that was in the `candidates` it
 *     was given (`pickBestCandidate` below never invents one).
 *   - `messageFrame` is a pure function of the chosen candidate's
 *     `moveType` — no free text, no numbers, nothing conversation-derived.
 *   - It never selects `terminalAction: "WALK_AWAY"` itself; the caller
 *     (`route.ts`) decides WALK_AWAY paths (round-limit, no-feasible-basket)
 *     before ever invoking a model at all, exactly as CONTRACTS.md §5.1
 *     requires ("no string produced by a model ever becomes a monetary
 *     amount") — this model doesn't get an opportunity to malfunction into
 *     one, because it's given nothing to malfunction with.
 *
 * Lives in `packages/trpc`, not `packages/agent` — the instruction for this
 * ticket is explicit that `packages/agent`'s files are not to be touched
 * while TICKET-203 is in flight there. `packages/trpc` already depends on
 * `@repo/agent` only for its published, frozen `NegotiationModel` interface
 * and `NegotiationRoundInput` type; nothing here reaches into `packages/
 * agent`'s internals.
 */

/**
 * Which candidate this stand-in offers, out of the set the caller is
 * exposing this round (already Tier-1-only-until-refusal gated —
 * `selectExposedCandidates`/`selectableCandidates`). Reuses
 * `packages/policy`'s own `selectCandidate` (TICKET-109, PRD §6.6's stated
 * lexicographic ordering: in-tolerance-band slow-movers first, then highest
 * contribution, then lowest campaign spend, then a content tiebreak) rather
 * than inventing a second, weaker ordering here — `Candidate` is a strict
 * superset of the `TieredCandidate` shape `selectCandidate` reads, so it
 * type-checks directly against the exposed `Candidate[]` this module is
 * handed. Throws on an empty array, matching `selectCandidate`'s own
 * contract — the caller only ever invokes a model once at least one
 * candidate is selectable this round.
 */
export function pickBestCandidate(candidates: readonly Candidate[]): Candidate {
  return selectCandidate(candidates) as Candidate;
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
 * The simplest thing satisfying `NegotiationModel` — see module doc. Never
 * reads `input.conversation` (this stand-in has no free-form-text handling
 * to do, unlike a real model) and never emits `terminalAction`.
 */
export class DeterministicMerchantModel implements NegotiationModel {
  nextIntent(input: NegotiationRoundInput): NegotiationIntent {
    const chosen = pickBestCandidate(input.candidates);
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
