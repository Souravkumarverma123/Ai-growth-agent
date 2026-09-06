import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import {
  auditEventsTable,
  campaignHoldsTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
  ordersTable,
} from "@repo/database/schema";
import { releaseCampaignHold, reserveCampaignBudget } from "@repo/database/repositories/campaign-holds";

import { reconcileOrder } from "../src/reconcile-order";
import type { RailOrderReport, RailStateSource } from "../src/rail-state-source";

/**
 * vitest.config.ts pins DATABASE_URL to an inert placeholder for every other
 * (fully mocked) test in this package. This file is the deliberate exception
 * — it needs CONTRACTS.md §8's real-Postgres seam directly — so it restores
 * the genuine value (preserved under a different name for exactly this)
 * before importing the test-db harness, whose own `env.ts` import validates
 * DATABASE_URL eagerly at import time. Done via a dynamic import inside
 * `beforeAll`, not a top-level await, because this repo's shared tsconfig
 * doesn't target a module setting that allows top-level await.
 */
let closeTestDb: typeof import("@repo/database/testing/db").closeTestDb;
let getTestDb: typeof import("@repo/database/testing/db").getTestDb;
let truncateAllTables: typeof import("@repo/database/testing/db").truncateAllTables;

/**
 * TICKET-304 — `reconcileOrder` (PRD §12). Runs against a real Postgres
 * (CONTRACTS.md §8: "do not mock the database") with a scripted
 * `RailStateSource` — the one seam this ticket's acceptance criteria name
 * explicitly ("a test can force captured, failed, and divergent outcomes
 * deterministically").
 *
 * "Reconciliation never writes back to the rail" (this ticket's third
 * acceptance criterion) isn't re-asserted here — `no-capture-call.test.ts`
 * already walks every source file in this package, `reconcile-order.ts`
 * included, for exactly that shape.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

/** Always returns the same report, whatever railOrderId is asked for — enough for these single-order tests. */
class FixedRailStateSource implements RailStateSource {
  constructor(private readonly report: RailOrderReport) {}
  async getOrderState(): Promise<RailOrderReport> {
    return this.report;
  }
}

type Fixture = {
  merchantId: string;
  sessionId: string;
  offerId: string;
  orderId: string;
};

/** A session already at AWAITING_PAYMENT, with an accepted offer and a created order — reconcileOrder's expected starting point. */
async function insertAwaitingPaymentFixture(
  db: Awaited<ReturnType<typeof getTestDb>>,
  options: { tier?: 1 | 2; totalMinor?: number } = {},
): Promise<Fixture> {
  const tier = options.tier ?? 1;
  const totalMinor = options.totalMinor ?? 250_000;

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "reconcile-order test merchant" })
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
      buyerAgentId: "reconcile-order-test-buyer",
      state: "AWAITING_PAYMENT",
      policyVersion: 1,
      originalBasket: fixtureBasket(300_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });
  const sessionId = session!.id;

  const offerId = randomUUID();
  const expiresAt = new Date(Date.now() + 600_000);
  const campaignSpendMinor = tier === 2 ? 20_000 : 0;

  // reserveCampaignBudget's deferred FK on campaign_holds.offer_id is only
  // deferred WITHIN one transaction (migration 0003) — reserving before the
  // offer row exists here would need to share a transaction with the insert
  // below the way route.ts's `propose` does (see
  // campaign-hold-offer-fk-ordering.test.ts). This fixture doesn't need that
  // production ordering, only a consistent end state, so the offer is
  // inserted first, same as every other test in this repo.
  await db.insert(offersTable).values({
    id: offerId,
    sessionId,
    candidateRef: "cand-1",
    roundIndex: 1,
    basket: fixtureBasket(totalMinor),
    totalMinor,
    tier,
    campaignSpendMinor,
    policyVersion: 1,
    status: "ACCEPTED",
    reasonCode: tier === 1 ? "TIER1_OFFERED" : "DILUTION_WITHIN_CAPS",
    expiresAt,
    consumedAt: new Date(),
    engineSignature: "reconcile-order-test-fixture-signature",
  });

  if (tier === 2) {
    await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: campaignSpendMinor,
      expiresAt,
      ledger: {
        sessionId,
        eventType: "BUDGET_RESERVED",
        fromState: "OFFER_PENDING",
        toState: "OFFER_PENDING",
        reasonCode: "HOLD_RESERVED",
      },
    });
  }

  const [order] = await db
    .insert(ordersTable)
    .values({
      offerId,
      railOrderId: `rzp_order_${randomUUID()}`,
      amountMinor: totalMinor,
      currency: "INR",
      localState: "CREATED",
    })
    .returning({ id: ordersTable.id });
  const orderId = order!.id;

  return { merchantId, sessionId, offerId, orderId };
}

