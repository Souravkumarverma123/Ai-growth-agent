import type { SelectOffer } from "@repo/database/models/offer";

import { getOfferById } from "./offer-repository";
import {
  attachRailOrderId,
  cancelUnattachedOrder,
  reserveLocalOrder,
} from "./order-repository";
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
 * TICKET-302 — offer-to-order uniqueness (ISSUE-009, now FIXED).
 * This function reserves a local `orders` row for `offerId` (`./order-repository.ts`
 * -> `@repo/database/repositories/orders`, enforced by the unique constraint
 * on `orders.offer_id`) BEFORE calling out to Razorpay, and only proceeds to
 * `createRazorpayOrder` if that reservation actually succeeded. A concurrent
 * or retried call for an `offerId` that already has a reservation never
 * reaches Razorpay at all — it fails at the local `INSERT`, which Postgres's
 * own unique index serializes. This is our own database-enforced
 * idempotency, never anything supplied by Razorpay — see
 * `packages/database/models/payment.ts`'s module doc ("IDEMPOTENCY IS OURS,
 * NOT THE RAIL'S") and `packages/database/repositories/orders.ts`.
 *
 * A stuck reservation is NOT always a genuine duplicate, and this function
 * treats the two cases differently on purpose:
 *   - The reservation's `railOrderId` is set: a rail order is *confirmed* to
 *     exist for this offer (attach only ever writes it after Razorpay
 *     returned success) — a real duplicate attempt, `OrderAlreadyExistsError`.
 *   - The reservation exists but `railOrderId` is still null: some earlier
 *     attempt's Razorpay POST or attach step failed, and this function has
 *     no way to know from here whether a live Razorpay order exists for it.
 *     Retrying blindly could create a second live order, since Razorpay's
 *     Orders API has no idempotency key to fall back on (CONTRACTS.md §2 —
 *     "do not reference X-Payout-Idempotency anywhere", a RazorpayX Payouts
 *     feature, not Orders). So this is surfaced as a distinct
 *     `OrderReservationIncompleteError` instead — needs reconciliation
 *     against Razorpay (TICKET-304's polling reconciler), not a retry.
 *
 * The same two-failure-mode distinction applies to a fresh attempt's own
 * POST + attach sequence: if `createRazorpayOrder` itself throws, no order
 * was ever created, so the reservation is freed (`cancelUnattachedOrder`)
 * and a caller's retry is safe. If the POST succeeds but `attachRailOrderId`
 * then fails, a live Razorpay order now exists — the reservation is
 * deliberately left in place (not freed) so nothing else can reserve this
 * offer's slot, and `OrderReservationIncompleteError` is thrown instead of
 * silently losing track of it.
 */
export class OrderAlreadyExistsError extends Error {
  readonly offerId: string;

  constructor(offerId: string) {
    super(`createOrder: an order already exists for offerId "${offerId}"`);
    this.name = "OrderAlreadyExistsError";
    this.offerId = offerId;
  }
}

/**
 * A rail order is confirmed (or strongly suspected) to exist for this offer,
 * but recording it locally never completed — do not retry automatically.
 * `railOrderId` is the id to reconcile against, when known.
 */
export class OrderReservationIncompleteError extends Error {
  readonly offerId: string;
  readonly localOrderId: string;
  readonly railOrderId: string | null;

  constructor(offerId: string, localOrderId: string, railOrderId: string | null) {
    super(
      `createOrder: offerId "${offerId}" has an incomplete order reservation` +
        (railOrderId ? ` (rail order "${railOrderId}" may already exist)` : "") +
        ` — this needs reconciliation against Razorpay, not an automatic retry.`,
    );
    this.name = "OrderReservationIncompleteError";
    this.offerId = offerId;
    this.localOrderId = localOrderId;
    this.railOrderId = railOrderId;
  }
}

export async function createOrder(offerId: string): Promise<RazorpayOrder> {
  const offer = await getOfferById(offerId);

  // Reserve-before-POST: the local row must exist, uniquely, before we ever
  // talk to Razorpay.
  const reservation = await reserveLocalOrder({ offerId: offer.id });

  if (!reservation.reserved) {
    if (reservation.existingOrder.railOrderId) {
      throw new OrderAlreadyExistsError(offerId);
    }
    throw new OrderReservationIncompleteError(
      offerId,
      reservation.existingOrder.id,
      reservation.existingOrder.railOrderId,
    );
  }

  let razorpayOrder: RazorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder(buildRazorpayOrderRequest(offer));
  } catch (error) {
    // Razorpay never created an order for this attempt — safe to free the
    // reservation so a retry can attempt a fresh POST.
    await cancelUnattachedOrder(reservation.order.id).catch(() => {});
    throw error;
  }

  // Record what the reservation actually produced, for human reconciliation
  // and for TICKET-304's polling reconciler to have a rail order id to poll.
  let attached: Awaited<ReturnType<typeof attachRailOrderId>>;
  try {
    attached = await attachRailOrderId(reservation.order.id, razorpayOrder);
  } catch {
    // Razorpay DID create an order, but recording it failed. Do NOT free the
    // reservation — see module doc — a retry must not blindly re-POST.
    throw new OrderReservationIncompleteError(offerId, reservation.order.id, razorpayOrder.id);
  }
  if (!attached || attached.railOrderId !== razorpayOrder.id) {
    // attachRailOrder is write-once: this only happens if something else
    // already attached a different rail order to this same reservation, an
    // unexpected state this function has no way to resolve on its own.
    throw new OrderReservationIncompleteError(offerId, reservation.order.id, razorpayOrder.id);
  }

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
