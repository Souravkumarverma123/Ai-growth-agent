import { z } from "zod";

/**
 * FROZEN CONTRACT — PRD.md §14, CONTRACTS.md §5.2.
 *
 * The closed set of reason codes. Every audit event carries exactly one, and
 * the model can never author one: codes are emitted by deterministic code only.
 *
 * The enum is CLOSED at 28 members. Wanting a 29th means a behaviour is being
 * added that nobody designed — record it in issue-tracker.md rather than
 * extending this list.
 *
 * Reviewed against the state machine in state-machine.ts (Q34). The Round 4
 * draft held 17 codes; 11 transitions had no code, and one code was unreachable
 * in correct operation.
 */
export const REASON_CODES = [
  // --- Session & eligibility -------------------------------------------------
  "SESSION_FLAGGED_AT_RISK",
  "NOT_AT_RISK",
  "NEGOTIATION_DISABLED",
  "SKU_NOT_NEGOTIABLE",
  "NEGOTIATION_OPENED",

  // --- Generation ------------------------------------------------------------
  "CANDIDATES_EVALUATED",
  "NO_FEASIBLE_BASKET",
  /**
   * Defensive assertion, deliberately unreachable in correct operation. Floors
   * are a generation constraint, so a sub-floor candidate is never constructed.
   * If this ever fires, something is badly wrong and the session halts.
   */
  "FLOOR_BREACH",

  // --- Tiering ---------------------------------------------------------------
  "TIER1_OFFERED",
  "TIER1_REFUSED_BY_BUYER",
  "DILUTION_WITHIN_CAPS",
  "DILUTION_EXCEEDS_PER_DEAL_CAP",
  "CAMPAIGN_BUDGET_EXHAUSTED",
  "ROUND_LIMIT_REACHED",

  // --- Offer lifecycle -------------------------------------------------------
  "OFFER_ACCEPTED",
  "OFFER_EXPIRED",
  "OFFER_ALREADY_CONSUMED",
  "BASKET_MISMATCH",
  "BUYER_DECLINED",
  "WALK_AWAY",

  // --- Budget holds ----------------------------------------------------------
  "HOLD_RESERVED",
  "HOLD_RELEASED",
  "HOLD_COMMITTED",

  // --- Payment & rail --------------------------------------------------------
  "AUTONOMOUS_PAYMENT_NOT_AUTHORIZED",
  "ORDER_CREATED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
  "RAIL_STATE_DIVERGENCE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const reasonCodeSchema = z.enum(REASON_CODES);

/** The frozen size of the enum. Asserted by test, not merely documented. */
export const REASON_CODE_COUNT = 28;

/**
 * `OFFER_MINTED` was considered and rejected as redundant: a minting event's
 * code is TIER1_OFFERED or DILUTION_WITHIN_CAPS, which already encodes the tier.
 */
