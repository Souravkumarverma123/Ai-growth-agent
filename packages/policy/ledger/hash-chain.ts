import { createHash } from "node:crypto";

import { HASHED_FIELDS, type AuditEvent } from "../contracts/audit";

/**
 * TICKET-401 — append-only ledger writer with hash chaining (PRD §13,
 * CONTRACTS.md §7).
 *
 * Pure, no I/O (CONTRACTS.md §2, §8): this module never touches a database.
 * The append path that actually reads/writes rows lives in
 * `packages/database/repositories/audit-events.ts`, and calls
 * `computeEventHash` from here to fill in `eventHash` before inserting.
 *
 * The frozen contract at `../contracts/audit.ts` already fixes *which* fields
 * are hashed and in what order — `HASHED_FIELDS`
 * (`sequence, sessionId, eventType, fromState, toState, reasonCode, payload,
 * prevHash`). Notably absent: `timestamp` (non-deterministic — hashing it
 * would make the same logical event produce a different hash depending on
 * when it happened to be inserted), `modelExplanation` (non-authoritative
 * prose, never consulted by any decision path — CONTRACTS.md §7), and the
 * event's own `eventId`/`eventHash` (hashing a field that includes itself is
 * circular). `policyVersion`, `offerId`, `campaignHoldId`, and
 * `campaignSpendMinor` are likewise not hashed — they are metadata about the
 * event, not the decision content the ledger exists to make tamper-evident.
 * A caller wanting those covered too would need a contract change (frozen —
 * CONTRACTS.md §1), not a change here.
 */

/** The exact fields the hash covers, typed from the frozen `AuditEvent` contract. */
export type HashableAuditEvent = Pick<AuditEvent, (typeof HASHED_FIELDS)[number]>;

/**
 * Deterministically orders object keys (recursively) before serialization, so
 * that two logically-identical events never hash differently just because
 * `payload`'s keys were built or iterated in a different order. `undefined`
 * and `null` both collapse to `null`, and a `Date` (defensive — none of the
 * hashed fields are dates today, but `payload` is caller-supplied) becomes its
 * ISO string, so hashing never depends on a value's runtime representation.
 */
function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Object.create(null): a plain `{}` inherits Object.prototype's `__proto__`
    // accessor, so `sorted[key] = ...` for key === "__proto__" would set the
    // prototype instead of creating a serializable own property, silently
    // dropping that field from the hash input.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Computes an event's `eventHash` from its own content fields plus the
 * `prevHash` linking it to its predecessor (`prevHash` is itself one of
 * `HASHED_FIELDS`, so it is folded into the same serialization rather than
 * concatenated separately). Deterministic: the same field values always
 * produce the same hash, because the only inputs are the event's own stored
 * fields, serialized with an explicit, fixed field order
 * (`HASHED_FIELDS`) and recursively sorted object keys — never
 * `Date.now()`, a random id, or anything else that could differ between two
 * calls describing the same event.
 */
export function computeEventHash(event: HashableAuditEvent): string {
  const canonicalPayload: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    canonicalPayload[field] = canonicalize(event[field]);
  }
  const serialized = JSON.stringify(canonicalPayload);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/** An event as read for verification: its hashable content plus the hash it stores. */
export type ChainEvent = Pick<AuditEvent, (typeof HASHED_FIELDS)[number] | "eventHash">;

export type ChainBreakReason =
  /** A sequence value wasn't exactly one more than the previous event's. */
  | "SEQUENCE_GAP"
  /** This event's `prevHash` doesn't match its predecessor's `eventHash` (or genesis has a non-null `prevHash`). */
  | "BROKEN_LINKAGE"
  /** Recomputing the hash from the event's own stored fields doesn't match its stored `eventHash` — its content was altered after it was written. */
  | "HASH_MISMATCH";

export type ChainVerificationResult =
  | { valid: true; eventCount: number }
  | {
      valid: false;
      eventCount: number;
      /** Position in the array passed to `verifyChain`, not the database row id. */
      brokenAtIndex: number;
      brokenAtSequence: number;
      reason: ChainBreakReason;
      /** Human-readable, for logs and the audit-trail UI — never parsed by decision code. */
      detail: string;
    };

/**
 * Recomputes each event's expected hash from its own fields and checks it
 * links to its predecessor, over an already-fetched, already-sequence-ordered
 * list of events for one session. Reports exactly where the chain breaks and
 * why, rather than a bare boolean — "tampering breaks verification" is only
 * useful for an audit trail if it also says which event and what kind of
 * break.
 *
 * Needs no database: `events` may come from a real read, or (as in the
 * tamper-detection test) an in-memory array a test has deliberately mutated.
 * An empty list is vacuously a valid (empty) chain.
 */
export function verifyChain(events: readonly ChainEvent[]): ChainVerificationResult {
  if (events.length === 0) {
    return { valid: true, eventCount: 0 };
  }

  const genesisSequence = 0;

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const expectedSequence = genesisSequence + index;

    if (event.sequence !== expectedSequence) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAtIndex: index,
        brokenAtSequence: event.sequence,
        reason: "SEQUENCE_GAP",
        detail:
          `expected sequence ${expectedSequence} at position ${index} of the chain, ` +
          `found ${event.sequence} — a gap or duplicate in the sequence`,
      };
    }

    const predecessor = index === 0 ? null : events[index - 1]!;
    const expectedPrevHash = predecessor ? predecessor.eventHash : null;

    if (event.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAtIndex: index,
        brokenAtSequence: event.sequence,
        reason: "BROKEN_LINKAGE",
        detail: predecessor
          ? `event at sequence ${event.sequence} carries prevHash ${String(event.prevHash)}, ` +
            `but its predecessor (sequence ${predecessor.sequence}) has eventHash ` +
            `${predecessor.eventHash} — the chain does not link`
          : `the genesis event (sequence ${event.sequence}, no predecessor) must carry a ` +
            `null prevHash, found ${String(event.prevHash)}`,
      };
    }

    const expectedHash = computeEventHash(event);
    if (event.eventHash !== expectedHash) {
      return {
        valid: false,
        eventCount: events.length,
        brokenAtIndex: index,
        brokenAtSequence: event.sequence,
        reason: "HASH_MISMATCH",
        detail:
          `event at sequence ${event.sequence} stores eventHash ${event.eventHash}, but ` +
          `recomputing from its own stored fields yields ${expectedHash} — its content was ` +
          `altered after it was written`,
      };
    }
  }

  return { valid: true, eventCount: events.length };
}
