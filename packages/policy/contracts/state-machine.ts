import { z } from "zod";
import type { ReasonCode } from "./reason-codes";

/**
 * FROZEN CONTRACT — PRD.md §15, CONTRACTS.md §5.3.
 *
 * One negotiation session. Every transition writes exactly one ledger event
 * carrying exactly one reason code — `reasonCode` is a required field on
 * StateTransition, so a transition written without one does not compile.
 *
 * Session attributes roundIndex, tier1Refused and policyVersion travel
 * alongside the state; they are on the session row, not encoded in the state.
 */
export const NEGOTIATION_STATES = [
  "IDLE",
  "AT_RISK",
  "OPEN",
  "OFFER_PENDING",
  "ACCEPTED",
  "AWAITING_PAYMENT",
  "SETTLED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "WALKED_AWAY",
  "DECLINED",
  "HALTED",
] as const;

export type NegotiationState = (typeof NEGOTIATION_STATES)[number];
export const negotiationStateSchema = z.enum(NEGOTIATION_STATES);

/** Once entered, a session never leaves these. */
export const TERMINAL_STATES = [
  "SETTLED",
  "PAYMENT_FAILED",
  "EXPIRED",
  "WALKED_AWAY",
  "DECLINED",
  "HALTED",
] as const satisfies readonly NegotiationState[];

export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: NegotiationState): state is TerminalState {
  return (TERMINAL_STATES as readonly NegotiationState[]).includes(state);
}

export const NEGOTIATION_EVENTS = [
  "ELIGIBILITY_RULES_MATCH",
  "NEGOTIATION_REQUESTED",
  "CANDIDATES_GENERATED",
  "OFFER_MINTED",
  "MINT_ATTEMPTED",
  "ROUND_INCREMENTED",
  "AGENT_TERMINAL_INTENT",
  "BUDGET_RESERVED",
  "BUYER_DECLINES",
  "TTL_ELAPSED",
  "BUYER_ENDS_SESSION",
  "ACCEPT_ATTEMPTED",
  "BUYER_ACCEPTS",
  "TERMINAL_ACTION",
  "ORDER_CREATED",
  "RAIL_REPORTS_CAPTURED",
  "RAIL_REPORTS_FAILED",
  "RAIL_CONTRADICTS_LOCAL",
  "HOLD_COMMITTED",
  "HOLD_RELEASED",
  "SUB_FLOOR_CANDIDATE_DETECTED",
] as const;

export type NegotiationEvent = (typeof NEGOTIATION_EVENTS)[number];
export const negotiationEventSchema = z.enum(NEGOTIATION_EVENTS);

/**
 * `from: "*"` marks the defensive assertion, which is reachable from any state
 * because it exists to catch a bug rather than to model a behaviour.
 */
export type TransitionSource = NegotiationState | "*";

export type StateTransition = {
  readonly from: TransitionSource;
  readonly event: NegotiationEvent;
  /** Human-readable condition. Documentation, never evaluated. */
  readonly guard: string;
  readonly to: NegotiationState;
  /** Required. A transition with no reason code does not compile. */
  readonly reasonCode: ReasonCode;
};

/**
 * The complete transition table. This is the whole state machine — no other
 * transition exists, and none may be added without lead approval
 * (CONTRACTS.md §1).
 */
