import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { COMMITMENT_TYPES } from "@repo/policy/contracts";

/**
 * FROZEN SCHEMA — PRD.md §5, CONTRACTS.md §1.
 *
 * All money columns are integers in minor units (paise). No float, anywhere.
 * Enum values are imported from @repo/policy so the database cannot drift from
 * the frozen contract.
 */

export const commitmentTypeEnum = pgEnum("commitment_type", [...COMMITMENT_TYPES]);

export const merchantsTable = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
});

export const merchantPoliciesTable = pgTable("merchant_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchantsTable.id),

  /**
   * Kill switch. Exempt from the policy freeze (RA-1) — writable at any time,
   * including mid-negotiation, because it halts sessions rather than re-pricing
   * them and so cannot change an in-flight economic outcome.
   */
  negotiationEnabled: boolean("negotiation_enabled").notNull().default(true),

  /** Ceiling on lifetime dilutive (tier 2) spend. */
  campaignBudgetTotalMinor: integer("campaign_budget_total_minor").notNull(),
  /** Maximum dilution any single deal may consume. */
  perDealCapMinor: integer("per_deal_cap_minor").notNull(),

  maxRounds: integer("max_rounds").notNull().default(3),

  /**
   * Fraction of available floor-derived headroom released in round n.
   * RA-4: this IS the per-round envelope. There is no separate merchant-set
   * concession ceiling.
   */
  concessionCurve: jsonb("concession_curve").$type<number[]>().notNull(),

  /** Offer TTL, and therefore also the campaign hold TTL. */
  offerTtlSeconds: integer("offer_ttl_seconds").notNull().default(600),

  /**
   * Fixed at 0.03, deliberately not merchant-configurable. Stored so the
   * approved policy is fully self-describing, not so it can be tuned.
   */
  slowMovingTolerance: real("slow_moving_tolerance").notNull().default(0.03),

  /**
   * NOT permission to charge a buyer — a merchant cannot authorize spending
   * someone else's money.
   *
   * Means: this merchant's system is willing to ACCEPT an autonomous-payment
   * authorization presented by a buyer agent, in a future where such
   * authorizations exist. The grant lives buyer-side; the merchant only chooses
   * whether to honour it.
   *
   * MVP default false. The true branch exists in code and fails closed with
   * AUTONOMOUS_PAYMENT_NOT_AUTHORIZED; it never silently no-ops.
   */
  autonomousPaymentExecution: boolean("autonomous_payment_execution").notNull().default(false),

  /** Incremented on any policy change; pinned to a session at open. */
  policyVersion: integer("policy_version").notNull().default(1),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
});

/**
 * What each merchant-valued commitment is worth. Concessions are traded for
 * these; a concession given for nothing is unrepresentable.
 */
export const commitmentValuesTable = pgTable(
  "commitment_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchantsTable.id),
    commitmentType: commitmentTypeEnum("commitment_type").notNull(),
    valueMinor: integer("value_minor").notNull(),
  },
  (table) => [uniqueIndex("commitment_values_merchant_type_idx").on(table.merchantId, table.commitmentType)],
);

/**
 * Catalogue plus the per-SKU policy that governs it.
 *
 * DELIBERATELY ABSENT (PRD §5.4): max_discount_percent, min_profit_margin,
 * max_transaction_value, and COGS. Floors replace cost entirely — the merchant
 * never discloses what a product cost them.
 */
export const skuPoliciesTable = pgTable(
  "sku_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchantsTable.id),

    sku: varchar("sku", { length: 64 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),

    listPriceMinor: integer("list_price_minor").notNull(),
    /** The least the merchant would ever accept. Never disclosed to a buyer. */
    floorPriceMinor: integer("floor_price_minor").notNull(),

    /** False: may sit in a cart, may never carry a concession. */
    negotiable: boolean("negotiable").notNull().default(true),
    /** Merchant-side economic context. Not proactively disclosed to the buyer. */
    slowMoving: boolean("slow_moving").notNull().default(false),
    affinityGroup: text("affinity_group"),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("sku_policies_merchant_sku_idx").on(table.merchantId, table.sku)],
);

export type SelectMerchant = typeof merchantsTable.$inferSelect;
export type InsertMerchant = typeof merchantsTable.$inferInsert;
export type SelectMerchantPolicy = typeof merchantPoliciesTable.$inferSelect;
export type InsertMerchantPolicy = typeof merchantPoliciesTable.$inferInsert;
export type SelectCommitmentValue = typeof commitmentValuesTable.$inferSelect;
export type InsertCommitmentValue = typeof commitmentValuesTable.$inferInsert;
export type SelectSkuPolicy = typeof skuPoliciesTable.$inferSelect;
export type InsertSkuPolicy = typeof skuPoliciesTable.$inferInsert;
