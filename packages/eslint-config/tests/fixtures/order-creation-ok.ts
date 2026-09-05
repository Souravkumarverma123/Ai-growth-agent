// Fixture: stands in for compliant code inside a future packages/payments —
// createOrder(offerId) takes exactly one argument and reads the amount from
// the already-persisted Offer row. Proves B3 does not false-positive on the
// shape it exists to allow.
import type { Offer } from "@repo/policy";

export function createOrder(offerId: string) {
  const offer: Offer = lookupOffer(offerId);
  return { offerId, totalMinor: offer.totalMinor };
}

declare function lookupOffer(offerId: string): Offer;
