// Fixture: same B3 violation as order-creation-violation.ts, but written
// with a typed, destructured input object — the shape a real
// packages/payments module is likely to use (`createOrder({ offerId,
// amountMinor }: CreateOrderInput)`), and the shape B3 previously missed.
interface CreateOrderInput {
  offerId: string;
  amountMinor: number;
}

export function createOrder({ offerId, amountMinor }: CreateOrderInput) {
  return { offerId, amountMinor };
}
