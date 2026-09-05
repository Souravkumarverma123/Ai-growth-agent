import type { Basket, Offer } from "../contracts/negotiation";
import type { ReasonCode } from "../contracts/reason-codes";

/**
 * TICKET-111 — offer TTL, single-use, and basket binding (PRD §10.2;
 * CONTRACTS.md §2, §8). "Three refusals that make an offer unreplayable,
 * unreassignable, and perishable."
 *
 * Pure function, no I/O (CONTRACTS.md §2, §8) — same seam discipline as
 * `minting/mint.ts` (TICKET-110). This module answers exactly one question:
 * given a minted offer's own `expiresAt` / `consumedAt` / `basket`, the
 * basket the buyer is attempting to accept right now, and "now" — is this
 * accept allowed, and if not, which of the three closed reason codes
 * applies?
 *
 * It deliberately takes `now` as a plain argument rather than reading
 * `new Date()` internally, exactly like `mintOffer` — a pure function stays a
 * deterministic function of its arguments (see `minting/mint.ts`'s module
 * doc, and `ledger/hash-chain.ts`'s reason for never hashing a timestamp).
 *
 * This function does NOT enforce "consumedAt set exactly once" by itself —
 * it only reads a snapshot handed to it, so under concurrency two calls
 * could both be handed `consumedAt: null` and both return `{ accepted: true
 * }`. The exactly-once guarantee is a transactional, database-level property
 * (`packages/database/repositories/offers.ts`'s `acceptOffer`, a single
 * atomic compare-and-set `UPDATE ... WHERE consumed_at IS NULL`, never a
 * separate SELECT-then-UPDATE) — this module supplies the shared refusal
 * *rule*, not the concurrency guarantee, exactly as `packages/policy` stays
 * pure and leaves all I/O to `packages/database` (CONTRACTS.md §2).
 *
 * ============================================================================
 * ORDER OF CHECKS
 * ============================================================================
 * Expiry, then already-consumed, then basket — in that order, because an
 * offer that has perished is refused for that reason regardless of anything
 * else true about it, and a replay of an already-perished offer should still
 * read as "it expired," not "it was already consumed" (a subtler, easier to
 * misread signal). The database layer preserves this same ordering when it
 * falls back to this function purely to *classify* why its atomic
 * compare-and-set failed (see `acceptOffer`'s module doc).
 */

/** The three closed reason codes this check can return (PRD §10.2). */
export type OfferAcceptanceRefusalCode = Extract<
  ReasonCode,
  "OFFER_EXPIRED" | "OFFER_ALREADY_CONSUMED" | "BASKET_MISMATCH"
>;

export type EvaluateOfferAcceptanceInput = {
  /**
   * Only the fields this check needs off the minted offer row — callers with
   * a full `Offer` (or a database row) can pass it directly; a structural
   * subset keeps this function from depending on fields it never reads.
   */
  offer: Pick<Offer, "expiresAt" | "consumedAt" | "basket">;
  /** The basket the buyer is attempting to accept right now. */
  acceptedBasket: Basket;
  /** The instant this accept attempt is being evaluated at. */
  now: Date;
};

export type EvaluateOfferAcceptanceResult =
  | { accepted: true }
  | { accepted: false; reasonCode: OfferAcceptanceRefusalCode };

/**
 * Deep, order-sensitive comparison of every field PRD §10.2 names: SKU,
 * quantity, unit price (per line, in the order the lines appear), and the
 * commitment set (compared as a set — a merchant policy's commitment list
 * carries no meaningful order of its own, unlike basket lines, which mirror
 * the exact bundle the offer was minted for). Currency is checked too as a
 * defensive addition — not named in the ticket, but a currency change is
 * certainly "the accepted basket differs."
 */
function basketsMatch(minted: Basket, accepted: Basket): boolean {
  if (minted.currency !== accepted.currency) return false;

  if (minted.lines.length !== accepted.lines.length) return false;
  for (let i = 0; i < minted.lines.length; i++) {
    const mintedLine = minted.lines[i]!;
    const acceptedLine = accepted.lines[i]!;
    if (
      mintedLine.skuId !== acceptedLine.skuId ||
      mintedLine.quantity !== acceptedLine.quantity ||
      mintedLine.unitPriceMinor !== acceptedLine.unitPriceMinor
    ) {
      return false;
    }
  }

  if (minted.commitments.length !== accepted.commitments.length) return false;
  const mintedCommitments = [...minted.commitments].sort();
  const acceptedCommitments = [...accepted.commitments].sort();
  for (let i = 0; i < mintedCommitments.length; i++) {
    if (mintedCommitments[i] !== acceptedCommitments[i]) return false;
  }

  return true;
}

/**
 * Evaluates an accept attempt against a minted offer's own TTL, consumption
 * state, and exact basket. Returns `{ accepted: true }` only when all three
 * hold; otherwise the single reason code that applies, in the fixed
 * precedence documented above.
 */
export function evaluateOfferAcceptance(
  input: EvaluateOfferAcceptanceInput,
): EvaluateOfferAcceptanceResult {
  const { offer, acceptedBasket, now } = input;

  if (Number.isNaN(now.getTime())) {
    throw new Error("evaluateOfferAcceptance: now must be a valid Date");
  }
  if (Number.isNaN(offer.expiresAt.getTime())) {
    throw new Error("evaluateOfferAcceptance: offer.expiresAt must be a valid Date");
  }

  // Perishable: an offer minted with expiresAt = mint time + offerTtlSeconds
  // (TICKET-110, PRD §10: 600 s) is gone the instant `now` reaches that
  // instant, regardless of anything else about it.
  if (now.getTime() >= offer.expiresAt.getTime()) {
    return { accepted: false, reasonCode: "OFFER_EXPIRED" };
  }

  // Unreplayable: `Offer.consumedAt` is "set exactly once" (negotiation.ts's
  // own doc comment) — any accept attempt against an offer that already has
  // one is a replay, whether literal or the losing side of a race.
  if (offer.consumedAt !== null) {
    return { accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" };
  }

  // Unreassignable: negotiation.ts's own doc comment on `Offer.basket` —
  // "Exact basket. Any deviation at accept time is a BASKET_MISMATCH."
  if (!basketsMatch(offer.basket, acceptedBasket)) {
    return { accepted: false, reasonCode: "BASKET_MISMATCH" };
  }

  return { accepted: true };
}
