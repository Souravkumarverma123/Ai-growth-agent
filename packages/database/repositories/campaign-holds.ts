import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { NegotiationEvent, NegotiationState, ReasonCode } from "@repo/policy/contracts";

import type { SelectCampaignHold } from "../models/offer";
import { appendAuditEvent } from "./audit-events";

/**
 * TICKET-107 — atomic campaign-budget reservation (PRD §6.5, CONTRACTS.md §8).
 *
 * `available = total − reserved − committed` (the comment above
 * `campaignHoldsTable` in `models/offer.ts`). `reserved` and `committed` are
 * never stored as columns — frozen schema (CONTRACTS.md §1) forbids adding
 * one — they are derived by summing `campaign_holds.amount_minor` for the
 * merchant across the RESERVED and COMMITTED states every time this runs.
 *
 * "Reservation is an atomic conditional decrement under a row lock — not
 * read, then check, then write" (PRD §6.5).
 *
 * ISSUE-004: the initially-attempted design — one single `WITH ... FOR
 * UPDATE, outstanding AS (...), INSERT ... SELECT ... WHERE ...` CTE
 * statement — was measured, under this ticket's own real-concurrency test,
 * to be UNSAFE: it over-admitted (18 of 20 reservations succeeded against a
 * budget sized for exactly 10). Root cause: PostgreSQL fixes one MVCC
 * snapshot per *statement* at read-committed level. `FOR UPDATE`'s wait-then-
 * recheck behaviour (EvalPlanQual) only refreshes the specific locked row
 * (`merchant_policies`); the sibling "outstanding" CTE, reading the
 * unrelated `campaign_holds` table in the same statement, keeps using the
 * *original* pre-wait snapshot — so it can miss holds committed by other
 * transactions while we were blocked waiting for the lock. See
 * issue-tracker.md ISSUE-004 for the full account.
 *
 * The safe replacement below still satisfies "not read, then check, then
 * write" in the sense that matters — no other transaction can observe or
 * mutate this merchant's outstanding holds between the read and the write —
 * but does it with three sequential statements inside **one database
 * transaction**, not one SQL statement:
 *
 *   1. `SELECT campaign_budget_total_minor FROM merchant_policies WHERE
 *      merchant_id = $1 FOR UPDATE` — blocks until any other transaction
 *      reserving for this merchant commits and releases the same row lock.
 *   2. A **fresh** statement summing `campaign_holds` for RESERVED/COMMITTED
 *      states. Because it is a new statement, read-committed gives it a
 *      new snapshot taken *after* step 1 acquired the lock — and since every
 *      other reservation attempt for this merchant must also pass through
 *      step 1's lock before it can insert anything, nothing in flight can be
 *      invisible here: a concurrent attempt has either already committed
 *      (and this read sees it) or is still blocked on step 1 (and cannot
 *      have inserted anything yet).
 *   3. A conditional `INSERT` in application code, still inside the same
 *      transaction and therefore still holding the row lock, so nothing can
 *      interleave between the read in step 2 and this write.
 *
 * Deliberately generic over the drizzle client (`NodePgDatabase`, not the
 * real exported `db`) so this can run against `getTestDb()` in tests and the
 * real `db` in production without a code fork.
 *
 * TICKET-403 — every transition below now pairs its `campaign_holds` write
 * with exactly one ledger append (`appendAuditEvent`,
 * `packages/database/repositories/audit-events.ts`, TICKET-401), inside the
 * SAME transaction, so a hold state change and its ledger entry always commit
 * or roll back together (PRD §6.5, §13.1).
 *
 * Ambiguity worth recording (see issue-tracker.md and this ticket's PR
 * description): which exact `eventType` / `fromState` / `toState` /
 * `reasonCode` applies to a given call depends on WHY it's happening (a
 * reservation firing mid-`OFFER_PENDING`, a release from a buyer decline vs.
 * TTL expiry vs. payment failure, a commit on payment capture) — something
 * only the caller knows, since no session-orchestration layer exists yet to
 * resolve it automatically. The fix taken here mirrors how `appendAuditEvent`
 * itself already takes these as plain params rather than deriving them: each
 * function below now also takes a `ledger: CampaignHoldLedgerContext` — the
 * caller supplies the exact transition/reason for the ledger entry, and this
 * module stays dumb about the session state machine. `sessionId`,
 * `campaignHoldId` and `campaignSpendMinor` are always taken from the hold row
 * itself (never from the caller) so the amount in the ledger can never drift
 * from the amount actually moved.
 */

