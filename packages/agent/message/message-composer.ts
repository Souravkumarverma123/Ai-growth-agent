import type { MessageFrame, Offer } from "@repo/policy";

/**
 * TICKET-203 — constrained message composition (PRD §7.2; CONTRACTS.md §2,
 * §5.1, §8, §9). "Make it structurally impossible for the agent to state a
 * fact the offer object does not contain."
 *
 * ============================================================================
 * WHY A TEMPLATE, NOT A GENERATOR
 * ============================================================================
 * This module never asks anything (model or otherwise) to produce buyer-facing
 * prose. `composeOfferMessage` looks up a fixed template by `MessageFrame` —
 * `MessageFrame` is the model's ENTIRE say over the message (it is one of the
 * two fields on the frozen, numberless `NegotiationIntent`, TICKET-201) — and
 * fills its slots with values read directly off the `Offer` that was minted
 * (TICKET-110). There is no code path from a model's output to free-form text:
 * the model picks *which* fixed template runs, never *what* it says. A model
 * cannot make this function say "only 2 left" any more than it can make
 * `NegotiationIntent` carry a price — the same "no field to put it in"
 * discipline `contracts/intent.ts` documents for numbers, applied here to
 * claims.
 *
 * ============================================================================
 * EVERY NUMBER IS A COPY, NEVER A COMPUTATION
 * ============================================================================
 * Every slot below is a field read verbatim off `Offer` (or one of its
 * `basket.lines`) — `totalMinor`, `currency`, `quantity`, `unitPriceMinor`.
 * None are summed, multiplied, or otherwise derived: a derived figure (e.g. a
 * hand-computed subtotal) would still be true, but it would not be a value
 * that already exists on the offer row, and this ticket's acceptance
 * criterion is exactly that literal test — "every number appearing in an
 * outbound message comes from the offer row." Keeping every slot a direct
 * copy makes that property checkable by construction, not by trusting the
 * arithmetic.
 *
 * Amounts are left in minor units, unformatted (CONTRACTS.md §3: "Formatting
 * to rupees happens only at the React render boundary"). This module is not
 * that boundary — turning `totalMinor` into a locale-formatted rupee string
 * is a future buyer-surface rendering concern (see `issue-tracker.md`), not
 * this ticket's.
 *
 * `campaignSpendMinor` is deliberately never read here: CONTRACTS.md §9 bars
 * a floor price, an available budget figure, a per-deal cap, or a
 * concession-curve value from ever reaching the buyer-facing surface. A
 * per-offer campaign-spend figure is the same class of internal economics —
 * excluding it entirely is the conservative reading, not merely an oversight.
 *
 * ============================================================================
 * WHAT IS NEVER VOLUNTEERED, AND HOW A TRUTHFUL ANSWER STILL WORKS
 * ============================================================================
 * `composeOfferMessage` never mentions `offer.expiresAt`, and its input has
 * no field for `Candidate.clearsSlowMoving` at all — it cannot volunteer
 * either fact even by accident, because there is no slot for them in any of
 * the five templates. `answerBuyerQuestion` is the ONLY path to either fact,
 * and exists precisely so that a direct buyer question still gets a truthful
 * answer (this ticket's own acceptance criteria): it reads the real
 * `offer.expiresAt` for `"EXPIRY"`, and the real, caller-supplied
 * `clearsSlowMoving` for `"SLOW_MOVING_STATUS"` — never an invented one.
 * Wiring "the buyer just asked about X" to a call to this function is a
 * future buyer-conversation ticket's job (TICKET-206 is TODO as of this
 * writing); this module only guarantees that WHEN that call is made, the
 * answer is truthful and numerically grounded.
 *
 * ============================================================================
 * SCARCITY / URGENCY — BELT AND SUSPENDERS
 * ============================================================================
 * The five templates below are fixed strings with no room for scarcity or
 * urgency language — there is no branch, in any of them, that reacts to
 * `messageFrame` or slot values with words like "hurry" or "only N left".
 * `assertNoScarcityOrUrgencyLanguage` is a second, independent layer over the
 * templates' own construction: every string this module ever returns to a
 * caller is fail-closed (CONTRACTS.md §6) — checked against a fixed pattern
 * and thrown on a match — rather than trusted to have been written safely.
 * The templates are why a match should never happen; the assertion is what
 * makes "should never" a checked fact instead of a hope.
 */

// ---------------------------------------------------------------------------
// Scarcity / urgency guard
// ---------------------------------------------------------------------------

