import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  resolveHoldCommittedTransition,
  resolveHoldReleaseTransition,
  resolveRailReportTransition,
  type RailReportOutcome,
} from "@repo/policy";
import type { NegotiationState, StateTransition, TransitionSource } from "@repo/policy/contracts";

import { appendAuditEvent } from "@repo/database/repositories/audit-events";
import { commitCampaignHold, releaseCampaignHold } from "@repo/database/repositories/campaign-holds";
import { getCampaignHoldByOfferId } from "@repo/database/repositories/campaign-budget-snapshot";
import {
  getNegotiationSessionForUpdate,
  updateNegotiationSession,
} from "@repo/database/repositories/negotiation-sessions";
import { getOrderById, getOrderByIdForUpdate, recordRailReport } from "@repo/database/repositories/orders";
import { offersTable } from "@repo/database/models/offer";

import type { RailStateSource } from "./rail-state-source";

/**
 * TICKET-304 — the polling reconciler (PRD §12). Reconciles ONE local order
 * against the rail's current, authoritative belief. `./poll-pending-orders.ts`
 * is the "polling implementation" acceptance criterion — it finds every
 * order still awaiting reconciliation and calls this function for each.
 *
 * ============================================================================
 * ONE-DIRECTIONAL, ALWAYS — AND WHY "DIVERGED" IS DECIDED IN ONE POLL, NOT TWO
 * ============================================================================
 * PRD §12: "the rail's state overwrites local belief, always... the system
 * trusts the payment rail, never an agent's claim." The frozen state machine
 * (`contracts/state-machine.ts`) keys all three of `RAIL_REPORTS_CAPTURED`,
 * `RAIL_REPORTS_FAILED`, and `RAIL_CONTRADICTS_LOCAL` from the SAME `from:
 * "AWAITING_PAYMENT"` state — they are three alternative readings of a
 * single reconciliation moment, not a first poll followed by a
 * contradicting second one. Accordingly, `CONTRADICTS_LOCAL` here means: the
 * rail reports a captured payment, but for an amount that does not match
 * `orders.amountMinor` (the amount copied from the offer at order-creation
 * time, CONTRACTS.md B3) — a real, single-poll-detectable mismatch between
 * what we expected to be charged and what the rail says was actually
 * captured, exactly the kind of "trust the rail, but verify it agrees with
 * our own record" check CONTRACTS.md §6 asks for at a money boundary.
 *
 * ============================================================================
 * HOLD UNWINDING ON A TERMINAL RECONCILIATION (TICKET-305)
 * ============================================================================
 * A Tier 2 offer carries a provisional campaign-budget hold. Whichever way
 * reconciliation ends, that hold must reach its final state in the SAME
 * transaction as the session transition, so the ledger can never show a
 * settled/failed session with a still-`RESERVED` hold:
 *
 *  - `CAPTURED`  -> commit the hold (provisional reservation becomes a
 *                   permanent spend) — the natural conclusion of success.
 *  - `FAILED` /  -> release the hold (its amount returns to available
 *    `CONTRADICTS_LOCAL`   budget), per PRD §12 ("divergence releases any
 *                   campaign hold") and §17 rows 6-7.
 *
 * TICKET-305's ordering guarantee ("the divergence event precedes the
 * corrective event in the ledger") falls out for free: the
 * failure/divergence event is appended above, before this block runs, so the
 * `HOLD_RELEASED` event this block writes necessarily follows it in
 * sequence. "Hold released exactly once" is upheld two ways — the
 * terminal-`localState` short-circuit at the top of this function stops a
 * later poll cycle from re-entering here at all, and `releaseCampaignHold`'s
 * own conditional `WHERE state = 'RESERVED'` update is a no-op (no ledger
 * event) on an already-released hold even if it somehow did.
 */

export type ReconcileOutcome =
  | { status: "PENDING" }
  | { status: "ALREADY_RECONCILED" }
  | { status: "CAPTURED" }
  | { status: "FAILED" }
  | { status: "DIVERGED" };

function fromStateOf(source: TransitionSource): NegotiationState | null {
  return source === "*" ? null : source;
}

/**
 * Turns a resolved `StateTransition` into the ledger context
 * `commitCampaignHold` / `releaseCampaignHold` need. The hold repositories
 * add `holdId` / `amountMinor` / `offerId` from the hold row themselves — the
 * caller only supplies which session and which transition.
 */
function holdLedgerContextFor(sessionId: string, transition: StateTransition) {
  return {
    sessionId,
    eventType: transition.event,
    fromState: fromStateOf(transition.from),
    toState: transition.to,
    reasonCode: transition.reasonCode,
  };
}

