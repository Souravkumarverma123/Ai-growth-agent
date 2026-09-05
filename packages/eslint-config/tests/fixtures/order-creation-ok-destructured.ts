// Fixture: proves B3 does not false-positive on a typed, destructured input
// object as long as no destructured property carries an amount-shaped name —
// the amount still comes from the persisted Offer row, never the caller.
import type { Offer } from "@repo/policy";

interface CreateOrderInput {
  offerId: string;
}

export function createOrder({ offerId }: CreateOrderInput) {
  const offer: Offer = lookupOffer(offerId);
  return { offerId, totalMinor: offer.totalMinor };
}

declare function lookupOffer(offerId: string): Offer;
