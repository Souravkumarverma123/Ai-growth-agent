import {
  mintOffer,
  type Candidate,
  type CampaignBudgetReservationOutcome,
  type NegotiationIntent,
  type Offer,
  type ReasonCode,
} from "@repo/policy";
import type { ConversationTurn, NegotiationModel } from "./model";
import { composeOfferMessage } from "./message";

/**
 * TICKET-202 — merchant agent orchestration loop (PRD §7, §7.1, §16 RA-2;
 * CONTRACTS.md §2, §5.1, §8). "Context in, intent out, offer minted, round
 * advanced."
 *
 * ============================================================================
 * WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY ISN'T
 * ============================================================================
 * This is the wiring between the three seams that already exist:
 *  - `NegotiationModel` (TICKET-201) — the model's entire output surface.
 *  - `mintOffer` (TICKET-110) — the engine's only entry point, re-exported
 *    from `@repo/policy`. B2 (CONTRACTS.md §2): this is the ONLY policy
 *    write-adjacent call this package makes; there is no `@repo/database` or
 *    `@repo/payments` import here (lint-enforced, `eslint.config.mjs`).
 *  - The tier1_refused lock (TICKET-104's `assignTiersAndFeasibility`,
 *    RA-2) — this module does not re-tier candidates (that needs a live
 *    campaign budget figure this package cannot fetch, B2); it reads the
 *    already-tiered, already-feasibility-checked `Candidate[]` a
 *    database-backed caller hands it, and applies the SAME "Tier 1, or Tier 2
 *    only once refused" exposure rule tiering.ts's own `selectableCandidates`
 *    already encodes, at the exposure boundary this ticket owns.
 *
 * `tier1Refused` is the session-state field TICKET-104's own module doc
 * anticipated a future orchestration ticket to introduce
 * ("generation/tiering.ts" — "a future orchestration ticket is responsible
 * for reading them from the database/session and passing them in"). It lives
 * here, on {@link RoundState}, because this package is where "session/round
 * state" as seen by the negotiation loop is first modeled — `packages/agent`
 * has no database table of its own (B2); a real caller persists this
 * alongside `NegotiationSession.tier1Refused`
 * (`packages/policy/contracts/negotiation.ts`), which this type mirrors.
 *
 * `roundIndex` on {@link RoundState} is 1-based, matching
 * `NegotiationRoundInput.roundIndex` ("1-based model round") and
 * `Candidate.roundIndex` / `Offer.roundIndex` (`z.number().int().positive()`)
 * — NOT the persisted, 0-based `NegotiationSession.roundIndex`. Translating
 * between the two is a future caller's job (the same seam
 * `negotiation-model.ts`'s own doc already calls out), not this module's.
 */

// ---------------------------------------------------------------------------
// Round state — new to this package (see module doc)
// ---------------------------------------------------------------------------

/** The two pieces of session state this loop reads and advances each round. */
export type RoundState = {
  /** 1-based; see module doc for the mapping to the persisted, 0-based field. */
  readonly roundIndex: number;
  /**
   * Set by ONE refusal of the engine's best Tier 1 candidate (RA-2). Tier 2
   * stays locked out of {@link selectExposedCandidates} until this is true.
   */
  readonly tier1Refused: boolean;
};

/** The starting state for a brand-new negotiation session. */
export const INITIAL_ROUND_STATE: RoundState = { roundIndex: 1, tier1Refused: false };

// ---------------------------------------------------------------------------
// Exposure — "Fetch unlocked candidates for the round"
// ---------------------------------------------------------------------------

/**
 * The candidate set a model may actually be shown this round: feasible Tier 1
 * candidates, plus feasible Tier 2 candidates but ONLY once `tier1Refused` is
 * true. Deliberately the same rule `generation/tiering.ts`'s own
 * `selectableCandidates` encodes (RA-2) — this function exists because that
 * one operates on a live campaign-budget figure this package cannot fetch
 * (B2), so this package re-applies the identical exposure rule to the
 * already-tiered `Candidate[]` a caller hands it.
 *
 * This is the acceptance criterion "Round 1 exposes only Tier 1 candidates to
 * the model" made concrete: with `tier1Refused: false`, no Tier 2 candidate —
 * however feasible — passes this filter, so `NegotiationModel.nextIntent`
 * never even sees one to choose from.
 */
export function selectExposedCandidates(
  candidatesInRound: readonly Candidate[],
  tier1Refused: boolean,
): Candidate[] {
  return candidatesInRound.filter((candidate) => {
    if (!candidate.feasible) return false;
    if (candidate.tier === 1) return true;
    return tier1Refused;
  });
}

// ---------------------------------------------------------------------------
// Refusal — "A Tier 1 refusal sets tier1_refused"
// ---------------------------------------------------------------------------

/**
 * Applies a buyer's decline of a minted offer to this session's round state.
 * Only a refusal of a TIER 1 offer flips the lock (RA-2: "one refusal of
 * [the engine's best Tier 1 candidate] sets tier1Refused") — declining a
 * Tier 2 offer (already only reachable after the lock is open) leaves the
 * state untouched, and a state that already has `tier1Refused: true` stays
 * `true` either way, matching `TIER1_REFUSED_BY_BUYER`'s state-machine
 * transition (`OFFER_PENDING --BUYER_DECLINES--> OPEN`,
 * `contracts/state-machine.ts`) being the ONLY row that mentions the lock.
 *
 * Pure state transformation — recording the actual `BUYER_DECLINES` ledger
 * event is a database-backed caller's job (this package cannot write,
 * B2); this function only computes what the next round's exposure should be.
 */
