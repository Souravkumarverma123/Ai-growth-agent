import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  resolveHoldCommittedTransition,
  resolveRailReportTransition,
  type RailReportOutcome,
} from "@repo/policy";
import type { NegotiationState, TransitionSource } from "@repo/policy/contracts";

import { appendAuditEvent } from "@repo/database/repositories/audit-events";
import { commitCampaignHold } from "@repo/database/repositories/campaign-holds";
import { getCampaignHoldByOfferId } from "@repo/database/repositories/campaign-budget-snapshot";
import {
  getNegotiationSessionForUpdate,
  updateNegotiationSession,
} from "@repo/database/repositories/negotiation-sessions";
import { getOrderById, recordRailReport } from "@repo/database/repositories/orders";
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
 * WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
 * ============================================================================
 * On `FAILED` or `CONTRADICTS_LOCAL`, this function moves the session to
 * `PAYMENT_FAILED` and records the correct ledger event — it does NOT
 * release a Tier 2 offer's campaign hold. That is TICKET-305's job
 * ("Divergence and failure handling"), which explicitly owns "hold released
 * exactly once" and the ordering guarantee ("the divergence event precedes
 * the corrective event in the ledger") as its own acceptance criteria — not
 * duplicated here. On `CAPTURED`, though, committing a Tier 2 hold (moving
 * it from a provisional reservation to a permanent spend) is this
 * function's own job: it is the natural conclusion of a successful
 * reconciliation, not a failure-path concern TICKET-305 owns.
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

export async function reconcileOrder(
  database: NodePgDatabase,
  railSource: RailStateSource,
  orderId: string,
): Promise<ReconcileOutcome> {
  return database.transaction(async (tx): Promise<ReconcileOutcome> => {
    const order = await getOrderById(tx, orderId);
    if (!order) {
      throw new Error(`reconcileOrder: no order found for id "${orderId}"`);
    }
    if (!order.railOrderId) {
      throw new Error(`reconcileOrder: order "${orderId}" has no rail order attached yet — nothing to poll`);
    }

    // Idempotent: a poll cycle can and will see the same order more than
    // once before its `railOrderId` is even attached, or after it has
    // already been resolved by an earlier cycle. Once `localState` is
    // terminal, PRD §12's reconciliation has already run its course for
    // this order — re-running it would re-append a ledger event for a
    // transition the session already made.
    if (order.localState === "CAPTURED" || order.localState === "FAILED") {
      return { status: "ALREADY_RECONCILED" };
    }

    const report = await railSource.getOrderState(order.railOrderId);

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

    if (outcome === "CAPTURED" && offer.tier === 2) {
      const hold = await getCampaignHoldByOfferId(tx, offer.id);
      if (hold) {
        const commitTransition = resolveHoldCommittedTransition(2);
        await commitCampaignHold(tx, hold.id, {
          sessionId: session.id,
          eventType: commitTransition.event,
          fromState: fromStateOf(commitTransition.from),
          toState: commitTransition.to,
          reasonCode: commitTransition.reasonCode,
        });
      }
    }

    return { status: outcome === "CAPTURED" ? "CAPTURED" : outcome === "FAILED" ? "FAILED" : "DIVERGED" };
  });
}
