import { integer, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { offersTable } from "./offer";

/**
 * FROZEN SCHEMA — PRD.md §11, §12.
 *
 * IDEMPOTENCY IS OURS, NOT THE RAIL'S.
 *
 * Razorpay's X-Payout-Idempotency header is a RazorpayX Payouts feature and
 * does NOT apply to the Orders API. Do not reference it anywhere.
 *
 * The invariant `offer_id -> exactly one order` is enforced by the unique
 * constraint on offerId below, plus a transactional invariant in the payment
 * layer. This is the stronger claim: our ledger guarantees one offer can mint
 * at most one order, rather than us having passed a header.
 */

/** Mirrors the rail's vocabulary. The rail is authoritative, always. */
export const railStateEnum = pgEnum("rail_state", [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
]);

export const ordersTable = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),

  /** One offer, one order. Enforced by the database, not by application logic. */
  offerId: uuid("offer_id")
    .notNull()
    .unique()
    .references(() => offersTable.id),

  /** Razorpay's order id, once created. */
  railOrderId: varchar("rail_order_id", { length: 64 }).unique(),

  /**
   * Copied from the offer row at creation time. Present so a human can
   * reconcile our ledger against the rail; never an input to order creation,
   * which takes an offer id and nothing else (boundary rule B3).
   */
  amountMinor: integer("amount_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),

  /** What we believe. Overwritten by the rail whenever the two disagree. */
  localState: railStateEnum("local_state").notNull().default("CREATED"),
  /** What the rail last reported. Authoritative. */
  railState: railStateEnum("rail_state"),
  lastPolledAt: timestamp("last_polled_at"),

  /** Raw rail payload, kept for human reconciliation. */
  railPayload: jsonb("rail_payload").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
});

export type SelectOrder = typeof ordersTable.$inferSelect;
export type InsertOrder = typeof ordersTable.$inferInsert;
