// Fixture: same B3 violation as order-creation-violation.ts, but written as a
// class method — a third function shape the rule needs to catch.
export class OrderService {
  createOrder(offerId: string, amountMinor: number) {
    return { offerId, amountMinor };
  }
}
