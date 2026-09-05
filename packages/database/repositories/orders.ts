import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { ordersTable, type SelectOrder } from "../models/payment";

/**
 * TICKET-302 — offer-to-order uniqueness (PRD §11, CONTRACTS.md §2, §8).
 * "`offer_id -> exactly one order`, enforced by the database."
 *
 * IDEMPOTENCY IS OURS, NOT THE RAIL'S — see `models/payment.ts`'s module doc.
 * The guarantee here comes entirely from our own unique constraint on
 * `orders.offer_id` (already migrated —
 * `drizzle/0001_sour_dreadnoughts.sql`'s `orders_offer_id_unique`) plus the
 * reserve-before-POST ordering `createOrder` (`packages/payments`) now
 * follows. Nothing about this guarantee is supplied by, or depends on, any
 * header the payment rail offers.
 *
 * `reserveOrder` is a single `INSERT`, not a read-then-check-then-write: it
 * relies on Postgres to reject a second concurrent insert for the same
 * `offerId` at the database level (error code `23505`, unique_violation),
 * and translates that into a clean domain result — `{ reserved: false,
 * reason: "ORDER_ALREADY_EXISTS" }` — rather than letting a raw
 * Postgres error escape to a caller that shouldn't know what `23505` means.
 * Two concurrent `reserveOrder` calls for the same offer therefore always
 * leave exactly one row: Postgres's own unique index serializes the two
 * inserts, and only one can ever commit.
 *
 * `attachRailOrder` is a plain follow-up `UPDATE`, run once the Razorpay POST
 * this reservation guarded actually succeeds, so the local row records which
 * rail order it produced (for human reconciliation and for TICKET-304's
 * polling reconciler to have something to poll). It is not part of the
 * uniqueness invariant itself — `railOrderId` starts `NULL` at reservation
 * time and is only ever set once, by the same caller that reserved the row.
 *
 * Deliberately generic over `NodePgDatabase` (not the real exported `db`),
 * same as every other repository function here, so this runs against
 * `getTestDb()` in tests and the real `db` in production without a fork.
 */

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/** The constraint this module translates — see `models/payment.ts` and the migration. */
const ORDERS_OFFER_ID_UNIQUE_CONSTRAINT = "orders_offer_id_unique";

export type ReserveOrderParams = {
  offerId: string;
  /** Copied onto the order row for human reconciliation — never re-derived later. */
  amountMinor: number;
  currency: string;
};

export type ReserveOrderResult =
  | { reserved: true; order: SelectOrder }
  | { reserved: false; reason: "ORDER_ALREADY_EXISTS" };

type PgLikeError = { code?: string; constraint?: string; cause?: unknown };

/**
 * drizzle-orm's node-postgres driver never throws the raw `pg` error
 * directly — every query error is wrapped in its own `DrizzleQueryError`,
 * with the real `pg` `DatabaseError` (carrying `.code` / `.constraint`)
 * attached as `.cause` (verified directly against this repo's own test
 * database: `DrizzleQueryError`'s `.code` is undefined, `.cause.code` is
 * `"23505"`). So this checks both the error itself and its `.cause`, one
 * level deep — enough for every error shape this driver actually produces,
 * without walking an unbounded chain.
 */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const candidates = [error, (error as PgLikeError)?.cause];
  return candidates.some((candidate) => {
    const pgError = candidate as PgLikeError | undefined;
    return pgError?.code === UNIQUE_VIOLATION && pgError?.constraint === constraint;
  });
}

/**
 * Attempts to reserve a local `orders` row for `offerId` — the
 * "reserve-before-POST" step. Succeeds at most once per offer, ever: a
 * second call (concurrent or sequential, retried or genuinely racing) for
 * the same `offerId` always comes back `{ reserved: false, reason:
 * "ORDER_ALREADY_EXISTS" }`, never a thrown raw Postgres error and never a
 * second row.
 *
 * Callers should call this BEFORE making any external payment-rail call
 * (`createOrder`, `packages/payments/src/create-order.ts`) and only proceed
 * to the rail if `reserved` is `true` — that ordering is what makes "one
 * offer, at most one live rail order" hold even under a race or a client
 * retry, not merely "one offer, at most one local row."
 */
export async function reserveOrder(
  database: NodePgDatabase,
  params: ReserveOrderParams,
): Promise<ReserveOrderResult> {
  const { offerId, amountMinor, currency } = params;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`reserveOrder: amountMinor must be a positive integer (${amountMinor})`);
  }

  try {
    const [order] = await database
      .insert(ordersTable)
      .values({ offerId, amountMinor, currency })
      .returning();

    return { reserved: true, order: order! };
  } catch (error) {
    if (isUniqueViolationOn(error, ORDERS_OFFER_ID_UNIQUE_CONSTRAINT)) {
      return { reserved: false, reason: "ORDER_ALREADY_EXISTS" };
    }
    // Anything else (a missing offer FK, a connection failure, ...) is a real
    // problem this module has no clean domain code for — fail closed and
    // propagate it, rather than misclassifying it as "already exists"
    // (CONTRACTS.md §6).
    throw error;
  }
}

export type AttachRailOrderParams = {
  orderId: string;
  railOrderId: string;
  /** Raw Razorpay response, kept for human reconciliation. */
  railPayload?: Record<string, unknown>;
};

/**
 * Records the Razorpay order id (and raw payload) onto an already-reserved
 * row, once the POST that `reserveOrder` guarded has actually succeeded.
 * Returns the updated row, or `undefined` if `orderId` doesn't exist.
 */
export async function attachRailOrder(
  database: NodePgDatabase,
  params: AttachRailOrderParams,
): Promise<SelectOrder | undefined> {
  const { orderId, railOrderId, railPayload } = params;

  const [order] = await database
    .update(ordersTable)
    .set({ railOrderId, railPayload: railPayload ?? null })
    .where(eq(ordersTable.id, orderId))
    .returning();

  return order;
}