/**
 * What the caller supplies so this module can append the correct ledger event
 * alongside a hold's state change, without this module having to know *why*
 * the transition is happening (TICKET-403 — see module comment above).
 * `campaignHoldId`, `campaignSpendMinor` and `offerId` are deliberately NOT
 * part of this type: they always come from the hold row this call resolves,
 * never from the caller, so the ledger amount can never diverge from the
 * hold's actual `amount_minor`.
 */
export type CampaignHoldLedgerContext = {
  /** The negotiation session this hold's ledger event belongs to. */
  sessionId: string;
  eventType: NegotiationEvent;
  fromState: NegotiationState | null;
  toState: NegotiationState;
  reasonCode: ReasonCode;
  /** Extra evidence beyond hold id/amount (which this module always adds). */
  payload?: Record<string, unknown>;
  policyVersion?: number | null;
  /** THE EXPLANATION, non-authoritative — see `appendAuditEvent`'s own doc. */
  modelExplanation?: string | null;
};

async function appendHoldLedgerEvent(
  tx: NodePgDatabase,
  ledger: CampaignHoldLedgerContext,
  hold: CampaignHoldRow,
): Promise<void> {
  await appendAuditEvent(tx, {
    sessionId: ledger.sessionId,
    eventType: ledger.eventType,
    fromState: ledger.fromState,
    toState: ledger.toState,
    reasonCode: ledger.reasonCode,
    payload: {
      ...ledger.payload,
      holdId: hold.id,
      amountMinor: hold.amount_minor,
    },
    policyVersion: ledger.policyVersion ?? null,
    offerId: hold.offer_id,
    campaignHoldId: hold.id,
    campaignSpendMinor: hold.amount_minor,
    modelExplanation: ledger.modelExplanation ?? null,
  });
}

export type ReserveCampaignBudgetParams = {
  merchantId: string;
  offerId: string;
  amountMinor: number;
  expiresAt: Date;
  /** TICKET-403 — the ledger entry to append alongside this reservation. */
  ledger: CampaignHoldLedgerContext;
};

export type ReserveCampaignBudgetResult =
  | { reserved: true; hold: SelectCampaignHold }
  | { reserved: false; reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };

type CampaignHoldRow = {
  id: string;
  merchant_id: string;
  offer_id: string;
  amount_minor: number;
  state: SelectCampaignHold["state"];
  expires_at: Date;
  resolved_at: Date | null;
  created_at: Date | null;
};

