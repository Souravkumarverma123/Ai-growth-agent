// Fixture: same B3 violation as order-creation-violation.ts, but written as
// an arrow function assigned to a const — a different function shape the
// rule needs to catch, since a future packages/payments module might use
// either style.
export const createRazorpayOrder = (offerId: string, totalMinor: number) => {
  return { offerId, totalMinor };
};
