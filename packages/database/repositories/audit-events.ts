import { asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { computeEventHash } from "@repo/policy";
import type { NegotiationEvent, NegotiationState, ReasonCode } from "@repo/policy/contracts";

import { auditEventsTable, negotiationSessionsTable } from "../schema";
import type { SelectAuditEvent } from "../models/audit";

/**
 * TICKET-401 — append-only ledger writer with hash chaining (PRD §13,
 * CONTRACTS.md §7).
 *
 * The frozen schema (`packages/database/models/audit.ts`, TICKET-005) and its
 * migration (`0002_audit_events_append_only.sql`) already make "no update, no
 * delete" a database-level fact: `BEFORE UPDATE`/`BEFORE DELETE` triggers on
 * `audit_events` reject any such statement outright, regardless of role. This
 * module is the other half — the module-surface promise on top of that
 * enforcement: **only an append function and read functions are exported
 * here. No update or delete function exists in this file, and none may be
 * added** (that is the acceptance criterion).
 *
 * The actual hash computation is `@repo/policy`'s `computeEventHash`
 * (`packages/policy/ledger/hash-chain.ts`) — pure, no I/O (CONTRACTS.md §2,
 * §8). This module's only job is the I/O around it: find the previous event
 * for this session (if any), feed its `eventHash` in as this event's
 * `prevHash`, compute this event's own `eventHash`, and insert.
 *
 * Same lock discipline as `reserveCampaignBudget`
 * (`packages/database/repositories/campaign-holds.ts`, ISSUE-004): appends
 * for a session must serialize on the sequence/prevHash read-then-write, or
 * two concurrent appends for the same session could both see "no successor
 * yet" and race to insert the same next `sequence` (the unique index on
 * `(session_id, sequence)` would catch that as a constraint violation, but
 * failing loudly on a race is worse than not racing at all). `negotiation_sessions`
 * already has exactly one row per session and already exists before any audit
 * event can reference it (the FK requires it), so — exactly like
 * `merchant_policies` in campaign-holds.ts — it is the natural row to lock:
 * `SELECT ... FOR UPDATE` on this session's row blocks any concurrent append
 * for the *same* session until this transaction commits, while appends for
 * *different* sessions never contend with each other.
 */

export type AppendAuditEventParams = {
  sessionId: string;
  eventType: NegotiationEvent;
  fromState: NegotiationState | null;
  toState: NegotiationState;
  reasonCode: ReasonCode;
  /** Candidate counts, contribution figures, shortfall, hold movement — whatever this transition's evidence is. */
  payload: Record<string, unknown>;
  policyVersion?: number | null;
  offerId?: string | null;
  campaignHoldId?: string | null;
  campaignSpendMinor?: number | null;
  /** THE EXPLANATION, non-authoritative (CONTRACTS.md §7) — a short final rationale only, never a reasoning trace (RA-5). */
  modelExplanation?: string | null;
};

/**
 * Appends exactly one event to a session's ledger: reads the last event for
 * this session (if any) to derive the next `sequence` and this event's
 * `prevHash`, computes `eventHash` via `@repo/policy`'s pure hashing
 * function, and inserts. Genesis (the first event for a session) is handled
 * explicitly — no predecessor, so `sequence` starts at `0` and `prevHash` is
 * `null`.
 *
 * This is the ONLY write function this module exports. There is no update or
 * delete function here, and the database triggers would reject one anyway.
 */
export async function appendAuditEvent(
  database: NodePgDatabase,
  params: AppendAuditEventParams,
): Promise<SelectAuditEvent> {
  return database.transaction(async (tx) => {
    // Lock this session's row so two concurrent appends for the same session
    // serialize on the sequence/prevHash read below, rather than both reading
    // "no predecessor yet" and racing to insert the same next sequence.
    // Appends for different sessions never contend — this only locks one row.
    await tx
      .select({ id: negotiationSessionsTable.id })
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, params.sessionId))
      .for("update");

    const [lastEvent] = await tx
      .select({ sequence: auditEventsTable.sequence, eventHash: auditEventsTable.eventHash })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.sessionId, params.sessionId))
      .orderBy(desc(auditEventsTable.sequence))
      .limit(1);

    const sequence = lastEvent ? lastEvent.sequence + 1 : 0;
    const prevHash = lastEvent ? lastEvent.eventHash : null;

    const eventHash = computeEventHash({
      sequence,
      sessionId: params.sessionId,
      eventType: params.eventType,
      fromState: params.fromState,
      toState: params.toState,
      reasonCode: params.reasonCode,
      payload: params.payload,
      prevHash,
    });

    const [inserted] = await tx
      .insert(auditEventsTable)
      .values({
        sequence,
        sessionId: params.sessionId,
        eventType: params.eventType,
        fromState: params.fromState,
        toState: params.toState,
        reasonCode: params.reasonCode,
        payload: params.payload,
        policyVersion: params.policyVersion ?? null,
        offerId: params.offerId ?? null,
        campaignHoldId: params.campaignHoldId ?? null,
        campaignSpendMinor: params.campaignSpendMinor ?? null,
        modelExplanation: params.modelExplanation ?? null,
        prevHash,
        eventHash,
      })
      .returning();

    return inserted!;
  });
}

/**
 * Reads every event for a session, in sequence order — the input
 * `@repo/policy`'s `verifyChain` expects. A read function, not a mutation:
 * exporting this does not violate "no update or delete function is exported
 * from the ledger module."
 */
export async function getAuditEventsForSession(
  database: NodePgDatabase,
  sessionId: string,
): Promise<SelectAuditEvent[]> {
  return database
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.sessionId, sessionId))
    .orderBy(asc(auditEventsTable.sequence));
}
