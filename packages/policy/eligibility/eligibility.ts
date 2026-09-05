import type { Basket, NegotiationSession } from "../contracts/negotiation";
import type { MerchantPolicy, SkuPolicy } from "../contracts/merchant-policy";

/**
 * TICKET-101 — eligibility engine (PRD §3, §15, §16 RA-3; CONTRACTS.md B4).
 *
 * Decides, from merchant-controlled state alone, whether a session may
 * negotiate. Takes no conversation input of any kind.
 *
 * ============================================================================
 * BOUNDARY RULE (B4-style) — no conversation content can reach this function
 * ============================================================================
 * The only parameter is {@link EligibilityInput}: a narrow slice of session
 * state (`originalBasket`, `isFlaggedAtRisk` — see below), the merchant
 * policy, and the SKU catalogue. None of these carry free-form text. There is
 * no parameter through which a buyer or buyer-agent message could arrive, and
 * nothing below ever reads a field that isn't one of these three. A buyer
 * cannot claim to be about to abandon and thereby unlock negotiation (PRD
 * §3) — there is no field for such a claim to occupy.
 *
 * ============================================================================
 * THE JUDGMENT CALL: WHERE "IS THIS SESSION AT RISK" GETS DECIDED
 * ============================================================================
 * PRD §3 and this ticket both name five merchant-controlled signals — cart
 * inactivity, exit-intent, cart age, cart value threshold, first-time-buyer —
 * but neither gives an exact threshold (how many idle minutes, what rupee
 * cart-value figure) or a combining rule (any one of five vs. N of five).
 * Inventing a specific number here would be a product decision this ticket
 * is not authorized to make.
 *
 * This module does NOT compute at-risk-ness from those five raw signals.
 * Instead, `session.isFlaggedAtRisk` is a plain pass-through of whatever an
 * upstream system already decided from them (that system is not built yet —
 * out of scope for this ticket). Two things make this the confident, not
 * merely convenient, reading:
 *
 *  1. `MerchantPolicy` (contracts/merchant-policy.ts, frozen) has no
 *     cart-value-threshold field, no inactivity-timeout field, and no
 *     combining-rule field. There is structurally nowhere for this function
 *     to read a threshold from even if it wanted to compute one.
 *  2. `state-machine.ts`'s frozen transition table already models exactly
 *     this split: `IDLE --ELIGIBILITY_RULES_MATCH--> AT_RISK` (reason
 *     `SESSION_FLAGGED_AT_RISK`) is a separate, prior transition owned by
 *     whatever flags the session; `AT_RISK --NEGOTIATION_REQUESTED-->`
 *     (kill switch / SKU / eligible) is this ticket's job. This function
 *     implements the second transition only, taking the first one's outcome
 *     as a given boolean.
 *
 * A one-line note for the field that genuinely doesn't exist upstream yet:
 * there is no live signal source for cart inactivity, exit-intent, cart age,
 * cart value, or first-time-buyer today, so `isFlaggedAtRisk` will need to be
 * threaded through from whatever session-open code eventually computes it —
 * this function only consumes the result.
 *
 * ============================================================================
 * CHECK ORDER — mirrors state-machine.ts's own transition table, not chosen
 * independently
 * ============================================================================
 * The frozen table (contracts/state-machine.ts) already encodes the exact
 * order: not-flagged is a different *state* (IDLE) from flagged-but-blocked
 * (AT_RISK), and within AT_RISK the kill switch is checked before SKU
 * negotiability, which is checked before declaring eligible. This function
 * reproduces that order:
 *
 *   1. `!isFlaggedAtRisk`               → NOT_AT_RISK
 *   2. `!policy.negotiationEnabled`     → NEGOTIATION_DISABLED
 *   3. no negotiable SKU in the basket  → SKU_NOT_NEGOTIABLE
 *   4. otherwise                        → eligible, NEGOTIATION_OPENED
 *
 * This also settles "kill switch off yields NEGOTIATION_DISABLED regardless
 * of any other input": within the only state that check is reachable from
 * (the session was already flagged at risk), it dominates SKU negotiability
 * unconditionally.
 *
 * ============================================================================
 * RE-CHECK, NOT RE-EVALUATE (RA-3)
 * ============================================================================
 * This function is pure and stateless: the same inputs always produce the
 * same answer. Eligibility is evaluated at session open and re-checked once
 * before a Tier 2 mint (PRD §16 RA-3) — never per round — but that calling
 * discipline belongs to session orchestration, which does not exist yet and
 * is out of scope for this ticket. This function does not know or care which
 * of the two call sites invoked it; it behaves identically either way, which
 * is what makes it safe to call from both without building orchestration
 * first.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Session state this ticket actually needs, expressed as a `Pick` over the
 * frozen `NegotiationSession` (for `originalBasket`) plus the one field the
 * frozen session shape deliberately doesn't carry: the already-computed
 * at-risk flag (see the module doc above for why this is a pass-through,
 * not a computation). Neither field can carry conversation text.
 */