function toSelectCampaignHold(row: CampaignHoldRow): SelectCampaignHold {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    offerId: row.offer_id,
    amountMinor: row.amount_minor,
    state: row.state,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/**
 * Attempts to reserve `amountMinor` of campaign budget for `merchantId`
 * against `offerId`. Returns the inserted hold row on success, or
 * `CAMPAIGN_BUDGET_EXHAUSTED` if the amount doesn't fit within `available`
 * once every concurrent reservation for this merchant has been forced to
 * serialize on the `merchant_policies` row lock (see the module comment for
 * why this needs three statements in one transaction, not one).
 *
 * Callers are expected to run the per-deal-cap check
 * (`@repo/policy` `evaluatePerDealCap`) first — that check is a fixed
 * ceiling on `amountMinor` alone and needs no database, so it should never
 * reach this function if it fails (PRD §17 row 3: a shortfall over the
 * per-deal cap walks away without ever touching campaign budget). That check
 * only bounds `amountMinor` from above, so this function still validates it
 * is a positive integer itself before opening a transaction: a non-positive
 * or non-integer value must never reach the comparison at step 2 or the
 * `INSERT` at step 3, since a negative amount would inflate `available` for
 * later callers and a zero amount would consume this offer's one hold slot
 * without reserving any real funds.
 */
export async function reserveCampaignBudget(
  database: NodePgDatabase,
  params: ReserveCampaignBudgetParams,
): Promise<ReserveCampaignBudgetResult> {
  const { merchantId, offerId, amountMinor, expiresAt } = params;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(
      `reserveCampaignBudget: amountMinor must be a positive integer (${amountMinor})`,
    );
  }

  return database.transaction(async (tx): Promise<ReserveCampaignBudgetResult> => {
    // Step 1: lock this merchant's policy row. Blocks until any other
    // in-flight reservation for the same merchant commits and releases it.
    const policyResult = await tx.execute<{ campaign_budget_total_minor: number }>(sql`
      SELECT campaign_budget_total_minor
      FROM merchant_policies
      WHERE merchant_id = ${merchantId}
      FOR UPDATE
    `);

    const policyRow = policyResult.rows[0];
    if (!policyRow) {
      return { reserved: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };
    }

    // Step 2: a fresh statement, so read-committed hands it a fresh
    // snapshot taken only now — after we hold the lock from step 1. Every
    // other concurrent reservation attempt for this merchant is either
    // already committed (and counted here) or still blocked on step 1 (and
    // therefore cannot have inserted anything yet). Never stale.
    //
    // A RESERVED hold past its expires_at is excluded here even though
    // nothing has flipped its state to RELEASED: the session-level
    // orchestration that would call `releaseCampaignHold` on TTL elapse
    // doesn't exist yet (see the TICKET-108 module comment below), and
    // `campaignHoldsTable.expiresAt`'s own doc comment ("An abandoned offer
    // returns its budget on expiry") is a hold-visible invariant, not
    // something that may wait on that orchestration landing. Without this,
    // an abandoned offer's hold would count against budget forever.
    // COMMITTED holds have no such carve-out — they're a permanent spend,
    // not a provisional one, and are never time-limited.
    const outstandingResult = await tx.execute<{ outstanding_minor: string }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0) AS outstanding_minor
      FROM campaign_holds
      WHERE merchant_id = ${merchantId}
        AND (
          state = 'COMMITTED'
          OR (state = 'RESERVED' AND expires_at > now())
        )
    `);

    const outstandingMinor = Number(outstandingResult.rows[0]?.outstanding_minor ?? 0);
    const availableMinor = policyRow.campaign_budget_total_minor - outstandingMinor;

    if (amountMinor > availableMinor) {
      return { reserved: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" };
    }

    // Step 3: still inside the same transaction, still holding the lock
    // from step 1 — nothing could have interleaved since step 2's read.
    const insertResult = await tx.execute<CampaignHoldRow>(sql`
      INSERT INTO campaign_holds (merchant_id, offer_id, amount_minor, state, expires_at)
      VALUES (${merchantId}, ${offerId}, ${amountMinor}, 'RESERVED', ${expiresAt})
      RETURNING
        id,
        merchant_id,
        offer_id,
        amount_minor,
        state,
        expires_at,
        resolved_at,
        created_at
    `);

    const row = insertResult.rows[0]!;

    // TICKET-403 — same tx as the insert above: the hold write and its
    // ledger entry commit or roll back together.
    await appendHoldLedgerEvent(tx, params.ledger, row);

    return { reserved: true, hold: toSelectCampaignHold(row) };
  });
}

/**
 * TICKET-108 — the other two transitions out of `RESERVED` (PRD §6.5,
 * CONTRACTS.md §8). Reservation (`RESERVED`) is TICKET-107's job, built
 * above; this is release (`-> RELEASED`) and commit (`-> COMMITTED`).
 *
 * Reading `packages/policy/contracts/state-machine.ts` resolves an ambiguity
 * in the ticket text: "released on expiry, decline, or payment failure"
 * reads as if each cause might need its own reason code, but the frozen
 * transition table shows every hold release — regardless of which of the
 * three real-world causes triggered it — is its own self-loop transition
 * carrying exactly `HOLD_RELEASED` (`EXPIRED --HOLD_RELEASED--> EXPIRED`,
 * `PAYMENT_FAILED --HOLD_RELEASED--> PAYMENT_FAILED`, and the tier-2 decline
 * path `OFFER_PENDING --BUYER_DECLINES--> OPEN` also carrying
 * `HOLD_RELEASED`). Likewise every commit carries exactly `HOLD_COMMITTED`
 * (`SETTLED --HOLD_COMMITTED--> SETTLED`). The cause-specific codes
 * (`OFFER_EXPIRED`, `PAYMENT_FAILED`, `PAYMENT_CAPTURED`) belong to the
 * *session* state machine's own transitions — orchestration that doesn't
 * exist yet in this codebase and is not this ticket's job. So one generic
 * release function and one generic commit function suffice: the caller
 * decides *why* it's releasing or committing: the database doesn't need to
 * know, and no "reason" parameter is invented here.
 *
 * Each is, on its own, a single self-contained conditional `UPDATE ... WHERE
 * state = 'RESERVED'`. Unlike `reserveCampaignBudget`, resolving the row needs
 * no row-lock-plus-separate-statement pattern (ISSUE-004 doesn't apply):
 * there is no unrelated-table aggregate computed inside that statement, just
 * a conditional update of the one row being transitioned. Postgres's
 * row-level MVCC makes that update atomic under concurrency on its own — two
 * racing callers resolving the same hold serialize at the row: the first to
 * commit wins, and the second's `WHERE state = 'RESERVED'` is re-evaluated
 * against the now-changed row, matches nothing, and updates zero rows. That
 * is verified directly by this ticket's concurrency test, not merely
 * asserted.
 *
 * TICKET-403 wraps that update in a transaction now (where before it was a
 * single bare statement) purely so it can share that transaction with the
 * ledger append that must commit or roll back atomically alongside it — the
 * concurrency argument above is about the `UPDATE` itself and is unaffected
 * by also running inside a transaction.
 *
 * Both functions let the caller distinguish "this call actually transitioned
 * the row" from "it was already resolved, this was a no-op" — a retry or a
 * race landing on an already-resolved hold is an expected, safe outcome, not
 * an error. This is not the CONTRACTS.md §6 "silently default at a decision
 * boundary" case: no real decision is being skipped here. The invariant that
 * matters — a hold is never double-released or double-committed — is
 * preserved by construction regardless of how many times a caller retries.
 * On that no-op path, no ledger event is appended either — there was no
 * transition to record.
 */

export type ResolveCampaignHoldResult =
  | { resolved: true; hold: SelectCampaignHold }
  | { resolved: false };

async function transitionHoldFromReserved(
  database: NodePgDatabase,
  holdId: string,
  targetState: "RELEASED" | "COMMITTED",
  ledger: CampaignHoldLedgerContext,
): Promise<ResolveCampaignHoldResult> {
  return database.transaction(async (tx): Promise<ResolveCampaignHoldResult> => {
    const result = await tx.execute<CampaignHoldRow>(sql`
      UPDATE campaign_holds
      SET state = ${targetState}, resolved_at = now()
      WHERE id = ${holdId} AND state = 'RESERVED'
      RETURNING
        id,
        merchant_id,
        offer_id,
        amount_minor,
        state,
        expires_at,
        resolved_at,
        created_at
    `);

    const row = result.rows[0];
    if (!row) {
      return { resolved: false };
    }

    // TICKET-403 — same tx as the update above: the hold write and its
    // ledger entry commit or roll back together.
    await appendHoldLedgerEvent(tx, ledger, row);

    return { resolved: true, hold: toSelectCampaignHold(row) };
  });
}

/**
 * Releases a `RESERVED` hold, restoring its amount to `available`. Used for
 * all three real-world release causes — buyer decline of a tier-2 offer,
 * TTL expiry, and payment failure — which all emit the identical
 * `HOLD_RELEASED` code per the frozen state machine (see module comment
 * above), but differ in `eventType`/`fromState`/`toState` (`BUYER_DECLINES`:
 * `OFFER_PENDING` -> `OPEN`; the TTL-expiry and payment-failure self-loops:
 * `HOLD_RELEASED` on `EXPIRED` or `PAYMENT_FAILED`). The caller supplies
 * whichever applies via `ledger` (TICKET-403) — this function only moves the
 * hold and appends the ledger entry the caller described; it does not decide
 * *why* the hold is being released.
 *
 * A hold not currently `RESERVED` (already released, already committed, or
 * nonexistent) is a safe no-op: `{ resolved: false }`, never a thrown error,
 * and no ledger event is appended in that case.
 */
export async function releaseCampaignHold(
  database: NodePgDatabase,
  holdId: string,
  ledger: CampaignHoldLedgerContext,
): Promise<ResolveCampaignHoldResult> {
  return transitionHoldFromReserved(database, holdId, "RELEASED", ledger);
}

/**
 * Commits a `RESERVED` hold on confirmed payment capture. A committed hold
 * still counts against `available` (`available = total − reserved −
 * committed`) — committing does not free the budget, it converts a
 * provisional reservation into a permanent spend. Emits `HOLD_COMMITTED` per
 * the frozen state machine's `SETTLED --HOLD_COMMITTED--> SETTLED` self-loop.
 *
 * A hold not currently `RESERVED` is a safe no-op: `{ resolved: false }`,
 * never a thrown error. So is a hold that is still `RESERVED` but past its
 * `expires_at`: `reserveCampaignBudget` already excludes such a hold from
 * `available`, letting a later reservation reuse its amount, so committing
 * it here — moving it into the unconditionally-counted `COMMITTED` state —
 * would double-count that budget slot. Treated the same as "not resolved".
 *
 * Unlike `releaseCampaignHold`, this cannot be a single bare statement.
 * `now()` is fixed once per Postgres transaction, not re-evaluated per
 * statement, and a lone `UPDATE` here would run in its own one-statement
 * transaction sharing no lock with a concurrent `reserveCampaignBudget` call.
 * That leaves a real window right at the expiry boundary: a commit whose own
 * `now()` was captured a moment *before* `expires_at` can still write
 * `COMMITTED` after a concurrent reservation — using its own, later `now()`
 * — already decided the same hold was expired and reused its amount. Both
 * would then count, over-attributing this merchant's outstanding spend and
 * wrongly denying later valid reservations (the exact bug the expiry check
 * above was added to prevent, reopened by the two calls simply racing).
 *
 * The fix is to serialize against reservations the same way reservations
 * serialize against each other (see the `reserveCampaignBudget` module
 * comment / ISSUE-004): take the same `merchant_policies` row's `FOR UPDATE`
 * lock first, inside one transaction, before evaluating `expires_at`. Any
 * concurrent reservation for this merchant then either finishes first (and
 * this commit's expiry check runs against `now()` captured *after* it, so it
 * sees the same "expired" verdict the reservation did) or waits for this
 * transaction to finish first (and its own outstanding read then reflects
 * this commit's outcome). Either order is safe; only running unsynchronized
 * is not.
 *
 * TICKET-403 — the ledger append below reuses this same transaction, so the
 * commit and its `HOLD_COMMITTED` ledger entry are atomic with each other
 * too, not just with the `merchant_policies` lock above.
 */
export async function commitCampaignHold(
  database: NodePgDatabase,
  holdId: string,
  ledger: CampaignHoldLedgerContext,
): Promise<ResolveCampaignHoldResult> {
  return database.transaction(async (tx): Promise<ResolveCampaignHoldResult> => {
    const holdLookup = await tx.execute<{ merchant_id: string }>(sql`
      SELECT merchant_id FROM campaign_holds WHERE id = ${holdId}
    `);
    const merchantId = holdLookup.rows[0]?.merchant_id;
    if (!merchantId) {
      return { resolved: false };
    }

    // Same synchronization point as reserveCampaignBudget's step 1: blocks
    // until any in-flight reservation for this merchant commits and
    // releases the row lock, and blocks any reservation that starts after
    // this until this transaction finishes.
    await tx.execute(sql`
      SELECT 1 FROM merchant_policies WHERE merchant_id = ${merchantId} FOR UPDATE
    `);

    const result = await tx.execute<CampaignHoldRow>(sql`
      UPDATE campaign_holds
      SET state = 'COMMITTED', resolved_at = now()
      WHERE id = ${holdId} AND state = 'RESERVED' AND expires_at > clock_timestamp()
      RETURNING
        id,
        merchant_id,
        offer_id,
        amount_minor,
        state,
        expires_at,
        resolved_at,
        created_at
    `);

    const row = result.rows[0];
    if (!row) {
      return { resolved: false };
    }

    // TICKET-403 — same tx as the update above and the merchant_policies
    // lock: the commit and its ledger entry commit or roll back together.
    await appendHoldLedgerEvent(tx, ledger, row);

    return { resolved: true, hold: toSelectCampaignHold(row) };
  });
}