export function applyOfferDeclined(state: RoundState, declinedOffer: Pick<Offer, "tier">): RoundState {
  if (declinedOffer.tier !== 1) return state;
  if (state.tier1Refused) return state;
  return { ...state, tier1Refused: true };
}

// ---------------------------------------------------------------------------
// The round loop — "call the model, pass the intent to mint, advance the
// round, handle terminal conditions including WALK_AWAY"
// ---------------------------------------------------------------------------

export type RunNegotiationRoundInput = {
  readonly sessionId: string;
  readonly state: RoundState;
  /** Pinned at session open (`NegotiationSession.policyVersion`). */
  readonly policyVersion: number;
  /**
   * Every engine-authored candidate for this round — the WHOLE tiered set,
   * not just what {@link selectExposedCandidates} would return. Passed
   * straight through to `mintOffer`, which needs the full set to resolve the
   * model's chosen `candidateId` and to reject a forged or out-of-set one.
   */
  readonly candidatesInRound: readonly Candidate[];
  /** Buyer + agent transcript so far. Empty on the first round. */
  readonly conversation: readonly ConversationTurn[];
  readonly model: NegotiationModel;
  /** Mint time; see `mintOffer`'s own doc for why this is a plain input. */
  readonly now: Date;
  /** `MerchantPolicy.offerTtlSeconds`. */
  readonly offerTtlSeconds: number;
  /** Required only when the model's chosen candidate resolves to Tier 2. */
  readonly campaignBudgetReservation?: CampaignBudgetReservationOutcome;
  readonly signingSecret?: string;
};

export type RunNegotiationRoundResult =
  | {
      readonly status: "OFFER_MINTED";
      readonly intent: NegotiationIntent;
      readonly offer: Offer;
      /** The buyer-facing text for this offer — always produced by
       *  `composeOfferMessage` (TICKET-203) from `offer` and
       *  `intent.messageFrame`, never any other path (CONTRACTS.md §9: no
       *  free-form claim about this offer reaches the buyer surface). */
      readonly message: string;
      /** roundIndex advanced by one; tier1Refused carried through unchanged. */
      readonly nextState: RoundState;
    }
  | {
      readonly status: "WALKED_AWAY";
      readonly intent: NegotiationIntent;
      /** Always `"WALK_AWAY"` — the state machine's own
       *  `AGENT_TERMINAL_INTENT -> WALKED_AWAY` reason code. */
      readonly reasonCode: Extract<ReasonCode, "WALK_AWAY">;
      /** Terminal: state does not advance past a walk-away. */
      readonly nextState: RoundState;
    }
  | {
      readonly status: "MINT_REJECTED";
      readonly intent: NegotiationIntent;
      /** `DILUTION_EXCEEDS_PER_DEAL_CAP` or `CAMPAIGN_BUDGET_EXHAUSTED` — both
       *  map onto the state machine's own `MINT_ATTEMPTED -> WALKED_AWAY`
       *  rows (`contracts/state-machine.ts`); also terminal. */
      readonly reasonCode: ReasonCode;
      readonly nextState: RoundState;
    };

/**
 * Runs exactly one round of the negotiation loop:
 *
 * 1. Fetches this round's unlocked candidates ({@link selectExposedCandidates}).
 * 2. Calls the model with them plus the transcript so far.
 * 3. If the model's intent carries `terminalAction: "WALK_AWAY"`, terminates
 *    cleanly with that code — never reaches `mintOffer` at all.
 * 4. Otherwise passes the intent's `candidateId` to `mintOffer` against the
 *    FULL `candidatesInRound` (never the exposed subset — see that
 *    function's own doc on why).
 * 5. On a successful mint, composes the buyer-facing `message` via
 *    `composeOfferMessage` (TICKET-203) from the minted `offer` and
 *    `intent.messageFrame` — the ONLY path an `OFFER_MINTED` result's text
 *    can come from — and advances the round (`roundIndex + 1`); on a
 *    terminal outcome (walk-away, or a coded mint rejection), the state does
 *    not advance — there is no next round to advance into.
 */
export async function runNegotiationRound(
  input: RunNegotiationRoundInput,
): Promise<RunNegotiationRoundResult> {
  const {
    sessionId,
    state,
    policyVersion,
    candidatesInRound,
    conversation,
    model,
    now,
    offerTtlSeconds,
    campaignBudgetReservation,
    signingSecret,
  } = input;

  const exposedCandidates = selectExposedCandidates(candidatesInRound, state.tier1Refused);

  const intent = await model.nextIntent({
    sessionId,
    roundIndex: state.roundIndex,
    candidates: exposedCandidates,
    conversation,
  });

  if (intent.terminalAction === "WALK_AWAY") {
    return { status: "WALKED_AWAY", intent, reasonCode: "WALK_AWAY", nextState: state };
  }

  const mintResult = mintOffer({
    sessionId,
    roundIndex: state.roundIndex,
    policyVersion,
    tier1Refused: state.tier1Refused,
    candidatesInRound,
    candidateId: intent.candidateId,
    campaignBudgetReservation,
    now,
    offerTtlSeconds,
    signingSecret,
  });

  if (!mintResult.minted) {
    return { status: "MINT_REJECTED", intent, reasonCode: mintResult.reasonCode, nextState: state };
  }

  return {
    status: "OFFER_MINTED",
    intent,
    offer: mintResult.offer,
    message: composeOfferMessage({ offer: mintResult.offer, messageFrame: intent.messageFrame }),
    nextState: { roundIndex: state.roundIndex + 1, tier1Refused: state.tier1Refused },
  };
}