export async function reconcileOrder(
  database: NodePgDatabase,
  railSource: RailStateSource,
  orderId: string,
): Promise<ReconcileOutcome> {
  // Cheap pre-check with NO open transaction: skips the network call
  // entirely for an order that's already terminal, and — the load-bearing
  // reason — keeps a pooled DB connection from ever being held open for the
  // Razorpay round-trip below. A stale read here is harmless: the real
  // not-already-reconciled guard is the locked re-check inside the
  // transaction further down, which this pre-check is only an optimization
  // ahead of.
  const precheck = await getOrderById(database, orderId);
  if (!precheck) {
    throw new Error(`reconcileOrder: no order found for id "${orderId}"`);
  }
  if (!precheck.railOrderId) {
    throw new Error(`reconcileOrder: order "${orderId}" has no rail order attached yet — nothing to poll`);
  }
  if (precheck.localState === "CAPTURED" || precheck.localState === "FAILED") {
    return { status: "ALREADY_RECONCILED" };
  }

  const report = await railSource.getOrderState(precheck.railOrderId);

  return database.transaction(async (tx): Promise<ReconcileOutcome> => {
    // FOR UPDATE, and re-checked fresh rather than trusting `precheck`:
    // serializes against a concurrent reconciliation of the SAME order (two
    // overlapping poll cycles, say). Without this, both could read a
    // non-terminal `localState` before either writes, and whichever commits
    // last would silently overwrite the other's result — including a newer
    // CAPTURED outcome getting clobbered back to a stale AUTHORIZED one by a
    // slower, older report. See `getOrderByIdForUpdate`'s own doc.
    const order = await getOrderByIdForUpdate(tx, orderId);
    if (!order) {
      throw new Error(`reconcileOrder: no order found for id "${orderId}"`);
    }

    // Idempotent: a poll cycle can and will see the same order more than
    // once before its `railOrderId` is even attached, or after it has
    // already been resolved by an earlier cycle (here, or by the
    // concurrent caller this lock just waited on). Once `localState` is
    // terminal, PRD §12's reconciliation has already run its course for
    // this order — re-running it would re-append a ledger event for a
    // transition the session already made.
    if (order.localState === "CAPTURED" || order.localState === "FAILED") {
      return { status: "ALREADY_RECONCILED" };
    }

    if (report.railState === "CREATED" || report.railState === "AUTHORIZED") {
      // Not yet terminal — nothing for the ledger or the session to do.
      // Still worth recording: `lastPolledAt` proves this order is being
      // watched, and mirroring `railState` locally costs nothing since
      // "our belief" for a non-terminal state IS just "what the rail last
      // said", the same fact this whole reconciler exists to track.
      await recordRailReport(tx, order.id, {
        localState: report.railState,
        railState: report.railState,
        railPayload: report.payload,
      });
      return { status: "PENDING" };
    }

    const [offer] = await tx.select().from(offersTable).where(eq(offersTable.id, order.offerId));
    if (!offer) {
      throw new Error(`reconcileOrder: no offer found for order "${order.id}"'s offerId "${order.offerId}"`);
    }

    const session = await getNegotiationSessionForUpdate(tx, offer.sessionId);
    if (!session) {
      throw new Error(`reconcileOrder: no session found for offer "${offer.id}"'s sessionId "${offer.sessionId}"`);
    }
    if (session.state !== "AWAITING_PAYMENT") {
      // The only modeled transitions from a rail report all originate from
      // AWAITING_PAYMENT (see module doc) — a session anywhere else while
      // its order is still non-terminal locally is a genuine inconsistency
      // this MVP has no transition for, not something to guess through.
      throw new Error(
        `reconcileOrder: session "${session.id}" is "${session.state}", not AWAITING_PAYMENT — ` +
          `cannot apply a rail report against it`,
      );
    }

    const outcome: RailReportOutcome =
      report.railState === "FAILED"
        ? "FAILED"
        : report.capturedAmountMinor === order.amountMinor
          ? "CAPTURED"
          : "CONTRADICTS_LOCAL";

    const transition = resolveRailReportTransition(outcome);

    await appendAuditEvent(tx, {
      sessionId: session.id,
      eventType: transition.event,
      fromState: fromStateOf(transition.from),
      toState: transition.to,
      reasonCode: transition.reasonCode,
      payload:
        outcome === "CONTRADICTS_LOCAL"
          ? { orderId: order.id, expectedAmountMinor: order.amountMinor, capturedAmountMinor: report.capturedAmountMinor }
          : { orderId: order.id },
      policyVersion: offer.policyVersion,
      offerId: offer.id,
    });

    await updateNegotiationSession(tx, session.id, { state: transition.to });

    // FAILED and CONTRADICTS_LOCAL both land the session on PAYMENT_FAILED —
    // the order's own local belief mirrors that: a diverged order is not a
    // captured one, whatever amount the rail happened to report.
    await recordRailReport(tx, order.id, {
      localState: outcome === "CAPTURED" ? "CAPTURED" : "FAILED",
      railState: report.railState,
      railPayload: report.payload,
    });

    // Unwind a Tier 2 offer's campaign hold to match the reconciliation's
    // outcome — commit on success, release on failure/divergence (TICKET-305;
    // see the module doc's "HOLD UNWINDING" section for the ordering and
    // exactly-once guarantees).
    if (offer.tier === 2) {
      const hold = await getCampaignHoldByOfferId(tx, offer.id);
      if (hold) {
        if (outcome === "CAPTURED") {
          await commitCampaignHold(tx, hold.id, holdLedgerContextFor(session.id, resolveHoldCommittedTransition(2)));
        } else {
          await releaseCampaignHold(
            tx,
            hold.id,
            holdLedgerContextFor(session.id, resolveHoldReleaseTransition("PAYMENT_FAILED", 2)),
          );
        }
      }
    }

    return { status: outcome === "CAPTURED" ? "CAPTURED" : outcome === "FAILED" ? "FAILED" : "DIVERGED" };
  });
}
