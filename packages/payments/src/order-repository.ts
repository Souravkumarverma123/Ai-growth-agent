import { db } from "@repo/database";
import type { SelectOrder } from "@repo/database/models/payment";
import {
  attachRailOrder,
  reserveOrder,
  type ReserveOrderResult,
} from "@repo/database/repositories/orders";

import type { RazorpayOrder } from "./razorpay-client";

/**
 * TICKET-302 — thin wrapper around `@repo/database/repositories/orders` bound
 * to the real `db`, same shape as `./offer-repository.ts`'s wrapper around
 * `@repo/database`. Kept as its own module (rather than calling the
 * repository functions directly from `./create-order.ts`) so
 * `../tests/create-order.test.ts` can `vi.mock` this one seam and assert
 * call order (reserve, then POST) without a real database connection.
 */

export type ReserveLocalOrderParams = {
  offerId: string;
};

export type { ReserveOrderResult };

/** The "reserve-before-POST" step — see `@repo/database/repositories/orders`. */
export async function reserveLocalOrder(
  params: ReserveLocalOrderParams,
): Promise<ReserveOrderResult> {
  return reserveOrder(db, params);
}

/** Records the Razorpay order id/payload onto an already-reserved row. */
export async function attachRailOrderId(
  orderId: string,
  railOrder: RazorpayOrder,
): Promise<SelectOrder | undefined> {
  return attachRailOrder(db, {
    orderId,
    railOrderId: railOrder.id,
    railPayload: railOrder,
  });
}

export async function cancelUnattachedOrder(orderId: string): Promise<void> {
  const { deleteUnattachedOrder } = await import(
    "@repo/database/repositories/orders"
  );
  return deleteUnattachedOrder(db, orderId);
}
