import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  CAMPAIGN_HOLD_STATES,
  OFFER_STATUSES,
  type Basket,
} from "@repo/policy/contracts";

import { merchantsTable } from "./merchant";
import { negotiationSessionsTable, reasonCodeEnum } from "./negotiation";

/**
 * FROZEN SCHEMA — PRD.md §10, §6.5.
 *
 * The offer is the only object in this system that can become money. It is
 * minted by the policy engine and by nothing else.
 */

export const offerStatusEnum = pgEnum("offer_status", [...OFFER_STATUSES]);
export const campaignHoldStateEnum = pgEnum("campaign_hold_state", [...CAMPAIGN_HOLD_STATES]);

export const offersTable = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => negotiationSessionsTable.id),
  candidateRef: varchar("candidate_ref", { length: 64 }).notNull(),
  roundIndex: integer("round_index").notNull(),

  /** Exact basket. Any deviation at accept time is a BASKET_MISMATCH. */
  basket: jsonb("basket").$type<Basket>().notNull(),

  /**
   * THE AUTHORIZED AMOUNT. The payment path reads it from this column and from
   * nowhere else — never from a caller, never from model output.
   */
  totalMinor: integer("total_minor").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("INR"),

  tier: integer("tier").notNull(),
  /** Exact contribution shortfall. Zero for tier 1. */
  campaignSpendMinor: integer("campaign_spend_minor").notNull().default(0),

  policyVersion: integer("policy_version").notNull(),
  status: offerStatusEnum("status").notNull().default("PENDING"),
  /** The code emitted when this offer was minted. */
  reasonCode: reasonCodeEnum("reason_code").notNull(),

  expiresAt: timestamp("expires_at").notNull(),
  /** Set exactly once. Single-use is enforced here, transactionally. */
  consumedAt: timestamp("consumed_at"),

  /** Signed by the engine. The signing path is unreachable from @repo/agent. */
  engineSignature: text("engine_signature").notNull(),

  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * Campaign budget is never simply decremented — it moves through three states,
 * so that an agent minting offers it never pays for cannot drain the pool, and
 * two concurrent negotiations cannot jointly overspend.
 *
 * available = total - reserved - committed. Caps are checked against available.
 */
export const campaignHoldsTable = pgTable("campaign_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchantsTable.id),
  /** One hold per offer. Tier 1 offers create none. */
  offerId: uuid("offer_id")
    .notNull()
    .unique()
    .references(() => offersTable.id),

  amountMinor: integer("amount_minor").notNull(),
  state: campaignHoldStateEnum("state").notNull().default("RESERVED"),
  /** Equals the offer TTL. An abandoned offer returns its budget on expiry. */
  expiresAt: timestamp("expires_at").notNull(),
  resolvedAt: timestamp("resolved_at"),

  createdAt: timestamp("created_at").defaultNow(),
});

export type SelectOffer = typeof offersTable.$inferSelect;
export type InsertOffer = typeof offersTable.$inferInsert;
export type SelectCampaignHold = typeof campaignHoldsTable.$inferSelect;
export type InsertCampaignHold = typeof campaignHoldsTable.$inferInsert;
