import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { negotiationSessionsTable, negotiationStateEnum, reasonCodeEnum } from "./negotiation";

/**
 * FROZEN SCHEMA — PRD.md §13, CONTRACTS.md §7.
 *
 * APPEND-ONLY. No update path and no delete path exists or may be written for
 * this table. Every state transition writes exactly one row carrying exactly
 * one reason code.
 *
 * This is also enforced in the database, not just in application code: see
 * migration 0002_audit_events_append_only.sql, which installs BEFORE
 * UPDATE/DELETE triggers on audit_events that reject any such statement
 * regardless of which role or client issues it.
 *
 * LIMITATION, STATED OPENLY: the hash chain is SELF-ANCHORED. An attacker with
 * enough privilege to disable/drop the triggers above and write access to this
 * database could rewrite the whole chain consistently and it would still
 * verify. External anchoring is an extension point, not an MVP claim — do not
 * overstate this in code, UI copy, or the demo.
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic within a session. Ordering is part of the evidence. */
    sequence: integer("sequence").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => negotiationSessionsTable.id),
    timestamp: timestamp("timestamp").notNull().defaultNow(),

    eventType: text("event_type").notNull(),
    fromState: negotiationStateEnum("from_state"),
    toState: negotiationStateEnum("to_state").notNull(),

    /**
     * THE JUSTIFICATION. Deterministic, authoritative, emitted by engine code,
     * consulted by decision paths. NOT NULL — a transition with no reason code
     * cannot be recorded, which is what makes "every money action is
     * explainable" a property rather than a promise.
     */
    reasonCode: reasonCodeEnum("reason_code").notNull(),

    /** Candidate counts, contribution figures, shortfall, hold movement. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),

    policyVersion: integer("policy_version"),
    offerId: uuid("offer_id"),
    campaignHoldId: uuid("campaign_hold_id"),
    campaignSpendMinor: integer("campaign_spend_minor"),

    /**
     * THE EXPLANATION. Human-readable, NON-AUTHORITATIVE, never read by any
     * decision path.
     *
     * A short final rationale only — one or two sentences (RA-5). NEVER
     * chain-of-thought, intermediate deliberation, or reasoning traces.
     *
     * If the model lies here, the explanation is wrong, the decision is still
     * correct, and the reason code above is what produced it.
     */
    modelExplanation: text("model_explanation"),

    prevHash: text("prev_hash"),
    eventHash: text("event_hash").notNull(),
  },
  (table) => [uniqueIndex("audit_events_session_sequence_idx").on(table.sessionId, table.sequence)],
);

export type SelectAuditEvent = typeof auditEventsTable.$inferSelect;
export type InsertAuditEvent = typeof auditEventsTable.$inferInsert;
