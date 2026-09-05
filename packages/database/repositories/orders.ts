import { and, eq, isNull, sql } from "drizzle-orm";
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
 * reason: "ORDER_ALREADY_EXISTS", existingOrder }` — rather than letting a
 * raw Postgres error escape to a caller that shouldn't know what `23505`
 * means. `existingOrder` lets the caller tell a genuinely complete order
 * (`railOrderId` set) apart from a reservation stuck without one — see
 * `createOrder`'s own handling in `packages/payments/src/create-order.ts`.
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
};

export type ReserveOrderResult =
  | { reserved: true; order: SelectOrder }
  | { reserved: false; reason: "ORDER_ALREADY_EXISTS"; existingOrder: SelectOrder };

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
 * Amount and currency are **derived from the offer row itself** via an
 * atomic `INSERT ... SELECT` — the caller never supplies money, so a stored
 * order can never disagree with its offer (fixes the API-mismatch where
 * `amountMinor`/`currency` were caller-supplied). If the offer does not
 * exist the `SELECT` produces zero rows and the insert returns nothing —
 * surfaced as a thrown error (fail closed, CONTRACTS.md §6).
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
  return reserveOrderAttempt(database, params, /* retriesLeft */ 1);
}

/**
 * A unique-constraint violation only proves a conflicting row existed at
 * `INSERT` time — by the time the follow-up `SELECT` below runs, a
 * concurrent caller's own cleanup (`deleteUnattachedOrder`, called by
 * `createOrder` after its own Razorpay POST failed) can have already
 * deleted it. Without `retriesLeft`, that SELECT finding nothing would
 * force a choice between fabricating a `SelectOrder` (an unsound `!`
 * assertion, the actual bug this guards against) or returning `undefined`
 * despite the type saying otherwise. Since the conflict has provably
 * cleared by the time that happens, retrying our own `INSERT` once is
 * correct, not just convenient: it either succeeds (the offer's slot is
 * genuinely free now) or hits a fresh conflict to report for real. Bounded
 * to one retry — if it happens twice in a row, something is deleting rows
 * for this offer fast enough to warrant a human looking, not another retry.
 */
async function reserveOrderAttempt(
  database: NodePgDatabase,
  params: ReserveOrderParams,
  retriesLeft: number,
): Promise<ReserveOrderResult> {
  const { offerId } = params;

  try {
    // Atomic derive-from-offer: amount/currency can never be caller-supplied.
    const result = await database.execute<SelectOrder>(sql`
      INSERT INTO orders (offer_id, amount_minor, currency)
      SELECT id, total_minor, currency FROM offers WHERE id = ${offerId}
      RETURNING *
    `);

    const order = (result.rows as unknown as SelectOrder[])[0];
    if (!order) {
      throw new Error(`reserveOrder: no offer found for offerId "${offerId}"`);
    }
    // drizzle's raw execute returns snake_case columns; normalize via a
    // follow-up select so callers get the typed SelectOrder shape.
    const [typed] = await database
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, order.id));
    return { reserved: true, order: typed! };
  } catch (error) {
    if (isUniqueViolationOn(error, ORDERS_OFFER_ID_UNIQUE_CONSTRAINT)) {
      // The unique constraint is on offerId, so a violation means exactly
      // one row for this offer existed at INSERT time — fetch it so the
      // caller can tell a genuinely complete order (railOrderId set) apart
      // from a reservation stuck without one (see createOrder's own
      // handling). It can be gone by now (see this function's doc comment).
      const [existingOrder] = await database
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.offerId, offerId));
      if (!existingOrder) {
        if (retriesLeft > 0) {
          return reserveOrderAttempt(database, params, retriesLeft - 1);
        }
        throw new Error(
          `reserveOrder: unique-violation for offerId "${offerId}" but no conflicting row was ` +
            `found even after a retry — investigate concurrent deletion of orders for this offer`,
        );
      }
      return { reserved: false, reason: "ORDER_ALREADY_EXISTS", existingOrder };
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
 * Write-once: only touches rows where `rail_order_id IS NULL`, so a second
 * call never overwrites existing reconciliation data and never trips the
 * unique `rail_order_id` index. Returns the updated row, or `undefined` if
 * `orderId` doesn't exist, or the existing row if it was already attached.
 */
export async function attachRailOrder(
  database: NodePgDatabase,
  params: AttachRailOrderParams,
): Promise<SelectOrder | undefined> {
  const { orderId, railOrderId, railPayload } = params;

  const [order] = await database
    .update(ordersTable)
    .set({ railOrderId, railPayload: railPayload ?? null })
    .where(and(eq(ordersTable.id, orderId), isNull(ordersTable.railOrderId)))
    .returning();

  if (order) return order;

  // No row updated — either orderId doesn't exist or railOrderId already set.
  // Return the existing row (if any) without overwriting.
  const [existing] = await database
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));
  return existing;
}

/**
 * Deletes a reservation that never reached the rail (or whose rail attach
 * failed). Used by `createOrder` to unblock retries when Razorpay or the
 * attach step throws — otherwise the local reservation would permanently
 * occupy the offer's unique slot and `OrderAlreadyExistsError` would block
 * every retry. Only the caller that created the reservation should call this,
 * and only when `rail_order_id IS NULL` (guarded here).
 */
export async function deleteUnattachedOrder(
  database: NodePgDatabase,
  orderId: string,
): Promise<void> {
  await database
    .delete(ordersTable)
    .where(and(eq(ordersTable.id, orderId), isNull(ordersTable.railOrderId)));
}

/** Plain lookup by local id — TICKET-304's reconciler starts from an order
 *  row, not an offer id, since a poll iterates orders directly. */
export async function getOrderById(
  database: NodePgDatabase,
  orderId: string,
): Promise<SelectOrder | undefined> {
  const [order] = await database.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  return order;
}

/**
 * TICKET-304 — every order this merchant's polling loop still needs to ask
 * the rail about: attached to a real rail order (nothing to poll before
 * `attachRailOrder` runs), and not yet at a terminal `localState` (once an
 * order is `CAPTURED` or `FAILED`, PRD §12's one-directional reconciliation
 * has already run its course for it — a later poll would just re-confirm
 * the same fact `reconcileOrder`'s own idempotency guard already handles,
 * so excluding terminal orders here keeps the polling set small rather than
 * relying on that guard alone).
 */
export async function listOrdersAwaitingReconciliation(
  database: NodePgDatabase,
): Promise<SelectOrder[]> {
  return database
    .select()
    .from(ordersTable)
    .where(
      and(
        sql`${ordersTable.railOrderId} IS NOT NULL`,
        sql`${ordersTable.localState} IN ('CREATED', 'AUTHORIZED')`,
      ),
    );
}

export type RecordRailReportParams = {
  localState: SelectOrder["localState"];
  railState: SelectOrder["railState"];
  railPayload: Record<string, unknown>;
};

/**
 * Overwrites this order's local belief with what the rail just reported —
 * PRD §12: "the rail's state overwrites local belief, always." Deliberately
 * unconditional (no CAS guard): unlike `attachRailOrder`'s write-once
 * semantics, there is no "already correct, don't touch it" case here, only
 * "the rail's answer, whatever it is, replaces whatever we believed a
 * moment ago" — true even when the new answer contradicts the old one
 * (that contradiction is `reconcileOrder`'s `CONTRADICTS_LOCAL` case, which
 * decides the ledger event; this function only ever performs the
 * overwrite itself, the same way for every outcome).
 */
export async function recordRailReport(
  database: NodePgDatabase,
  orderId: string,
  params: RecordRailReportParams,
): Promise<SelectOrder | undefined> {
  const [order] = await database
    .update(ordersTable)
    .set({
      localState: params.localState,
      railState: params.railState,
      railPayload: params.railPayload,
      lastPolledAt: new Date(),
    })
    .where(eq(ordersTable.id, orderId))
    .returning();
  return order;
}
