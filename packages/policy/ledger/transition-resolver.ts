import type { NegotiationIntent } from "../contracts/intent";
import type { OfferTier } from "../contracts/negotiation";
import type { ReasonCode } from "../contracts/reason-codes";
import type { NegotiationEvent, NegotiationState, StateTransition, TransitionSource } from "../contracts/state-machine";
import { TRANSITIONS } from "../contracts/state-machine";
import type { EligibilityResult } from "../eligibility/eligibility";
import type { TieredCandidate, TierAssignmentResult } from "../generation/tiering";

/**
 * TICKET-402 — reason code enforcement at every transition (PRD §14, §15;
 * CONTRACTS.md §5.2, §5.3; Settled by Q30, Q34).
 *
 * ============================================================================
 * WHAT'S ALREADY GUARANTEED, AND WHAT THIS MODULE ADDS
 * ============================================================================
 * `contracts/state-machine.ts`'s `StateTransition` type already makes
 * `reasonCode` required, and `TRANSITIONS` is `as const satisfies readonly
 * StateTransition[]` — a transition entry with no code, or with a code
 * outside the closed `ReasonCode` enum, already fails to compile. That half
 * of this ticket's acceptance criteria is a fact about the frozen contract,
 * not something built here.
 *
 * What's missing is a way for a *caller* — the session-orchestration layer
 * no ticket has built yet (the same gap TICKET-104/110/403 all note) — to go
 * from "here is the business decision I just made" to "here is the exact row
 * of `TRANSITIONS` that decision corresponds to" without that caller ever
 * having to know or supply a reason code itself. That is what this module
 * provides: one exported `resolve*Transition` function per logically
 * distinct transition family, each typed over the same decision inputs the
 * rest of `packages/policy` already computes (`EligibilityResult`,
 * `TieredCandidate`, `NegotiationIntent`, plain booleans mirroring a guard's
 * own condition) — never a `reasonCode` or a `StateTransition` itself.
 *
 * ============================================================================
 * THE DESIGN CHOICE THIS TICKET'S TEXT FLAGGED AS GENUINELY AMBIGUOUS
 * ============================================================================
 * `OPEN` + `OFFER_MINTED` has two rows in `TRANSITIONS`, distinguished only
 * by `guard` — a human-readable string, "documentation, never evaluated"
 * (state-machine.ts). A single `resolveTransition(from, event)` lookup
 * cannot disambiguate them mechanically. Two ways to close that gap were
 * considered:
 *
 *  (a) Let the caller also supply the already-decided `reasonCode` (or `to`
 *      state) as a second key. Rejected: the caller would already have to
 *      know the code before calling, which is exactly what "the model
 *      cannot supply a code anywhere" rules out — this would just move the
 *      decision to a less-visible place.
 *  (b) Give each transition FAMILY its own function, typed over the same
 *      inputs the business decision already turns on (a `TieredCandidate`'s
 *      `tier`/`feasible`, `tier1Refused`, an `EligibilityResult`, a plain
 *      `autonomousPaymentExecution` boolean, …), and have the function
 *      itself pick the row. Chosen: the reason code falls OUT of the
 *      decision instead of being asserted by the caller, so there is no
 *      call site anywhere that could pass the wrong one.
 *
 * A few families genuinely share one real-world decision point across what
 * the state machine models as two or three separate events/rows — e.g. an
 * accept attempt is a single fact-finding operation whose outcome is
 * `BASKET_MISMATCH`, `OFFER_ALREADY_CONSUMED` (both `ACCEPT_ATTEMPTED`), or
 * `OFFER_ACCEPTED` (`BUYER_ACCEPTS`); a rail report is a single fact arriving
 * with three possible outcomes. Those are deliberately modelled as ONE
 * resolver function taking a small discriminated/boolean input, rather than
 * three functions a caller would have to choose between (which would
 * reintroduce the "caller picks the row" problem this module exists to
 * remove).
 *
 * ============================================================================
 * HOW EVERY RESOLVER IS BUILT: DERIVE, THEN LOOK UP, NEVER FABRICATE
 * ============================================================================
 * Every exported function below computes a `from`/`event`/`reasonCode`
 * triple from its typed inputs by reproducing the guard prose in code (each
 * function's own doc comment says which guard it implements), then calls the
 * internal {@link lookupTransition}, which does nothing but find that exact
 * row in the frozen `TRANSITIONS` array and throw if it isn't there. No
 * function here ever constructs a `StateTransition` object itself — every
 * return value is a reference to an actual `TRANSITIONS` element, so a typo
 * in this file's own derivation logic fails loudly (a thrown error) instead
 * of silently fabricating a plausible-looking but wrong event.
 *
 * `packages/policy` stays pure (CONTRACTS.md §2, §8): nothing here touches a
 * database or calls `appendAuditEvent` (`packages/database`). A future
 * orchestration layer calls one of these functions to get the
 * `StateTransition` it needs, then passes its `event`/`from`/`to`/
 * `reasonCode` fields on to the ledger writer — this module's whole job ends
 * at "which row," not "write the row."
 */