export type EligibilitySessionInput = Pick<NegotiationSession, "originalBasket"> & {
  /**
   * Whether merchant-controlled risk signals (cart inactivity, exit-intent,
   * cart age, cart value threshold, first-time-buyer — PRD §3) have already
   * flagged this session as at-risk. Computed upstream from those raw
   * signals; this function does not derive it from them (see module doc).
   */
  isFlaggedAtRisk: boolean;
};

/**
 * The eligibility engine's entire input surface (B4-style). Every field here
 * traces back to merchant policy or merchant-controlled session state —
 * never to a buyer or buyer-agent message.
 */
export type EligibilityInput = {
  session: EligibilitySessionInput;
  policy: MerchantPolicy;
  /** The full catalogue, so a SKU referenced by the basket can be checked
   *  for `negotiable`, mirroring how the candidate generator is supplied
   *  the catalogue rather than trusting basket-embedded data. */
  skuCatalogue: readonly SkuPolicy[];
};

/** The three refusal codes this engine can emit, each already in the closed
 *  `REASON_CODES` enum (contracts/reason-codes.ts) — this module invents no
 *  new code. */
export type EligibilityRefusalReasonCode = "NOT_AT_RISK" | "NEGOTIATION_DISABLED" | "SKU_NOT_NEGOTIABLE";

export type EligibilityResult =
  | { eligible: true; reasonCode: "NEGOTIATION_OPENED" }
  | { eligible: false; reasonCode: EligibilityRefusalReasonCode };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireSkuPolicy(skuPoliciesById: Map<string, SkuPolicy>, skuId: string): SkuPolicy {
  const skuPolicy = skuPoliciesById.get(skuId);
  if (!skuPolicy) {
    throw new Error(`checkEligibility: no SKU policy supplied for skuId "${skuId}"`);
  }
  return skuPolicy;
}

/**
 * Fails closed rather than silently treating an unrecognized SKU as
 * non-negotiable (CONTRACTS.md §6) — same discipline as
 * economics/contribution.ts and generation/candidates.ts: a basket line this
 * policy has no authority over must not silently influence the decision.
 */
function basketHasNegotiableSku(basket: Basket, skuCatalogue: readonly SkuPolicy[]): boolean {
  const skuPoliciesById = new Map(skuCatalogue.map((sku) => [sku.skuId, sku] as const));
  const basketSkuPolicies = basket.lines.map((line) => requireSkuPolicy(skuPoliciesById, line.skuId));
  return basketSkuPolicies.some((skuPolicy) => skuPolicy.negotiable);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decides whether `session` may negotiate, from merchant-controlled state
 * alone. Callable identically at session open and at the Tier 2 re-check
 * (RA-3) — see module doc.
 */
export function checkEligibility(input: EligibilityInput): EligibilityResult {
  const { session, policy, skuCatalogue } = input;

  if (!session.isFlaggedAtRisk) {
    return { eligible: false, reasonCode: "NOT_AT_RISK" };
  }

  if (!policy.negotiationEnabled) {
    return { eligible: false, reasonCode: "NEGOTIATION_DISABLED" };
  }

  if (!basketHasNegotiableSku(session.originalBasket, skuCatalogue)) {
    return { eligible: false, reasonCode: "SKU_NOT_NEGOTIABLE" };
  }

  return { eligible: true, reasonCode: "NEGOTIATION_OPENED" };
}
