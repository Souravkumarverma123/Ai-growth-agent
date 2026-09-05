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
 *
 * Orders reconcile CONCURRENTLY, not one at a time: `reconcileOrder`'s own
 * network call to the rail happens with no open transaction (see that
 * file's own doc), so a slow or hung rail request for one order only holds
 * up that one order's own short-lived DB work, never blocks every
 * later order in the batch behind it — the same "one bad apple can't stop
 * the rest" property this module already applies to failures also has to
 * apply to latency, or a single hung request could stall convergence for
 * every other, healthy order in the same cycle.
 */
export type PollOutcome =
  | { orderId: string; ok: true; outcome: ReconcileOutcome }
  | { orderId: string; ok: false; error: unknown };

export async function pollPendingOrders(
  database: NodePgDatabase,
  railSource: RailStateSource,
): Promise<PollOutcome[]> {
  const orders = await listOrdersAwaitingReconciliation(database);

  const settled = await Promise.allSettled(
    orders.map((order) => reconcileOrder(database, railSource, order.id)),
  );

  return settled.map((result, index) => {
    const orderId = orders[index]!.id;
    return result.status === "fulfilled"
      ? { orderId, ok: true, outcome: result.value }
      : { orderId, ok: false, error: result.reason };
  });
}
