import type { SelectOffer } from "@repo/database/models/offer";

import { getOfferById } from "./offer-repository";
import { attachRailOrderId, reserveLocalOrder } from "./order-repository";
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
 * TICKET-302 — offer-to-order uniqueness (formerly ISSUE-010, now FIXED).
 * This function reserves a local `orders` row for `offerId` (`./order-repository.ts`
 * -> `@repo/database/repositories/orders`, enforced by the unique constraint
 * on `orders.offer_id`) BEFORE calling out to Razorpay, and only proceeds to
 * `createRazorpayOrder` if that reservation actually succeeded. A concurrent
 * or retried call for an `offerId` that already has a reservation never
 * reaches Razorpay at all — it fails at the local `INSERT`, which Postgres's
 * own unique index serializes, and surfaces as a thrown `OrderAlreadyExistsError`
 * rather than a raw Postgres error or a silent second order. This is our own
 * database-enforced idempotency, never anything supplied by Razorpay — see
 * `packages/database/models/payment.ts`'s module doc ("IDEMPOTENCY IS OURS,
 * NOT THE RAIL'S") and `packages/database/repositories/orders.ts`.
 */
export class OrderAlreadyExistsError extends Error {
  readonly offerId: string;

  constructor(offerId: string) {
    super(`createOrder: an order already exists for offerId "${offerId}"`);
    this.name = "OrderAlreadyExistsError";
    this.offerId = offerId;
  }
}

export async function createOrder(offerId: string): Promise<RazorpayOrder> {
  const offer = await getOfferById(offerId);

  // Reserve-before-POST: the local row must exist, uniquely, before we ever
  // talk to Razorpay. If it doesn't (an order already exists for this
  // offer), we stop right here — no second POST, no raw DB error escaping.
  const reservation = await reserveLocalOrder({
    offerId: offer.id,
    amountMinor: offer.totalMinor,
    currency: offer.currency,
  });

  if (!reservation.reserved) {
    throw new OrderAlreadyExistsError(offerId);
  }

  const request = buildRazorpayOrderRequest(offer);
  const razorpayOrder = await createRazorpayOrder(request);

  // Record what the reservation actually produced, for human reconciliation
  // and for TICKET-304's polling reconciler to have a rail order id to poll.
  await attachRailOrderId(reservation.order.id, razorpayOrder);

  return razorpayOrder;
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