export const TRANSITIONS = [
  // --- Session & eligibility -------------------------------------------------
  {
    from: "IDLE",
    event: "ELIGIBILITY_RULES_MATCH",
    guard: "merchant-side rules match; no buyer input contributes",
    to: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
  },
  {
    from: "IDLE",
    event: "NEGOTIATION_REQUESTED",
    guard: "session not flagged at risk",
    to: "IDLE",
    reasonCode: "NOT_AT_RISK",
  },
  {
    from: "AT_RISK",
    event: "NEGOTIATION_REQUESTED",
    guard: "kill switch on (negotiationEnabled === false)",
    to: "HALTED",
    reasonCode: "NEGOTIATION_DISABLED",
  },
  {
    from: "AT_RISK",
    event: "NEGOTIATION_REQUESTED",
    guard: "cart contains no negotiable SKU",
    to: "WALKED_AWAY",
    reasonCode: "SKU_NOT_NEGOTIABLE",
  },
  {
    from: "AT_RISK",
    event: "NEGOTIATION_REQUESTED",
    guard: "eligible",
    to: "OPEN",
    reasonCode: "NEGOTIATION_OPENED",
  },

  // --- Generation ------------------------------------------------------------
  {
    from: "OPEN",
    event: "CANDIDATES_GENERATED",
    guard: "always; records evaluated/feasible/tier-1 counts",
    to: "OPEN",
    reasonCode: "CANDIDATES_EVALUATED",
  },
  {
    from: "OPEN",
    event: "CANDIDATES_GENERATED",
    guard: "feasible set empty",
    to: "WALKED_AWAY",
    reasonCode: "NO_FEASIBLE_BASKET",
  },

  // --- Minting & tiering -----------------------------------------------------
  {
    from: "OPEN",
    event: "OFFER_MINTED",
    guard: "candidate is tier 1 (self-funding)",
    to: "OFFER_PENDING",
    reasonCode: "TIER1_OFFERED",
  },
  {
    from: "OPEN",
    event: "OFFER_MINTED",
    guard: "tier 2, both caps satisfied, tier1Refused, session still eligible (RA-3)",
    to: "OFFER_PENDING",
    reasonCode: "DILUTION_WITHIN_CAPS",
  },
  {
    from: "OPEN",
    event: "MINT_ATTEMPTED",
    guard: "shortfall > perDealCap",
    to: "WALKED_AWAY",
    reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
  },
  {
    from: "OPEN",
    event: "MINT_ATTEMPTED",
    guard: "shortfall > available campaign budget",
    to: "WALKED_AWAY",
    reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED",
  },
  {
    from: "OPEN",
    event: "ROUND_INCREMENTED",
    guard: "roundIndex > maxRounds",
    to: "WALKED_AWAY",
    reasonCode: "ROUND_LIMIT_REACHED",
  },
  {
    from: "OPEN",
    event: "AGENT_TERMINAL_INTENT",
    guard: "intent.terminalAction === WALK_AWAY",
    to: "WALKED_AWAY",
    reasonCode: "WALK_AWAY",
  },

  // --- Offer pending ---------------------------------------------------------
  {
    from: "OFFER_PENDING",
    event: "BUDGET_RESERVED",
    guard: "tier 2 only",
    to: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
  },
  {
    from: "OFFER_PENDING",
    event: "BUYER_DECLINES",
    guard: "offer was tier 1 — one refusal unlocks tier 2 (RA-2)",
    to: "OPEN",
    reasonCode: "TIER1_REFUSED_BY_BUYER",
  },
  {
    from: "OFFER_PENDING",
    event: "BUYER_DECLINES",
    guard: "offer was tier 2",
    to: "OPEN",
    reasonCode: "HOLD_RELEASED",
  },
  {
    from: "OFFER_PENDING",
    event: "TTL_ELAPSED",
    guard: "now > expiresAt",
    to: "EXPIRED",
    reasonCode: "OFFER_EXPIRED",
  },
  {
    from: "OFFER_PENDING",
    event: "BUYER_ENDS_SESSION",
    guard: "buyer terminal, distinct from agent walk-away",
    to: "DECLINED",
    reasonCode: "BUYER_DECLINED",
  },
  {
    from: "OFFER_PENDING",
    event: "ACCEPT_ATTEMPTED",
    guard: "accepted basket differs from minted basket",
    to: "OFFER_PENDING",
    reasonCode: "BASKET_MISMATCH",
  },
  {
    from: "OFFER_PENDING",
    event: "ACCEPT_ATTEMPTED",
    guard: "consumedAt already set",
    to: "OFFER_PENDING",
    reasonCode: "OFFER_ALREADY_CONSUMED",
  },
  {
    from: "OFFER_PENDING",
    event: "BUYER_ACCEPTS",
    guard: "valid, unexpired, unconsumed, basket matches",
    to: "ACCEPTED",
    reasonCode: "OFFER_ACCEPTED",
  },

  // --- Payment ---------------------------------------------------------------
  {
    from: "ACCEPTED",
    event: "TERMINAL_ACTION",
    guard: "autonomousPaymentExecution === true — fails closed, not implemented",
    to: "ACCEPTED",
    reasonCode: "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED",
  },
  {
    from: "ACCEPTED",
    event: "ORDER_CREATED",
    guard: "autonomousPaymentExecution === false (MVP default)",
    to: "AWAITING_PAYMENT",
    reasonCode: "ORDER_CREATED",
  },
  {
    from: "AWAITING_PAYMENT",
    event: "RAIL_REPORTS_CAPTURED",
    guard: "rail state is authoritative",
    to: "SETTLED",
    reasonCode: "PAYMENT_CAPTURED",
  },
  {
    from: "SETTLED",
    event: "HOLD_COMMITTED",
    guard: "tier 2 only",
    to: "SETTLED",
    reasonCode: "HOLD_COMMITTED",
  },
  {
    from: "AWAITING_PAYMENT",
    event: "RAIL_REPORTS_FAILED",
    guard: "rail state is authoritative",
    to: "PAYMENT_FAILED",
    reasonCode: "PAYMENT_FAILED",
  },
  {
    from: "AWAITING_PAYMENT",
    event: "RAIL_CONTRADICTS_LOCAL",
    guard: "divergence is recorded BEFORE the correction is applied",
    to: "PAYMENT_FAILED",
    reasonCode: "RAIL_STATE_DIVERGENCE",
  },

  // --- Hold unwinding --------------------------------------------------------
  {
    from: "EXPIRED",
    event: "HOLD_RELEASED",
    guard: "tier 2 only",
    to: "EXPIRED",
    reasonCode: "HOLD_RELEASED",
  },
  {
    from: "PAYMENT_FAILED",
    event: "HOLD_RELEASED",
    guard: "tier 2 only",
    to: "PAYMENT_FAILED",
    reasonCode: "HOLD_RELEASED",
  },

  // --- Defensive -------------------------------------------------------------
  {
    from: "*",
    event: "SUB_FLOOR_CANDIDATE_DETECTED",
    guard: "unreachable in correct operation; halts the session if it fires",
    to: "HALTED",
    reasonCode: "FLOOR_BREACH",
  },
] as const satisfies readonly StateTransition[];
