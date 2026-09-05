import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import {
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
  ordersTable,
} from "@repo/database/schema";

import { pollPendingOrders } from "../src/poll-pending-orders";
import type { RailOrderReport, RailStateSource } from "../src/rail-state-source";

// See reconcile-order.test.ts for why this restoration (via a dynamic import
// inside beforeAll, not a top-level await) is necessary — this file needs
// the same real-Postgres seam.
let closeTestDb: typeof import("@repo/database/testing/db").closeTestDb;
let getTestDb: typeof import("@repo/database/testing/db").getTestDb;
let truncateAllTables: typeof import("@repo/database/testing/db").truncateAllTables;

/**
 * TICKET-304 — `pollPendingOrders`, the "polling implementation" acceptance
 * criterion (PRD §12). Proves "polling converges": an order can sit
 * non-terminal across several poll cycles and still reach a terminal state
 * once the rail reports one, and one order's failure never blocks another
 * order's reconciliation in the same cycle.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

/** Scripts a sequence of reports per railOrderId — each call consumes the next one, then repeats the last. */
class ScriptedRailStateSource implements RailStateSource {
  private readonly queues: Map<string, RailOrderReport[]>;

  constructor(script: Record<string, RailOrderReport[]>) {
    this.queues = new Map(Object.entries(script).map(([id, reports]) => [id, [...reports]]));
  }

  async getOrderState(railOrderId: string): Promise<RailOrderReport> {
    const queue = this.queues.get(railOrderId);
    if (!queue || queue.length === 0) {
      throw new Error(`ScriptedRailStateSource: no scripted response for "${railOrderId}"`);
    }
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }
}

async function insertAwaitingPaymentOrder(
  db: Awaited<ReturnType<typeof getTestDb>>,
  totalMinor: number,
): Promise<{ sessionId: string; orderId: string; railOrderId: string }> {
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "poll-pending-orders test merchant" })
    .returning({ id: merchantsTable.id });
  const merchantId = merchant!.id;

  await db.insert(merchantPoliciesTable).values({
    merchantId,
    campaignBudgetTotalMinor: 500_000,
    perDealCapMinor: 50_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: "poll-pending-orders-test-buyer",
      state: "AWAITING_PAYMENT",
      policyVersion: 1,
      originalBasket: fixtureBasket(300_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });
  const sessionId = session!.id;

  const offerId = randomUUID();
  await db.insert(offersTable).values({
    id: offerId,
    sessionId,
    candidateRef: "cand-1",
    roundIndex: 1,
    basket: fixtureBasket(totalMinor),
    totalMinor,
    tier: 1,
    campaignSpendMinor: 0,
    policyVersion: 1,
    status: "ACCEPTED",
    reasonCode: "TIER1_OFFERED",
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: new Date(),
    engineSignature: "poll-pending-orders-test-fixture-signature",
  });

  const railOrderId = `rzp_order_${randomUUID()}`;
  const [order] = await db
    .insert(ordersTable)
    .values({ offerId, railOrderId, amountMinor: totalMinor, currency: "INR", localState: "CREATED" })
    .returning({ id: ordersTable.id });

  return { sessionId, orderId: order!.id, railOrderId };
}

describe("pollPendingOrders", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REAL_DATABASE_URL;
    ({ closeTestDb, getTestDb, truncateAllTables } = await import("@repo/database/testing/db"));
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("converges: an order stuck non-terminal across several poll cycles reaches CAPTURED once the rail reports it", async () => {
    const db = await getTestDb();
    const { orderId, railOrderId } = await insertAwaitingPaymentOrder(db, 250_000);

    const rail = new ScriptedRailStateSource({
      [railOrderId]: [
        { railState: "CREATED", payload: { status: "created" } },
        { railState: "AUTHORIZED", payload: { status: "authorized" } },
        { railState: "CAPTURED", capturedAmountMinor: 250_000, payload: { status: "captured" } },
      ],
    });

    const cycle1 = await pollPendingOrders(db, rail);
    expect(cycle1).toEqual([{ orderId, ok: true, outcome: { status: "PENDING" } }]);

    const cycle2 = await pollPendingOrders(db, rail);
    expect(cycle2).toEqual([{ orderId, ok: true, outcome: { status: "PENDING" } }]);

    const cycle3 = await pollPendingOrders(db, rail);
    expect(cycle3).toEqual([{ orderId, ok: true, outcome: { status: "CAPTURED" } }]);

    // Converged: a further poll cycle no longer selects this order at all
    // (listOrdersAwaitingReconciliation excludes terminal localState).
    const cycle4 = await pollPendingOrders(db, rail);
    expect(cycle4).toEqual([]);
  });

  it("polls every order still awaiting reconciliation in one cycle, and skips ones already terminal", async () => {
    const db = await getTestDb();
    const pending = await insertAwaitingPaymentOrder(db, 100_000);
    const alreadyCaptured = await insertAwaitingPaymentOrder(db, 200_000);
    await db
      .update(ordersTable)
      .set({ localState: "CAPTURED" })
      .where(eq(ordersTable.id, alreadyCaptured.orderId));

    const rail = new ScriptedRailStateSource({
      [pending.railOrderId]: [{ railState: "AUTHORIZED", payload: { status: "authorized" } }],
    });

    const results = await pollPendingOrders(db, rail);

    expect(results).toEqual([{ orderId: pending.orderId, ok: true, outcome: { status: "PENDING" } }]);
  });

  it("one order's failure does not block another order's reconciliation in the same cycle", async () => {
    const db = await getTestDb();
    const healthy = await insertAwaitingPaymentOrder(db, 150_000);
    const broken = await insertAwaitingPaymentOrder(db, 175_000);

    // No scripted response for `broken`'s railOrderId at all — getOrderState throws for it.
    const rail = new ScriptedRailStateSource({
      [healthy.railOrderId]: [{ railState: "AUTHORIZED", payload: { status: "authorized" } }],
    });

    const results = await pollPendingOrders(db, rail);

    const byOrderId = new Map(results.map((r) => [r.orderId, r]));
    expect(byOrderId.get(healthy.orderId)).toEqual({
      orderId: healthy.orderId,
      ok: true,
      outcome: { status: "PENDING" },
    });
    expect(byOrderId.get(broken.orderId)?.ok).toBe(false);
  });
});
