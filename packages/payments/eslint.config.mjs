import { config } from "@repo/eslint-config/base";
import { orderCreationBoundaries, paymentsBoundaries } from "@repo/eslint-config/boundaries";

/**
 * CONTRACTS.md §2.
 *
 * `paymentsBoundaries` is the defense-in-depth mirror of B1 for this side of
 * the boundary: packages/payments must not import a model SDK either —
 * amounts come from the offer row, never from a model.
 *
 * `orderCreationBoundaries` is the real B3: no function whose name looks
 * like an order-creation function (createOrder, createRazorpayOrder, ...)
 * may accept a parameter named like an amount (amountMinor, totalMinor,
 * ...). This is the exact rule TICKET-006 wrote in anticipation of this
 * package existing (see packages/eslint-config/boundaries.js's module doc).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [...config, ...paymentsBoundaries, ...orderCreationBoundaries];
