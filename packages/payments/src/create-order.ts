import type { SelectOffer } from "@repo/database/models/offer";

import { getOfferById } from "./offer-repository";
import { createRazorpayOrder, type RazorpayOrder, type RazorpayOrderRequest } from "./razorpay-client";

/**
 * TICKET-301 — CONTRACTS.md §2, boundary rule B3.
 *
 * "No function that creates an order accepts an amount parameter.
 * `createOrder(offerId)` — one argument. Amounts are read from the offer
 * row." That is the whole point of this function: its signature makes it
 * structurally impossible for any caller — model, agent, or human — to pass
 * in a price. Everything money-shaped is re-derived from the persisted,
 * engine-signed `Offer` row (`getOfferById`, `./offer-repository.ts`).
 *
 * No capture or charge call exists anywhere in this package — see
 * `./razorpay-client.ts`'s module doc. `createOrder` only ever creates a
 * Razorpay order; a human buyer authorizes it from there (TICKET-303).
 *
 * KNOWN GAP (ISSUE-009): this function does not reserve or persist a local
 * order before the external POST, so concurrent or retried calls for one
 * `offerId` can create more than one Razorpay order. Offer-to-order
 * uniqueness is out of scope for TICKET-301 (kept read-only here to avoid
 * colliding with TICKET-111) and is the whole scope of TICKET-302 — do not
 * fix it on this branch.
 */
export async function createOrder(offerId: string): Promise<RazorpayOrder> {
  const offer = await getOfferById(offerId);
  const request = buildRazorpayOrderRequest(offer);
  // ISSUE-009 / TICKET-302: no reserve-before-POST — duplicate orders possible under a race.
  return createRazorpayOrder(request);
}

/**
 * Pure derivation from an already-persisted offer row to the exact payload
 * sent to Razorpay. Exported (and exercised directly in
 * `../tests/build-razorpay-order-request.test.ts`) so "amount is always
 * sourced from the offer row" can be asserted behaviourally, against a
 * variety of offer fixtures, without needing a database connection or a
 * network call: this function's only parameter is the offer row itself,
 * so there is no path through which a caller could supply a different
 * amount, currency, or basket.
 *
 * - `amount` is always `offer.totalMinor` — never anything else.
 * - `receipt` carries the offer id, for human reconciliation.
 * - `notes` carries offer id, tier, and campaign spend, for human
 *   reconciliation.
 */
export function buildRazorpayOrderRequest(offer: SelectOffer): RazorpayOrderRequest {
  return {
    amount: offer.totalMinor,
    currency: offer.currency,
    receipt: offer.id,
    notes: {
      offerId: offer.id,
      tier: offer.tier,
      campaignSpendMinor: offer.campaignSpendMinor,
    },
  };
}