/**
 * Matches the vocabulary of manufactured urgency and scarcity: fabricated
 * stock claims ("only 2 left", "while stocks last"), invented time pressure
 * ("hurry", "act now", "expires soon"), and invented price-movement claims
 * ("price is going up"). None of this is grounded in the offer object — the
 * offer carries a real `expiresAt` and nothing about future stock or price
 * movement, so a claim in any of these families is, by definition, invented.
 */
export const SCARCITY_URGENCY_PATTERN =
  /\b(?:hurry|act\s+now|only\s+\d+\s+(?:left|remaining)|(?:almost|nearly)\s+(?:sold\s+out|gone)|sold\s+out|limited\s+(?:time|stock|quantity|availability)|while\s+(?:supplies|stocks?)\s+last(?:s)?|running\s+out|won'?t\s+last|last\s+chance|going\s+fast|don'?t\s+miss|before\s+it'?s\s+too\s+late|expir(?:es?|ing)\s+soon|price(?:s)?\s+(?:is|are|will\s+be)\s+going\s+up|prices?\s+(?:are\s+)?(?:rising|increasing)|book\s+now|order\s+now|today\s+only|final\s+(?:call|hours)|grab\s+it|act\s+fast)\b/i;

/**
 * Throws if `text` matches the forbidden scarcity/urgency vocabulary. Called
 * by every function in this module before it returns a string to a caller
 * (CONTRACTS.md §6: fail closed at a boundary, never silently continue).
 */
export function assertNoScarcityOrUrgencyLanguage(text: string): void {
  if (SCARCITY_URGENCY_PATTERN.test(text)) {
    throw new Error(
      `message-composer: composed text matched the forbidden scarcity/urgency pattern and was refused: "${text}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Slot rendering — every value below is copied verbatim off `Offer`
// ---------------------------------------------------------------------------

function describeBasketLine(line: Offer["basket"]["lines"][number]): string {
  return `${line.quantity} unit(s) at ${line.unitPriceMinor} minor units each`;
}

function describeBasket(offer: Offer): string {
  return offer.basket.lines.map(describeBasketLine).join("; ");
}

function describeCommitments(offer: Offer): string {
  return offer.basket.commitments.join(", ");
}

function describeTotal(offer: Offer): string {
  return `${offer.totalMinor} ${offer.currency} (minor units) in total`;
}

// ---------------------------------------------------------------------------
// The five fixed templates — one per `MessageFrame`
// ---------------------------------------------------------------------------

type FrameComposer = (offer: Offer) => string;

/**
 * `SLOW_MOVING_CLEARANCE` deliberately renders IDENTICAL neutral copy to
 * `BUNDLE_VALUE`. `MessageFrame` is the model's internal signal for *which*
 * fixed template to run, not buyer-facing vocabulary — whether a candidate
 * clears a slow-moving SKU (`Candidate.clearsSlowMoving`) is exactly the fact
 * this ticket's acceptance criteria say must never be volunteered
 * unprompted. There is no slot here for it to leak through even if a future
 * edit tried to reference it, because this map's type is `(offer: Offer) =>
 * string` — `Offer` carries no `clearsSlowMoving` field at all (only
 * `Candidate` does).
 */
const FRAME_COMPOSERS: Record<MessageFrame, FrameComposer> = {
  BUNDLE_VALUE: (offer) => `Here's what we can put together: ${describeBasket(offer)}. That's ${describeTotal(offer)}.`,
  SLOW_MOVING_CLEARANCE: (offer) =>
    `Here's what we can put together: ${describeBasket(offer)}. That's ${describeTotal(offer)}.`,
  COMMITMENT_TRADE: (offer) => {
    const commitments = describeCommitments(offer);
    const inExchangeFor = commitments.length > 0 ? ` in exchange for: ${commitments}` : "";
    return `Here's an offer${inExchangeFor}: ${describeBasket(offer)}. That's ${describeTotal(offer)}.`;
  },
  QUANTITY_VALUE: (offer) => `At this quantity, here's what we can offer: ${describeBasket(offer)}. That's ${describeTotal(offer)}.`,
  FINAL_POSITION: (offer) => `This is the best we can do: ${describeBasket(offer)}. That's ${describeTotal(offer)}.`,
};

// `FRAME_COMPOSERS`'s own `Record<MessageFrame, FrameComposer>` annotation
// IS the exhaustiveness proof: if `MESSAGE_FRAMES` (frozen, `@repo/policy`)
// ever gains or loses a member, the object literal above stops satisfying
// that type (missing key or excess key) and `check-types` fails — the build
// breaks at the moment a frame is added without a template for it, rather
// than `composeOfferMessage` silently falling through at runtime.

// ---------------------------------------------------------------------------
// Public entry point — the initial offer message
// ---------------------------------------------------------------------------

export type ComposeOfferMessageInput = {
  /** The minted offer this message is generated from — the ONLY source of
   *  fact for every number this function may emit. */
  readonly offer: Offer;
  /** The model's entire say over this message (TICKET-201's frozen
   *  `NegotiationIntent.messageFrame`) — selects a fixed template, never
   *  free-form text. */
  readonly messageFrame: MessageFrame;
};

/**
 * Composes the outbound offer message from a constrained template with
 * slots. Every number in the result is copied verbatim from `offer`; no
 * stock, scarcity, expiry, or price-movement claim is producible, because no
 * template contains one and every result is checked against
 * {@link SCARCITY_URGENCY_PATTERN} before it is returned.
 */
export function composeOfferMessage(input: ComposeOfferMessageInput): string {
  const { offer, messageFrame } = input;
  const composer = FRAME_COMPOSERS[messageFrame];
  if (!composer) {
    // Unreachable while FRAME_COMPOSERS satisfies Record<MessageFrame, ...>
    // (see the exhaustiveness proof above) — fail loudly if it ever isn't.
    throw new Error(`composeOfferMessage: no template registered for messageFrame "${messageFrame}"`);
  }
  const text = composer(offer);
  assertNoScarcityOrUrgencyLanguage(text);
  return text;
}

// ---------------------------------------------------------------------------
// Truthful, on-demand answers — never volunteered by composeOfferMessage
// ---------------------------------------------------------------------------

/** The closed set of facts a buyer may ask about directly (this ticket's own
 *  two acceptance criteria) that `composeOfferMessage` never volunteers. */
export const BUYER_QUESTION_TOPICS = ["EXPIRY", "SLOW_MOVING_STATUS"] as const;
export type BuyerQuestionTopic = (typeof BUYER_QUESTION_TOPICS)[number];

/**
 * Truthfully answers a direct question about this offer's expiry, drawn from
 * `offer.expiresAt` — never a re-derived countdown, so the only numbers in
 * the answer are the exact digits already on the offer row (the ISO
 * timestamp `Offer.expiresAt` itself serializes to).
 */
export function describeOfferExpiry(offer: Offer, now: Date): string {
  const isExpired = now.getTime() >= offer.expiresAt.getTime();
  const text = isExpired
    ? `This offer expired at ${offer.expiresAt.toISOString()}.`
    : `This offer is valid until ${offer.expiresAt.toISOString()}.`;
  assertNoScarcityOrUrgencyLanguage(text);
  return text;
}

/**
 * Truthfully answers a direct question about slow-moving status. Takes
 * `clearsSlowMoving` as a plain boolean rather than reading it off `offer`,
 * because `Offer` carries no such field — it lives on the `Candidate` this
 * offer was minted from (TICKET-109's tolerance flag); the caller must
 * supply the value from that candidate.
 */
export function describeSlowMovingStatus(clearsSlowMoving: boolean): string {
  const text = clearsSlowMoving
    ? "Yes — this basket includes an item flagged as slow-moving in our system."
    : "No, this basket doesn't include any item flagged as slow-moving.";
  assertNoScarcityOrUrgencyLanguage(text);
  return text;
}

export type AnswerBuyerQuestionInput = {
  readonly topic: BuyerQuestionTopic;
  readonly offer: Offer;
  /** Only read for `"EXPIRY"`. */
  readonly now: Date;
  /** Only read for `"SLOW_MOVING_STATUS"` — see {@link describeSlowMovingStatus}. */
  readonly clearsSlowMoving?: boolean;
};

/**
 * Single entry point for the two truthful, on-demand answers this ticket
 * defines. Routing "the buyer just asked about X" to a call here is a future
 * buyer-conversation ticket's job — this function only guarantees that once
 * called, the answer is truthful and numerically grounded in the offer.
 */
export function answerBuyerQuestion(input: AnswerBuyerQuestionInput): string {
  switch (input.topic) {
    case "EXPIRY":
      return describeOfferExpiry(input.offer, input.now);
    case "SLOW_MOVING_STATUS":
      if (input.clearsSlowMoving === undefined) {
        throw new Error(
          "answerBuyerQuestion: clearsSlowMoving is required to answer SLOW_MOVING_STATUS truthfully",
        );
      }
      return describeSlowMovingStatus(input.clearsSlowMoving);
    default: {
      const _exhaustive: never = input.topic;
      throw new Error(`answerBuyerQuestion: unknown topic "${String(_exhaustive)}"`);
    }
  }
}
