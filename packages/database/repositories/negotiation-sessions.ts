import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { NegotiationState } from "@repo/policy/contracts";

import { negotiationSessionsTable } from "../models/negotiation";
import type { SelectNegotiationSession } from "../models/negotiation";

/**
 * TICKET-204 — negotiation protocol procedures (PRD §18, CONTRACTS.md §9).
 *
 * The buyer-facing procedures are the first callers in this codebase that
 * need to read and advance a `negotiation_sessions` row outside of a test's
 * own direct `db.insert(negotiationSessionsTable)` — every ticket before this
 * one either built the pure engine (`packages/policy`) that takes session
 * state as a plain input, or wrote to a table that already had its own
 * repository (`offers.ts`, `campaign-holds.ts`, `audit-events.ts`,
 * `merchant-policies.ts`). This module is that missing, thin read/update
 * layer — no business logic, same discipline as every other file here: a
 * caller (the trpc procedure) decides *why* a transition is happening and
 * supplies the resulting `state`/`roundIndex`/`tier1Refused`, this module
 * only persists it.
 *
 * `eligibility/eligibility.ts`'s own module doc is explicit that no upstream
 * cart-risk-flagging system exists yet in this codebase ("there is no live
 * signal source for cart inactivity, exit-intent, cart age, cart value, or
 * first-time-buyer today"). Consistent with that, this module exports no
 * "create a flagged session" function — a session's `state` starts at the
 * frozen schema's own default (`"IDLE"`) and only becomes `"AT_RISK"` via
 * whatever upstream system eventually flags it (out of scope here, exactly
 * as it was out of scope for TICKET-101). Tests exercise both paths by
 * inserting a `negotiation_sessions` row directly with `state: "IDLE"` or
 * `state: "AT_RISK"`, mirroring how `merchant-policy-approval.test.ts`
 * inserts its own merchant/policy rows directly rather than through a
 * "create" repository function that doesn't exist either.
 */

export async function getNegotiationSession(
  database: NodePgDatabase,
  sessionId: string,
): Promise<SelectNegotiationSession | undefined> {
  const [session] = await database
    .select()
    .from(negotiationSessionsTable)
    .where(eq(negotiationSessionsTable.id, sessionId));
  return session;
}

export type NegotiationSessionPatch = Partial<{
  state: NegotiationState;
  roundIndex: number;
  tier1Refused: boolean;
}>;

/**
 * Plain conditional `UPDATE`, same discipline as `setNegotiationEnabled`
 * (`merchant-policies.ts`): no row lock. `appendAuditEvent`
 * (`audit-events.ts`) already takes its own lock on this exact row for the
 * ledger sequence it writes alongside every call site below, so a session's
 * `state`/`roundIndex`/`tier1Refused` fields are never updated without an
 * accompanying, correctly-ordered ledger entry — but the two writes are not
 * one atomic transaction in this module. Acceptable for the MVP: unlike
 * `campaign_holds` (money) or `audit_events` (the evidentiary chain itself),
 * a lost or double-applied session-field update has no money-safety
 * consequence in the current single-caller-per-negotiation demo shape.
 */
export async function updateNegotiationSession(
  database: NodePgDatabase,
  sessionId: string,
  patch: NegotiationSessionPatch,
): Promise<SelectNegotiationSession | undefined> {
  if (Object.keys(patch).length === 0) {
    return getNegotiationSession(database, sessionId);
  }
  const [updated] = await database
    .update(negotiationSessionsTable)
    .set(patch)
    .where(eq(negotiationSessionsTable.id, sessionId))
    .returning();
  return updated;
}
