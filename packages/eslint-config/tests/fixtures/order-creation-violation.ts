// Fixture: stands in for a future file inside packages/payments. Deliberately
// violates B3 (CONTRACTS.md §2) — the order-creation function accepts an
// amount parameter instead of deriving it from the persisted Offer row.
export function createOrder(offerId: string, amountMinor: number) {
  return { offerId, amountMinor };
}
