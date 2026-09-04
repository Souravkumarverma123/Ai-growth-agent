import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  CANDIDATE_MOVE_TYPES,
  NEGOTIATION_STATES,
  REASON_CODES,
  type Basket,
} from "@repo/policy/contracts";

import { merchantsTable } from "./merchant";

/**
 * FROZEN SCHEMA — PRD.md §6, §8, §15.
 *
 * Enum values come from @repo/policy so the database cannot drift from the
 * frozen contract.
 */

export const negotiationStateEnum = pgEnum("negotiation_state", [...NEGOTIATION_STATES]);
export const candidateMoveTypeEnum = pgEnum("candidate_move_type", [...CANDIDATE_MOVE_TYPES]);
export const reasonCodeEnum = pgEnum("reason_code", [...REASON_CODES]);

export const negotiationSessionsTable = pgTable("negotiation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id")
    .notNull()
    .references(() => merchantsTable.id),

  /**
   * Who is negotiating. Identity verification is a named no-op in the MVP —
   * the seam exists so authentication drops in without reshaping this table.
   */
  buyerAgentId: varchar("buyer_agent_id", { length: 128 }).notNull(),

  state: negotiationStateEnum("state").notNull().default("IDLE"),
  /** Compared against policy.maxRounds. */
  roundIndex: integer("round_index").notNull().default(0),

  /**
   * Set by ONE refusal of the engine's best tier 1 candidate (RA-2). Tier 2
   * candidates stay locked until this is true — a rescue is only reachable
   * after the buyer declines a demonstrably better-for-both alternative.
   */
  tier1Refused: boolean("tier1_refused").notNull().default(false),

  /** Pinned at open. Every policy field except the kill switch is frozen here. */
  policyVersion: integer("policy_version").notNull(),

  /** The cart as it stood when the session was flagged. The counterfactual. */
  originalBasket: jsonb("original_basket").$type<Basket>().notNull(),
  /**
   * Contribution of originalBasket at list. Every candidate is judged against
   * this, and against nothing else — not zero, and not a predicted conversion
   * probability.
   */
  counterfactualContributionMinor: integer("counterfactual_contribution_minor").notNull(),

  /** Why this session became eligible. Merchant-side signals only. */
  eligibilitySignals: jsonb("eligibility_signals").$type<Record<string, unknown>>(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").$onUpdate(() => new Date()),
});

/**
 * Engine-authored options. The model selects one by id; it never authors a
 * basket or an amount.
 *
 * Persisted rather than recomputed so that "here is the bounded space we
 * searched" is a fact in the ledger rather than a claim.
 */
export const candidatesTable = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable within a round; this is what NegotiationIntent references. */
    candidateRef: varchar("candidate_ref", { length: 64 }).notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => negotiationSessionsTable.id),
    roundIndex: integer("round_index").notNull(),

    moveType: candidateMoveTypeEnum("move_type").notNull(),
    basket: jsonb("basket").$type<Basket>().notNull(),
    totalMinor: integer("total_minor").notNull(),

    /** Headroom above floor. Not margin — floors replace COGS. */
    contributionMinor: integer("contribution_minor").notNull(),
    /** Signed: negative exactly when the candidate is dilutive. */
    contributionDeltaMinor: integer("contribution_delta_minor").notNull(),

    /** Derived arithmetically. Never asserted by a caller. */
    tier: integer("tier").notNull(),
    /** Campaign budget this would consume. Always 0 for tier 1. */
    requiredCampaignSpendMinor: integer("required_campaign_spend_minor").notNull().default(0),

    /** Feeds the 3% slow-moving tolerance band. */
    clearsSlowMoving: boolean("clears_slow_moving").notNull().default(false),
    feasible: boolean("feasible").notNull(),
    infeasibleReason: reasonCodeEnum("infeasible_reason"),

    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    uniqueIndex("candidates_session_round_ref_idx").on(
      table.sessionId,
      table.roundIndex,
      table.candidateRef,
    ),
  ],
);

export type SelectNegotiationSession = typeof negotiationSessionsTable.$inferSelect;
export type InsertNegotiationSession = typeof negotiationSessionsTable.$inferInsert;
export type SelectCandidate = typeof candidatesTable.$inferSelect;
export type InsertCandidate = typeof candidatesTable.$inferInsert;
