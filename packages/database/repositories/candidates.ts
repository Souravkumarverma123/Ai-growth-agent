import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Candidate } from "@repo/policy/contracts";

import { candidatesTable } from "../models/negotiation";

/**
 * TICKET-204 — persists one round's engine-authored candidate set.
 *
 * `models/negotiation.ts`'s own doc on `candidatesTable` already states the
 * reason this exists: "Persisted rather than recomputed so that 'here is the
 * bounded space we searched' is a fact in the ledger rather than a claim."
 * No repository wrote to this table before this ticket — `generation/
 * candidates.ts` and `generation/tiering.ts` (both pure, `packages/policy`)
 * only ever produce the in-memory set; a database-backed caller (this
 * ticket) is what turns that set into rows.
 *
 * Every `Candidate` passed in must already carry its final `candidateId`
 * (== `candidateRef`), `sessionId` and `roundIndex` — assigning those is the
 * trpc route's job (deterministic `C1`, `C2`, ... per round, in generation
 * order), not this module's; this function only writes what it's given.
 *
 * Idempotent on `candidates_session_round_ref_idx` (session, round,
 * candidateRef): a client retry of `propose` — before the session's own
 * `roundIndex` has actually advanced past this round — recomputes and
 * re-persists the SAME round. `generation/candidates.ts`'s own determinism
 * guarantee (same input produces the identical set, every run) means that
 * second insert is byte-for-byte the same rows, so a conflict here is
 * semantically a no-op, never a real collision between two different
 * candidate sets. `onConflictDoNothing` makes that true at the database
 * level instead of letting the retry crash with an unrecoverable unique-
 * violation, which would otherwise strand the negotiation on this round.
 */
export async function persistCandidatesForRound(
  database: NodePgDatabase,
  candidates: readonly Candidate[],
): Promise<void> {
  if (candidates.length === 0) return;

  await database
    .insert(candidatesTable)
    .values(
      candidates.map((candidate) => ({
        candidateRef: candidate.candidateId,
        sessionId: candidate.sessionId,
        roundIndex: candidate.roundIndex,
        moveType: candidate.moveType,
        basket: candidate.basket,
        totalMinor: candidate.totalMinor,
        contributionMinor: candidate.contributionMinor,
        contributionDeltaMinor: candidate.contributionDeltaMinor,
        tier: candidate.tier,
        requiredCampaignSpendMinor: candidate.requiredCampaignSpendMinor,
        clearsSlowMoving: candidate.clearsSlowMoving,
        feasible: candidate.feasible,
        infeasibleReason: candidate.infeasibleReason,
      })),
    )
    .onConflictDoNothing({
      target: [candidatesTable.sessionId, candidatesTable.roundIndex, candidatesTable.candidateRef],
    });
}
