// Fixture: proves the rule is scoped to the function NAME, not just any
// function with an amount-shaped parameter. `applyDiscount` is not order
// creation, so this must not fire even though it takes an `amountMinor`.
export function applyDiscount(basketId: string, amountMinor: number) {
  return { basketId, amountMinor };
}
