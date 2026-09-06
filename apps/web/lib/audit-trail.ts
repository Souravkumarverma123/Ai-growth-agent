/**
 * TICKET-505 — Audit trail display (PRD §13.2, §8).
 *
 * The pure shaping layer between the ledger read API (`audit.getSessionLedger`
 * + `audit.verifyChain`) and the judge-facing audit screen. The chronological
 * row shaping is TICKET-502's (`lib/event-stream.ts`) — reused verbatim so the
 * two screens can never disagree about how an event reads. What this ticket
 * adds on top is audit-specific: the two figures a judge asks for first —
 * "is the chain intact?" and "how big was the space you searched?".
 *
 * Money stays in minor units here (CONTRACTS.md §3); the component formats.
 *
 * PRD §13.2: the reason code is THE justification and is surfaced raw. The
 * model explanation is carried through verbatim but always marked
 * non-authoritative, and the screen renders it in a visually separate block.
 */

import type { RouterOutputs } from "@repo/trpc/client";

import type { LedgerEvent } from "./event-stream";

export type { EventStreamRow, LedgerEvent, PayloadField } from "./event-stream";

/**
 * Chronological rows for the trail. The audit screen and the live stream
 * (TICKET-502) shape an event identically — same order, same payload
 * flattening, same raw reason code — so this is TICKET-502's shaper under
 * the audit-domain name, not a second implementation.
 */
export { toEventStreamRows as toAuditTrailRows } from "./event-stream";

export type ChainVerification = RouterOutputs["audit"]["verifyChain"];

// ---------------------------------------------------------------------------
// Chain verification indicator
// ---------------------------------------------------------------------------

export type ChainStatus = "verified" | "broken" | "empty";

export type ChainSummary = {
  status: ChainStatus;
  /** Short headline for the badge. */
  label: string;
  /** One sentence of detail under it. */
  detail: string;
  eventCount: number;
  /** Sequence number the chain first fails at, or `null` when it verifies. */
  brokenAtSequence: number | null;
  /**
   * Always true for this system, and deliberately surfaced: the chain is
   * self-anchored, so verification proves internal consistency, not
   * tamper-resistance against an attacker with database write access
   * (PRD §13.3 — "state this before a judge finds it").
   */
  selfAnchored: boolean;
};

const SELF_ANCHORED_NOTE =
  "Self-anchored chain — this proves the ledger is internally consistent, not that it is tamper-proof against database write access (PRD §13.3).";

export function summarizeChain(verification: ChainVerification): ChainSummary {
  const { valid, eventCount, brokenAtSequence, selfAnchored } = verification;

  if (eventCount === 0) {
    return {
      status: "empty",
      label: "No events yet",
      detail: "Nothing has been written to this session's ledger.",
      eventCount: 0,
      brokenAtSequence: null,
      selfAnchored,
    };
  }

  if (valid) {
    return {
      status: "verified",
      label: "Chain verified",
      detail: `All ${eventCount} event${eventCount === 1 ? "" : "s"} hash-chain cleanly from genesis. ${SELF_ANCHORED_NOTE}`,
      eventCount,
      brokenAtSequence: null,
      selfAnchored,
    };
  }

  return {
    status: "broken",
    label: "Chain broken",
    detail:
      brokenAtSequence === null
        ? `The hash chain does not verify across all ${eventCount} events. ${SELF_ANCHORED_NOTE}`
        : `The hash chain breaks at event #${brokenAtSequence}. ${SELF_ANCHORED_NOTE}`,
    eventCount,
    brokenAtSequence,
    selfAnchored,
  };
}

// ---------------------------------------------------------------------------
// Candidate counts (PRD §8: "The ledger records the counts — evaluated,
// feasible, Tier 1.")
// ---------------------------------------------------------------------------

export type CandidateCountKey = "evaluated" | "feasible" | "tier1";

export type CandidateCount = {
  key: CandidateCountKey;
  label: string;
  /** `null` when this count is not present in the recorded payload. */
  value: number | null;
};

export type CandidateCounts = {
  /** In display order: evaluated, feasible, Tier 1. */
  counts: CandidateCount[];
  /**
   * `full` — all three present. `partial` — the event carries some but not
   * all of them (the deployed engine records `evaluatedCount` and
   * `selfFundingCount` but not an explicit feasible count — see ISSUE-021).
   */
  completeness: "full" | "partial";
};

const CANDIDATE_COUNT_LABEL: Record<CandidateCountKey, string> = {
  evaluated: "Evaluated",
  feasible: "Feasible",
  tier1: "Tier 1",
};

/**
 * Key aliases, newest-name-first. The frozen `CANDIDATES_EVALUATED` payload
 * is a free-form record (`z.record`), and two shapes exist in the tree: the
 * worked-example / spec shape (`evaluated` / `feasible` / `tier1`) and the
 * deployed engine's `generateCandidates` counts (`evaluatedCount` /
 * `selfFundingCount`). Both are read here so the trail surfaces whatever was
 * actually written.
 */
const CANDIDATE_COUNT_ALIASES: Record<CandidateCountKey, readonly string[]> = {
  evaluated: ["evaluated", "evaluatedCount"],
  feasible: ["feasible", "feasibleCount"],
  tier1: ["tier1", "tier1Count", "selfFundingCount"],
};

function readCount(payload: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const key of aliases) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Pull the candidate counts out of the session's `CANDIDATES_EVALUATED`
 * event. Returns `null` when the session never got as far as generating
 * candidates. When the event exists but a count is missing, that count's
 * `value` is `null` and `completeness` is `"partial"`.
 */
export function extractCandidateCounts(
  events: readonly LedgerEvent[],
): CandidateCounts | null {
  const evaluatedEvent = events.find((event) => event.reasonCode === "CANDIDATES_EVALUATED");
  if (!evaluatedEvent) return null;

  const counts = (Object.keys(CANDIDATE_COUNT_ALIASES) as CandidateCountKey[]).map((key) => ({
    key,
    label: CANDIDATE_COUNT_LABEL[key],
    value: readCount(evaluatedEvent.payload, CANDIDATE_COUNT_ALIASES[key]),
  }));

  return {
    counts,
    completeness: counts.every((count) => count.value !== null) ? "full" : "partial",
  };
}