// ---------------------------------------------------------------------------
// Internal primitive
// ---------------------------------------------------------------------------

/**
 * Finds the one row in the frozen `TRANSITIONS` table matching this exact
 * `from`/`event`/`reasonCode` triple, or throws. `from`+`event`+`reasonCode`
 * is a unique key across the whole table today (no two rows share all
 * three) — verified directly by this module's own test, not merely assumed.
 *
 * Deliberately exported, but NOT part of this module's public decision
 * surface: every `resolve*Transition` function above derives its
 * `reasonCode` from typed business inputs and never accepts one from a
 * caller — each calls this only with a code it already decided. It is
 * exported anyway so TICKET-402's acceptance criterion "a transition not in
 * `TRANSITIONS` fails loudly" can be tested directly, against a fabricated
 * nonsense `from`/`event`/`reasonCode` triple, without contriving a fake
 * business scenario purely to reach this code path through a public
 * resolver.
 */
export function lookupTransition(
  from: TransitionSource,
  event: NegotiationEvent,
  reasonCode: ReasonCode,
): StateTransition {
  const found = TRANSITIONS.find((t) => t.from === from && t.event === event && t.reasonCode === reasonCode);
  if (!found) {
    throw new Error(
      `lookupTransition: no row in TRANSITIONS matches from="${from}", event="${event}", ` +
        `reasonCode="${reasonCode}" — either this combination genuinely does not exist in the frozen ` +
        "state machine (contracts/state-machine.ts), or a resolve*Transition function derived it incorrectly. " +
        "Never treat this as a signal to fall back to some default code.",
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Session & eligibility
// ---------------------------------------------------------------------------

/**
 * `IDLE --ELIGIBILITY_RULES_MATCH--> AT_RISK` (`SESSION_FLAGGED_AT_RISK`).
 * Unconditional — merchant-side rules matching is the only guard, and no
 * buyer input contributes, so there is nothing to branch on.
 */
export function resolveEligibilityFlagTransition(): StateTransition {
  return lookupTransition("IDLE", "ELIGIBILITY_RULES_MATCH", "SESSION_FLAGGED_AT_RISK");
}

/**
 * The `NEGOTIATION_REQUESTED` family (four rows: `NOT_AT_RISK` from `IDLE`;
 * `NEGOTIATION_DISABLED`, `SKU_NOT_NEGOTIABLE`, `NEGOTIATION_OPENED` from
 * `AT_RISK`). Takes `eligibility/eligibility.ts`'s own `checkEligibility`
 * output directly — that function already reproduces the state machine's
 * check order (not-flagged, then kill switch, then SKU negotiability, then
 * eligible) and its four possible reason codes are exactly this family's
 * four rows, so no branching logic is duplicated here.
 *
 * `from` is derived, not supplied: `NOT_AT_RISK` is the only code in this
 * family that ever fires from `IDLE` (the session never became `AT_RISK`);
 * every other code in this family fires from `AT_RISK`.
 */
export function resolveNegotiationRequestedTransition(eligibility: EligibilityResult): StateTransition {
  const from: TransitionSource = eligibility.reasonCode === "NOT_AT_RISK" ? "IDLE" : "AT_RISK";
  return lookupTransition(from, "NEGOTIATION_REQUESTED", eligibility.reasonCode);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * The `CANDIDATES_GENERATED` family (`CANDIDATES_EVALUATED` when the search
 * produced a feasible set, `NO_FEASIBLE_BASKET` when it did not). Takes
 * `generation/tiering.ts`'s own `assignTiersAndFeasibility` output directly
 * — that function's `feasible` discriminant already IS this decision.
 */
export function resolveCandidatesGeneratedTransition(result: TierAssignmentResult): StateTransition {
  if (!result.feasible) {
    return lookupTransition("OPEN", "CANDIDATES_GENERATED", "NO_FEASIBLE_BASKET");
  }
  return lookupTransition("OPEN", "CANDIDATES_GENERATED", "CANDIDATES_EVALUATED");
}

// ---------------------------------------------------------------------------
// Minting & tiering
// ---------------------------------------------------------------------------

/**
 * The `OFFER_MINTED` family (`TIER1_OFFERED` for a self-funding candidate;
 * `DILUTION_WITHIN_CAPS` for a tier 2 candidate once both caps are satisfied,
 * `tier1Refused` is true, and the RA-3 eligibility re-check still passes).
 *
 * Tier 1 needs nothing beyond `candidate.tier === 1` — it is always
 * self-funding and always feasible by construction (`tiering.ts`). Tier 2
 * additionally requires the two guard conditions this function's signature
 * makes explicit rather than folding into `TieredCandidate` itself, since
 * neither `tier1Refused` nor the RA-3 re-check outcome is a property of one
 * candidate — they are session-level facts a future orchestration layer
 * supplies. Throws rather than guessing if a tier 2 mint is attempted before
 * its guards are satisfied — minting an unselectable candidate is a caller
 * bug this function must not paper over.
 *
 * `tier`, `feasible`, and `infeasibleReason` are independently typed fields
 * on `TieredCandidate` (`contracts/negotiation.ts`'s `candidateSchema`) —
 * nothing at the type level ties them together, only `markCandidate`'s
 * construction discipline (`generation/tiering.ts`) does. So a tier 1
 * candidate is re-checked against that invariant here rather than trusted:
 * one that arrived with `feasible: false` is malformed and must not be
 * classified as a successful `TIER1_OFFERED` mint.
 */
export function resolveOfferMintedTransition(
  candidate: TieredCandidate,
  tier1Refused: boolean,
  sessionStillEligible: boolean,
): StateTransition {
  if (candidate.tier === 1) {
    if (!candidate.feasible || candidate.infeasibleReason !== null) {
      throw new Error(
        "resolveOfferMintedTransition: candidate is tier 1 but feasible/infeasibleReason contradict " +
          "that — a tier 1 candidate is always feasible by construction (generation/tiering.ts), so this " +
          "candidate is malformed",
      );
    }
    return lookupTransition("OPEN", "OFFER_MINTED", "TIER1_OFFERED");
  }
  if (!candidate.feasible) {
    throw new Error(
      "resolveOfferMintedTransition: candidate is tier 2 but infeasible — an infeasible tier 2 " +
        "candidate is a MINT_ATTEMPTED outcome (resolveMintAttemptedTransition), never an OFFER_MINTED one",
    );
  }
  if (!tier1Refused) {
    throw new Error(
      "resolveOfferMintedTransition: a tier 2 candidate cannot be minted before tier1Refused is " +
        "true (RA-2) — it is locked out of selectableCandidates until then",
    );
  }
  if (!sessionStillEligible) {
    throw new Error(
      "resolveOfferMintedTransition: the RA-3 eligibility re-check failed — a tier 2 mint must not proceed",
    );
  }
  return lookupTransition("OPEN", "OFFER_MINTED", "DILUTION_WITHIN_CAPS");
}

/**
 * The `MINT_ATTEMPTED` family (`DILUTION_EXCEEDS_PER_DEAL_CAP`,
 * `CAMPAIGN_BUDGET_EXHAUSTED`) — fires when a tier 2 mint is attempted
 * against a candidate that `tiering.ts` already marked infeasible.
 * `candidate.infeasibleReason` already carries the exact distinguishing
 * code (`markCandidate` sets it to whichever cap failed first), so this
 * function's whole job is validating that the candidate is actually in this
 * family before trusting that field, not re-deriving the cap arithmetic.
 *
 * Also requires `candidate.tier === 2`: a tier 1 candidate is always
 * feasible by construction (`generation/tiering.ts`), so `tier === 1` with
 * `feasible: false` is a malformed candidate, not a MINT_ATTEMPTED outcome —
 * `tier`, `feasible`, and `infeasibleReason` are independently typed fields
 * on `TieredCandidate`, so nothing else rules that combination out.
 */
export function resolveMintAttemptedTransition(candidate: TieredCandidate): StateTransition {
  if (candidate.feasible) {
    throw new Error(
      "resolveMintAttemptedTransition: candidate is feasible — mint it via " +
        "resolveOfferMintedTransition instead of treating it as a failed mint attempt",
    );
  }
  if (candidate.tier !== 2) {
    throw new Error(
      "resolveMintAttemptedTransition: candidate is tier 1 but infeasible — a tier 1 candidate is " +
        "always feasible by construction (generation/tiering.ts), so this candidate is malformed",
    );
  }
  const { infeasibleReason } = candidate;
  if (infeasibleReason !== "DILUTION_EXCEEDS_PER_DEAL_CAP" && infeasibleReason !== "CAMPAIGN_BUDGET_EXHAUSTED") {
    throw new Error(
      `resolveMintAttemptedTransition: infeasibleReason "${String(infeasibleReason)}" is not a ` +
        "MINT_ATTEMPTED outcome — only DILUTION_EXCEEDS_PER_DEAL_CAP and CAMPAIGN_BUDGET_EXHAUSTED are",
    );
  }
  return lookupTransition("OPEN", "MINT_ATTEMPTED", infeasibleReason);
}

/**
 * `OPEN --ROUND_INCREMENTED--> WALKED_AWAY` (`ROUND_LIMIT_REACHED`), guarded
 * by `roundIndex > maxRounds`. Both are plain numbers a session and its
 * merchant policy already carry — `NegotiationSession.roundIndex`,
 * `MerchantPolicy.maxRounds` — so this function reproduces the guard
 * literally rather than introducing a new derived type for it.
 */
export function resolveRoundIncrementedTransition(roundIndex: number, maxRounds: number): StateTransition {
  if (!(roundIndex > maxRounds)) {
    throw new Error(
      `resolveRoundIncrementedTransition: roundIndex (${roundIndex}) does not exceed maxRounds ` +
        `(${maxRounds}) — ROUND_LIMIT_REACHED is the only ROUND_INCREMENTED transition, and it only ` +
        "fires once the round envelope is exhausted",
    );
  }
  return lookupTransition("OPEN", "ROUND_INCREMENTED", "ROUND_LIMIT_REACHED");
}

/**
 * `OPEN --AGENT_TERMINAL_INTENT--> WALKED_AWAY` (`WALK_AWAY`), guarded by
 * `intent.terminalAction === "WALK_AWAY"`. Takes the frozen
 * `NegotiationIntent` directly — `WALK_AWAY` is the only terminal action the
 * model may ever select (CONTRACTS.md §5.1), so this is the one place that
 * fact turns into a transition.
 */
export function resolveAgentTerminalIntentTransition(intent: NegotiationIntent): StateTransition {
  if (intent.terminalAction !== "WALK_AWAY") {
    throw new Error(
      "resolveAgentTerminalIntentTransition: intent.terminalAction is not WALK_AWAY — this is the " +
        "only terminal action AGENT_TERMINAL_INTENT models",
    );
  }
  return lookupTransition("OPEN", "AGENT_TERMINAL_INTENT", "WALK_AWAY");
}

// ---------------------------------------------------------------------------
// Offer pending
// ---------------------------------------------------------------------------

/**
 * `OFFER_PENDING --BUDGET_RESERVED--> OFFER_PENDING` (`HOLD_RESERVED`),
 * guarded by "tier 2 only". Takes the minted offer's `tier` directly
 * (`OfferTier`, frozen in `contracts/negotiation.ts`).
 */
export function resolveBudgetReservedTransition(tier: OfferTier): StateTransition {
  if (tier !== 2) {
    throw new Error("resolveBudgetReservedTransition: BUDGET_RESERVED only fires for a tier 2 offer");
  }
  return lookupTransition("OFFER_PENDING", "BUDGET_RESERVED", "HOLD_RESERVED");
}

/**
 * The `BUYER_DECLINES` family (`TIER1_REFUSED_BY_BUYER` when the declined
 * offer was tier 1 — one refusal unlocks tier 2, RA-2; `HOLD_RELEASED` when
 * it was tier 2). Both rows move `OFFER_PENDING -> OPEN`; only the reason
 * code distinguishes them, and `tier` is exactly the fact that decides it.
 */
export function resolveBuyerDeclinesTransition(tier: OfferTier): StateTransition {
  const reasonCode: Extract<ReasonCode, "TIER1_REFUSED_BY_BUYER" | "HOLD_RELEASED"> =
    tier === 1 ? "TIER1_REFUSED_BY_BUYER" : "HOLD_RELEASED";
  return lookupTransition("OFFER_PENDING", "BUYER_DECLINES", reasonCode);
}

/**
 * `OFFER_PENDING --TTL_ELAPSED--> EXPIRED` (`OFFER_EXPIRED`), guarded by
 * `now > expiresAt`. Takes both timestamps rather than a pre-computed
 * boolean so the comparison itself lives in one place, not duplicated at
 * every call site.
 */
export function resolveTtlElapsedTransition(now: Date, expiresAt: Date): StateTransition {
  if (!(now.getTime() > expiresAt.getTime())) {
    throw new Error("resolveTtlElapsedTransition: now is not after expiresAt — the offer TTL has not elapsed");
  }
  return lookupTransition("OFFER_PENDING", "TTL_ELAPSED", "OFFER_EXPIRED");
}

/**
 * `OFFER_PENDING --BUYER_ENDS_SESSION--> DECLINED` (`BUYER_DECLINED`).
 * Unconditional — this event exists precisely to distinguish a buyer-terminal
 * ending from the agent's own `WALK_AWAY`, and carries no further guard.
 */
export function resolveBuyerEndsSessionTransition(): StateTransition {
  return lookupTransition("OFFER_PENDING", "BUYER_ENDS_SESSION", "BUYER_DECLINED");
}

/**
 * The facts a buyer's accept attempt needs checked, in the priority order
 * PRD §10.2 lists offer refusals ("expired", "already consumed", "basket
 * mismatch"): expiry is handled upstream by
 * {@link resolveTtlElapsedTransition} on a separate event, so this function
 * assumes the caller has already confirmed the offer is unexpired before
 * reaching it, and checks single-use before basket equality.
 */
export type OfferAcceptCheck = {
  /** `offer.consumedAt !== null` — single-use is enforced on this field (PRD §10). */
  alreadyConsumed: boolean;
  /** The accepted basket equals the offer's minted basket exactly (PRD §10.1). */
  basketMatches: boolean;
};

/**
 * The `ACCEPT_ATTEMPTED` / `BUYER_ACCEPTS` family, modelled as one function
 * because a buyer's single accept attempt has exactly one of three outcomes
 * — `OFFER_ALREADY_CONSUMED`, `BASKET_MISMATCH` (both `ACCEPT_ATTEMPTED`,
 * self-loop on `OFFER_PENDING`), or `OFFER_ACCEPTED` (`BUYER_ACCEPTS`, moves
 * to `ACCEPTED`) — rather than three functions a caller would have to choose
 * between, which would reintroduce the "caller picks the row" problem this
 * module exists to remove.
 */
export function resolveOfferAcceptTransition(check: OfferAcceptCheck): StateTransition {
  if (check.alreadyConsumed) {
    return lookupTransition("OFFER_PENDING", "ACCEPT_ATTEMPTED", "OFFER_ALREADY_CONSUMED");
  }
  if (!check.basketMatches) {
    return lookupTransition("OFFER_PENDING", "ACCEPT_ATTEMPTED", "BASKET_MISMATCH");
  }
  return lookupTransition("OFFER_PENDING", "BUYER_ACCEPTS", "OFFER_ACCEPTED");
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * The `TERMINAL_ACTION` / `ORDER_CREATED` family — one real decision point
 * (what happens right after offer acceptance) with two possible outcomes
 * gated by `MerchantPolicy.autonomousPaymentExecution` (CONTRACTS.md §9.2,
 * §9.3): `true` fails closed with `AUTONOMOUS_PAYMENT_NOT_AUTHORIZED`
 * (`TERMINAL_ACTION`, self-loop on `ACCEPTED`), the MVP default `false`
 * proceeds to `ORDER_CREATED` (`AWAITING_PAYMENT`).
 */
export function resolvePaymentInitiationTransition(autonomousPaymentExecution: boolean): StateTransition {
  if (autonomousPaymentExecution) {
    return lookupTransition("ACCEPTED", "TERMINAL_ACTION", "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED");
  }
  return lookupTransition("ACCEPTED", "ORDER_CREATED", "ORDER_CREATED");
}

/** The three ways `RailStateSource` (PRD §12) can report back on a created order. */
export type RailReportOutcome = "CAPTURED" | "FAILED" | "CONTRADICTS_LOCAL";

/**
 * The `RAIL_REPORTS_CAPTURED` / `RAIL_REPORTS_FAILED` / `RAIL_CONTRADICTS_LOCAL`
 * family — one real decision point (the rail's report on an order) with
 * three possible outcomes, mirroring PRD §12's one-directional reconciliation:
 * the rail's state always wins, and a divergence from local belief is its
 * own reason code (`RAIL_STATE_DIVERGENCE`) recorded before any correction.
 */
export function resolveRailReportTransition(outcome: RailReportOutcome): StateTransition {
  switch (outcome) {
    case "CAPTURED":
      return lookupTransition("AWAITING_PAYMENT", "RAIL_REPORTS_CAPTURED", "PAYMENT_CAPTURED");
    case "FAILED":
      return lookupTransition("AWAITING_PAYMENT", "RAIL_REPORTS_FAILED", "PAYMENT_FAILED");
    case "CONTRADICTS_LOCAL":
      return lookupTransition("AWAITING_PAYMENT", "RAIL_CONTRADICTS_LOCAL", "RAIL_STATE_DIVERGENCE");
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`resolveRailReportTransition: unhandled outcome "${String(exhaustiveCheck)}"`);
    }
  }
}

/**
 * `SETTLED --HOLD_COMMITTED--> SETTLED`, guarded by "tier 2 only". Takes the
 * settled offer's `tier` directly, same discipline as
 * {@link resolveBudgetReservedTransition}.
 */
export function resolveHoldCommittedTransition(tier: OfferTier): StateTransition {
  if (tier !== 2) {
    throw new Error("resolveHoldCommittedTransition: HOLD_COMMITTED only fires for a tier 2 offer");
  }
  return lookupTransition("SETTLED", "HOLD_COMMITTED", "HOLD_COMMITTED");
}

// ---------------------------------------------------------------------------
// Hold unwinding
// ---------------------------------------------------------------------------

/**
 * The `HOLD_RELEASED` self-loop family fired from a terminal-ish state after
 * that state was already reached by a separate, session-level transition —
 * `EXPIRED --HOLD_RELEASED--> EXPIRED` and `PAYMENT_FAILED --HOLD_RELEASED-->
 * PAYMENT_FAILED` — as opposed to the third `HOLD_RELEASED` row, which fires
 * on `BUYER_DECLINES` from `OFFER_PENDING` and is
 * {@link resolveBuyerDeclinesTransition}'s job, not this one's. Guarded by
 * "tier 2 only", same as every other hold transition. `fromState` picks
 * which of the two self-loops applies — there is no way to derive it from
 * `tier` alone, since both rows share it.
 */
export function resolveHoldReleaseTransition(
  fromState: Extract<NegotiationState, "EXPIRED" | "PAYMENT_FAILED">,
  tier: OfferTier,
): StateTransition {
  if (tier !== 2) {
    throw new Error("resolveHoldReleaseTransition: HOLD_RELEASED only fires for a tier 2 offer");
  }
  return lookupTransition(fromState, "HOLD_RELEASED", "HOLD_RELEASED");
}

// ---------------------------------------------------------------------------
// Defensive
// ---------------------------------------------------------------------------

/**
 * `* --SUB_FLOOR_CANDIDATE_DETECTED--> HALTED` (`FLOOR_BREACH`). The one
 * exception to "reachable via a real business-decision path": this is the
 * defensive assertion itself (PRD §14, CONTRACTS.md §5.2) — unreachable in
 * correct operation because the generator never constructs a sub-floor
 * candidate (`generation/candidates.ts`'s own `pushCandidate` re-asserts this
 * on every candidate it builds). No other function in this module ever
 * returns `FLOOR_BREACH`; this is its only call path, exercised by whatever
 * defense-in-depth check detects a sub-floor candidate slipping through.
 */
export function resolveFloorBreachTransition(): StateTransition {
  return lookupTransition("*", "SUB_FLOOR_CANDIDATE_DETECTED", "FLOOR_BREACH");
}
