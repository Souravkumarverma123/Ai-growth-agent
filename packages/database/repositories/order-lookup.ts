import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { ordersTable, type SelectOrder } from "../models/payment";

/**
 * TICKET-204 — read-only lookup used to build the buyer-facing payment
 * handle after `@repo/payments`'s `createOrder(offerId)` (TICKET-301/302)
 * succeeds. That function returns the *rail's* order object only
 * (`RazorpayOrder`); this is the missing read of the *local* `orders` row it
 * created (via its own `reserveOrder`/`attachRailOrder`,
 * `packages/database/repositories/orders.ts`), so a caller can hand back
 * `orderId` (ours) alongside `railOrderId` (Razorpay's) without needing
 * `createOrder` to change its own return shape.
 *
 * Deliberately a new, separate file rather than an addition to
 * `repositories/orders.ts` — same file-collision caution
 * `packages/payments/src/offer-repository.ts`'s own module doc names for a
 * different pair of tickets, applied here to avoid touching a file another
 * in-flight PR might also be editing.
 */
export async function getOrderByOfferId(
  database: NodePgDatabase,
  offerId: string,
): Promise<SelectOrder | undefined> {
  const [order] = await database.select().from(ordersTable).where(eq(ordersTable.offerId, offerId));
  return order;
}
