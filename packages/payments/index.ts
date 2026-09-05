/**
 * Public surface of `@repo/payments`.
 *
 * B3 (CONTRACTS.md §2): `createOrder(offerId)` is the only order-creation
 * entry point. Everything money-shaped is re-derived from the persisted
 * offer row, so no caller can supply an amount.
 *
 * The low-level `createRazorpayOrder(request)` and its `RazorpayOrderRequest`
 * type are deliberately NOT re-exported: that request carries a plain
 * `amount` field, so exposing it would hand callers an order-creation path
 * that bypasses the offer row. It stays module-private behind the mockable
 * seam in `./src/razorpay-client` — `createOrder` reaches it directly and
 * tests replace it with `vi.mock`.
 */
export { createOrder, buildRazorpayOrderRequest } from "./src/create-order";
export { getOfferById } from "./src/offer-repository";
export { type RazorpayOrder } from "./src/razorpay-client";