describe("reconcileOrder", () => {
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

  it("a non-terminal rail report (AUTHORIZED) records PENDING and does not touch the session", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db);
    const rail = new FixedRailStateSource({ railState: "AUTHORIZED", payload: { status: "authorized" } });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);

    expect(outcome).toEqual({ status: "PENDING" });

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, fixture.orderId));
    expect(order!.localState).toBe("AUTHORIZED");
    expect(order!.lastPolledAt).not.toBeNull();

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, fixture.sessionId));
    expect(session!.state).toBe("AWAITING_PAYMENT");
  });

  it("a matching CAPTURED rail report moves the session to SETTLED and records PAYMENT_CAPTURED", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 250_000,
      payload: { status: "captured" },
    });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);

    expect(outcome).toEqual({ status: "CAPTURED" });

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, fixture.orderId));
    expect(order!.localState).toBe("CAPTURED");

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, fixture.sessionId));
    expect(session!.state).toBe("SETTLED");

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.map((e) => e.reasonCode)).toContain("PAYMENT_CAPTURED");
  });

  it("a CAPTURED report on a Tier 2 offer also commits its campaign hold", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 230_000,
      payload: { status: "captured" },
    });

    await reconcileOrder(db, rail, fixture.orderId);

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    expect(hold!.state).toBe("COMMITTED");
  });

  it("a FAILED rail report overwrites a local belief that captured was still possible: moves session to PAYMENT_FAILED and records PAYMENT_FAILED, never CAPTURED", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db);
    // The order still locally believes CREATED (i.e. "maybe still succeeds")
    // right up until this poll — the rail's FAILED report must win outright.
    const rail = new FixedRailStateSource({ railState: "FAILED", payload: { status: "failed" } });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);

    expect(outcome).toEqual({ status: "FAILED" });

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, fixture.orderId));
    expect(order!.localState).toBe("FAILED");

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, fixture.sessionId));
    expect(session!.state).toBe("PAYMENT_FAILED");

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.map((e) => e.reasonCode)).toContain("PAYMENT_FAILED");
    expect(events.map((e) => e.reasonCode)).not.toContain("PAYMENT_CAPTURED");
  });

  it("a captured amount that disagrees with the offer's recorded total is a divergence, not a capture", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 999_000,
      payload: { status: "captured", amount: 999_000 },
    });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);

    expect(outcome).toEqual({ status: "DIVERGED" });

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, fixture.sessionId));
    expect(session!.state).toBe("PAYMENT_FAILED");

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.map((e) => e.reasonCode)).toContain("RAIL_STATE_DIVERGENCE");
  });

  /**
   * TICKET-305 — divergence and failure handling. `reconcileOrder` (via
   * TICKET-304) already moves the session to PAYMENT_FAILED and records the
   * failure/divergence event on both a FAILED and a divergent report; this
   * ticket owns the other half — a Tier 2 offer's campaign hold is unwound,
   * exactly once, and the divergence/failure event precedes that corrective
   * HOLD_RELEASED event in the ledger (PRD §12, §17 rows 6-7).
   */
  it("a FAILED report on a Tier 2 offer releases its campaign hold, after the PAYMENT_FAILED event in the ledger", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
    const rail = new FixedRailStateSource({ railState: "FAILED", payload: { status: "failed" } });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);
    expect(outcome).toEqual({ status: "FAILED" });

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    expect(hold!.state).toBe("RELEASED");

    const events = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.sessionId, fixture.sessionId))
      .orderBy(asc(auditEventsTable.sequence));
    const codes = events.map((e) => e.reasonCode);
    expect(codes).toContain("PAYMENT_FAILED");
    expect(codes).toContain("HOLD_RELEASED");
    expect(codes.indexOf("PAYMENT_FAILED")).toBeLessThan(codes.indexOf("HOLD_RELEASED"));
  });

  it("a divergent report on a Tier 2 offer releases its campaign hold, and RAIL_STATE_DIVERGENCE precedes HOLD_RELEASED in the ledger", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 999_000,
      payload: { status: "captured", amount: 999_000 },
    });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);
    expect(outcome).toEqual({ status: "DIVERGED" });

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    expect(hold!.state).toBe("RELEASED");

    const events = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.sessionId, fixture.sessionId))
      .orderBy(asc(auditEventsTable.sequence));
    const codes = events.map((e) => e.reasonCode);
    expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeLessThan(codes.indexOf("HOLD_RELEASED"));

    // The disagreement is reconstructable from the ledger alone: the
    // divergence event carries both the amount we expected and the amount the
    // rail reported.
    const divergence = events.find((e) => e.reasonCode === "RAIL_STATE_DIVERGENCE");
    expect(divergence!.payload).toMatchObject({ expectedAmountMinor: 230_000, capturedAmountMinor: 999_000 });
  });

  it("releases a diverged Tier 2 hold exactly once, even across repeated reconciliation", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 999_000,
      payload: { status: "captured", amount: 999_000 },
    });

    const first = await reconcileOrder(db, rail, fixture.orderId);
    expect(first).toEqual({ status: "DIVERGED" });
    const second = await reconcileOrder(db, rail, fixture.orderId);
    expect(second).toEqual({ status: "ALREADY_RECONCILED" });

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.filter((e) => e.reasonCode === "HOLD_RELEASED")).toHaveLength(1);

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    expect(hold!.state).toBe("RELEASED");
  });

  it("a FAILED report whose Tier 2 hold was already released (e.g. by TTL) is a safe no-op: no second HOLD_RELEASED", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });

    const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    await releaseCampaignHold(db, hold!.id, {
      sessionId: fixture.sessionId,
      eventType: "HOLD_RELEASED",
      fromState: "EXPIRED",
      toState: "EXPIRED",
      reasonCode: "HOLD_RELEASED",
    });

    const rail = new FixedRailStateSource({ railState: "FAILED", payload: { status: "failed" } });
    const outcome = await reconcileOrder(db, rail, fixture.orderId);
    expect(outcome).toEqual({ status: "FAILED" });

    const [after] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
    expect(after!.state).toBe("RELEASED");

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.filter((e) => e.reasonCode === "HOLD_RELEASED")).toHaveLength(1);
  });

  it("a FAILED report on a Tier 1 offer touches no campaign hold and emits no HOLD_RELEASED", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { tier: 1 });
    const rail = new FixedRailStateSource({ railState: "FAILED", payload: { status: "failed" } });

    const outcome = await reconcileOrder(db, rail, fixture.orderId);
    expect(outcome).toEqual({ status: "FAILED" });

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.map((e) => e.reasonCode)).not.toContain("HOLD_RELEASED");
  });

  it("is idempotent: reconciling an already-CAPTURED order a second time is a no-op, never a second ledger entry", async () => {
    const db = await getTestDb();
    const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });
    const rail = new FixedRailStateSource({
      railState: "CAPTURED",
      capturedAmountMinor: 250_000,
      payload: { status: "captured" },
    });

    const first = await reconcileOrder(db, rail, fixture.orderId);
    expect(first).toEqual({ status: "CAPTURED" });

    const second = await reconcileOrder(db, rail, fixture.orderId);
    expect(second).toEqual({ status: "ALREADY_RECONCILED" });

    const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
    expect(events.filter((e) => e.reasonCode === "PAYMENT_CAPTURED")).toHaveLength(1);
  });
});
