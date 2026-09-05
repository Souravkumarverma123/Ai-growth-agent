import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { listOrdersAwaitingReconciliation } from "@repo/database/repositories/orders";

import { reconcileOrder, type ReconcileOutcome } from "./reconcile-order";
import type { RailStateSource } from "./rail-state-source";

/**
 * TICKET-304 — the "polling implementation" acceptance criterion (PRD §12).
 * Finds every order still awaiting reconciliation and reconciles each one
 * against the rail in turn. This is the only production entry point that
 * calls `reconcileOrder` — a scheduler (cron, a queue worker, whatever the
 * host process uses) calls this function on an interval; nothing about
 * reconciliation is ever triggered by an inbound webhook (PRD §12: "Webhooks
 * are optional and must not be a dependency").
 *
 * One order's failure does not abort the batch: `listOrdersAwaitingReconciliation`
 * can return orders across many different merchants and sessions in one
 * poll, and a single order stuck in an inconsistent state (e.g. its session
 * moved somewhere `reconcileOrder` doesn't expect) must not block every
 * other, healthy order from reconciling in the same cycle — that would
 * actually violate PRD §12's "polling converges" property instead of
 * upholding it. Each order's outcome (or thrown error) is reported
 * individually so a caller can alert on the failures without losing the
 * successes.
 */
export type PollOutcome =
  | { orderId: string; ok: true; outcome: ReconcileOutcome }
  | { orderId: string; ok: false; error: unknown };

export async function pollPendingOrders(
  database: NodePgDatabase,
  railSource: RailStateSource,
): Promise<PollOutcome[]> {
  const orders = await listOrdersAwaitingReconciliation(database);

  const results: PollOutcome[] = [];
  for (const order of orders) {
    try {
      const outcome = await reconcileOrder(database, railSource, order.id);
      results.push({ orderId: order.id, ok: true, outcome });
    } catch (error) {
      results.push({ orderId: order.id, ok: false, error });
    }
  }
  return results;
}
