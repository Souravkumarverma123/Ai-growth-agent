import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { verifyChain, type ChainEvent } from "@repo/policy";
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
import { appendAuditEvent, getAuditEventsForSession } from "@repo/database/repositories/audit-events";
import { releaseCampaignHold, reserveCampaignBudget } from "@repo/database/repositories/campaign-holds";

import { reconcileOrder } from "../src/reconcile-order";
import { pollPendingOrders } from "../src/poll-pending-orders";
import type { RailOrderReport, RailStateSource } from "../src/rail-state-source";

/**
 * TICKET-604 — the payment-and-rail-authority invariant suite, real-Postgres
 * half (PRD §9, §12, §13, §21; Settled by Q15, Q33).
 *
 * The pure half — why a rail report can only be read one way, why a divergence
 * is recorded before it is corrected, why the autonomous-payment flag is a
 * real closed boundary — is in
 * `packages/policy/tests/invariants-payment-rail.test.ts`. This file owns
 * everything that is only true because a real Postgres, a real append-only
 * ledger, and a scripted `RailStateSource` (CONTRACTS.md §8's Seam 3) compose
 * it end to end:
 *
 *   1. Razorpay state is authoritative — a rail-reported failure overwrites a
 *      local belief that success was still coming, in the real `orders` row and
 *      the real session.
 *   2. Payment divergence is handled safely — RAIL_STATE_DIVERGENCE lands in
 *      the ledger before the HOLD_RELEASED that unwinds the hold, the hold is
 *      released exactly once across repeated reconciliation, and the whole
 *      thing is reconstructable from the ledger alone.
 *   4. Audit events are produced for every transition the reconciler makes, and
 *      the resulting chain — fetched back from Postgres — verifies from genesis.
 *
 * Assertion 3 (autonomous payment cannot occur when disabled) has no code in
 * `packages/payments` to exercise — the gate lives in `packages/policy`'s
 * `resolvePaymentInitiationTransition` (asserted purely in the policy-side
 * file) and is enforced end-to-end, with its audit event, by
 * `packages/trpc/tests/negotiation-route.test.ts`'s "acceptOffer fails closed
 * with NOT_IMPLEMENTED" test (the ISSUE-013 regression). It is not re-driven
 * here.
 *
 * Same harness and env dance as `reconcile-order.test.ts` (TICKET-304):
 * `vitest.config.ts` pins `DATABASE_URL` to an inert placeholder for this
 * package's mocked tests, so the genuine value — preserved as
 * `REAL_DATABASE_URL` — is restored before the test-db harness is dynamically
 * imported. `packages/payments/vitest.config.ts` already carries
 * `fileParallelism: false` (ISSUE-014); this is the fourth real-DB file in the
 * package and does not race the other three on the shared sibling database.
 *
 * All money is integer minor units (paise) (CONTRACTS.md §3).
 */

let closeTestDb: typeof import("@repo/database/testing/db").closeTestDb;
let getTestDb: typeof import("@repo/database/testing/db").getTestDb;
let truncateAllTables: typeof import("@repo/database/testing/db").truncateAllTables;

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

/** A `RailStateSource` that returns one scripted report, whatever order id is asked for. */
class FixedRailStateSource implements RailStateSource {
  constructor(private readonly report: RailOrderReport) {}
  async getOrderState(): Promise<RailOrderReport> {
    return this.report;
  }
}

/** A `RailStateSource` that returns a different scripted report per rail order id. */
class RoutedRailStateSource implements RailStateSource {
  constructor(private readonly byRailOrderId: Map<string, RailOrderReport>) {}
  async getOrderState(railOrderId: string): Promise<RailOrderReport> {
    const report = this.byRailOrderId.get(railOrderId);
    if (!report) throw new Error(`RoutedRailStateSource: no scripted report for "${railOrderId}"`);
    return report;
  }
}

type Fixture = {
  merchantId: string;
  sessionId: string;
  offerId: string;
  orderId: string;
  railOrderId: string;
};

/**
 * A session already at AWAITING_PAYMENT — an accepted offer, a created order,
 * and (Tier 2 only) a reserved campaign hold: exactly `reconcileOrder`'s
 * expected starting point. Mirrors `reconcile-order.test.ts`'s fixture.
 */
async function insertAwaitingPaymentFixture(
  db: Awaited<ReturnType<typeof getTestDb>>,
  options: { tier?: 1 | 2; totalMinor?: number; localState?: "CREATED" | "AUTHORIZED" } = {},
): Promise<Fixture> {
  const tier = options.tier ?? 1;
  const totalMinor = options.totalMinor ?? 250_000;
  const localState = options.localState ?? "CREATED";

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-604 payment-rail test merchant" })
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
      buyerAgentId: `ticket-604-buyer-${randomUUID()}`,
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
    engineSignature: "ticket-604-test-fixture-signature",
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

  const railOrderId = `rzp_order_${randomUUID()}`;
  const [order] = await db
    .insert(ordersTable)
    .values({ offerId, railOrderId, amountMinor: totalMinor, currency: "INR", localState })
    .returning({ id: ordersTable.id });

  return { merchantId, sessionId, offerId, orderId: order!.id, railOrderId };
}

/**
 * Appends the pre-payment ledger a real session would already carry by the
 * time its order is being reconciled — evaluate, offer Tier 1, buyer refuses,
 * offer Tier 2 within caps, buyer accepts, order created. Round-trips the real
 * `appendAuditEvent` one transition at a time so the reconciler's events
 * extend a genuine multi-event chain, not a synthetic genesis. Does NOT emit
 * the `HOLD_RESERVED` event — `insertAwaitingPaymentFixture` already appends
 * that for a Tier 2 offer via `reserveCampaignBudget`. Callers measure the
 * resulting prefix length from the ledger itself rather than assuming it.
 */
async function seedPrePaymentLedger(
  db: Awaited<ReturnType<typeof getTestDb>>,
  sessionId: string,
): Promise<void> {
  const steps: Parameters<typeof appendAuditEvent>[1][] = [
    { sessionId, eventType: "ELIGIBILITY_RULES_MATCH", fromState: "IDLE", toState: "AT_RISK", reasonCode: "SESSION_FLAGGED_AT_RISK", payload: { cartAgeSeconds: 900 } },
    { sessionId, eventType: "NEGOTIATION_REQUESTED", fromState: "AT_RISK", toState: "OPEN", reasonCode: "NEGOTIATION_OPENED", payload: {}, policyVersion: 1 },
    { sessionId, eventType: "CANDIDATES_GENERATED", fromState: "OPEN", toState: "OPEN", reasonCode: "CANDIDATES_EVALUATED", payload: { evaluated: 12, feasible: 9, tier1: 4 } },
    { sessionId, eventType: "OFFER_MINTED", fromState: "OPEN", toState: "OFFER_PENDING", reasonCode: "TIER1_OFFERED", payload: { candidateId: "cand-bundle-1" } },
    { sessionId, eventType: "BUYER_DECLINES", fromState: "OFFER_PENDING", toState: "OPEN", reasonCode: "TIER1_REFUSED_BY_BUYER", payload: {} },
    { sessionId, eventType: "OFFER_MINTED", fromState: "OPEN", toState: "OFFER_PENDING", reasonCode: "DILUTION_WITHIN_CAPS", payload: { candidateId: "cand-original-cart" }, campaignSpendMinor: 20_000 },
    { sessionId, eventType: "BUYER_ACCEPTS", fromState: "OFFER_PENDING", toState: "ACCEPTED", reasonCode: "OFFER_ACCEPTED", payload: {} },
    { sessionId, eventType: "ORDER_CREATED", fromState: "ACCEPTED", toState: "AWAITING_PAYMENT", reasonCode: "ORDER_CREATED", payload: { orderId: "order-1" } },
  ];
  for (const step of steps) {
    await appendAuditEvent(db, step);
  }
}

const CAPTURED = (amountMinor: number): RailOrderReport => ({
  railState: "CAPTURED",
  capturedAmountMinor: amountMinor,
  payload: { status: "captured", amount: amountMinor },
});
const FAILED: RailOrderReport = { railState: "FAILED", payload: { status: "failed" } };
const AUTHORIZED: RailOrderReport = { railState: "AUTHORIZED", payload: { status: "authorized" } };

describe("TICKET-604 — payment and rail authority (real Postgres)", () => {
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

  // =========================================================================
  // Invariant 1 — Razorpay state is authoritative
  // =========================================================================

  describe("INVARIANT: a rail-reported failure overwrites a local belief of success (PRD §12, §21.11)", () => {
    it("a FAILED report on an order the rail had earlier reported AUTHORIZED still lands the session on PAYMENT_FAILED", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db);

      // First poll: the rail says AUTHORIZED — local belief moves optimistically.
      await reconcileOrder(db, new FixedRailStateSource(AUTHORIZED), fixture.orderId);
      const [midOrder] = await db.select().from(ordersTable).where(eq(ordersTable.id, fixture.orderId));
      expect(midOrder!.localState).toBe("AUTHORIZED");

      // Second poll: the rail now says FAILED. That overwrites the optimistic
      // local belief outright — no "but we thought it was going through".
      const outcome = await reconcileOrder(db, new FixedRailStateSource(FAILED), fixture.orderId);
      expect(outcome).toEqual({ status: "FAILED" });

      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, fixture.orderId));
      expect(order!.localState).toBe("FAILED");

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, fixture.sessionId));
      expect(session!.state).toBe("PAYMENT_FAILED");

      const codes = (await getAuditEventsForSession(db, fixture.sessionId)).map((e) => e.reasonCode);
      expect(codes).toContain("PAYMENT_FAILED");
      expect(codes).not.toContain("PAYMENT_CAPTURED");
    });

    it.each([
      { localState: "CREATED" as const, rail: FAILED, expectStatus: "FAILED" as const, expectSession: "PAYMENT_FAILED" as const },
      { localState: "AUTHORIZED" as const, rail: FAILED, expectStatus: "FAILED" as const, expectSession: "PAYMENT_FAILED" as const },
      { localState: "CREATED" as const, rail: CAPTURED(250_000), expectStatus: "CAPTURED" as const, expectSession: "SETTLED" as const },
      { localState: "AUTHORIZED" as const, rail: CAPTURED(250_000), expectStatus: "CAPTURED" as const, expectSession: "SETTLED" as const },
    ])(
      "whatever the local state ($localState), the rail's report ($expectStatus) is what the session becomes",
      async ({ localState, rail, expectStatus, expectSession }) => {
        const db = await getTestDb();
        const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000, localState });

        const outcome = await reconcileOrder(db, new FixedRailStateSource(rail), fixture.orderId);
        expect(outcome).toEqual({ status: expectStatus });

        const [session] = await db
          .select()
          .from(negotiationSessionsTable)
          .where(eq(negotiationSessionsTable.id, fixture.sessionId));
        expect(session!.state).toBe(expectSession);
      },
    );

    it("reconciliation never writes back to the rail — the scripted source is read-only and only getOrderState is ever called", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });

      let reads = 0;
      const spySource: RailStateSource = {
        getOrderState: async () => {
          reads += 1;
          return CAPTURED(250_000);
        },
      };

      await reconcileOrder(db, spySource, fixture.orderId);
      // The interface exposes exactly one method — a read. There is no write
      // path to call. (no-capture-call.test.ts separately walks every source
      // file in this package for capture/charge shapes.)
      expect(reads).toBe(1);
      expect(Object.keys(spySource)).toEqual(["getOrderState"]);
    });
  });

  // =========================================================================
  // Invariant 2 — divergence is handled safely
  // =========================================================================

  describe("INVARIANT: a payment divergence records the disagreement before the correction, and releases the hold exactly once (PRD §12, §17 rows 6-7, §21.11)", () => {
    it("a captured-amount mismatch writes RAIL_STATE_DIVERGENCE before HOLD_RELEASED, with both amounts on the divergence event", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });

      const outcome = await reconcileOrder(db, new FixedRailStateSource(CAPTURED(999_000)), fixture.orderId);
      expect(outcome).toEqual({ status: "DIVERGED" });

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, fixture.sessionId));
      expect(session!.state).toBe("PAYMENT_FAILED");

      const events = await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.sessionId, fixture.sessionId))
        .orderBy(asc(auditEventsTable.sequence));
      const codes = events.map((e) => e.reasonCode);
      expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeGreaterThanOrEqual(0);
      expect(codes.indexOf("RAIL_STATE_DIVERGENCE")).toBeLessThan(codes.indexOf("HOLD_RELEASED"));

      // Reconstructable from the ledger alone.
      const divergence = events.find((e) => e.reasonCode === "RAIL_STATE_DIVERGENCE");
      expect(divergence!.payload).toMatchObject({ expectedAmountMinor: 230_000, capturedAmountMinor: 999_000 });

      const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.offerId, fixture.offerId));
      expect(hold!.state).toBe("RELEASED");
    });

    it("repeated reconciliation of a diverged order releases its hold exactly once and never re-appends a ledger event", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
      const rail = new FixedRailStateSource(CAPTURED(999_000));

      expect(await reconcileOrder(db, rail, fixture.orderId)).toEqual({ status: "DIVERGED" });
      for (let i = 0; i < 3; i += 1) {
        expect(await reconcileOrder(db, rail, fixture.orderId)).toEqual({ status: "ALREADY_RECONCILED" });
      }

      const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
      expect(events.filter((e) => e.reasonCode === "RAIL_STATE_DIVERGENCE")).toHaveLength(1);
      expect(events.filter((e) => e.reasonCode === "HOLD_RELEASED")).toHaveLength(1);
    });

    it("a divergence already released out-of-band (e.g. by TTL) is a safe no-op — still exactly one HOLD_RELEASED", async () => {
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

      const outcome = await reconcileOrder(db, new FixedRailStateSource(CAPTURED(999_000)), fixture.orderId);
      expect(outcome).toEqual({ status: "DIVERGED" });

      const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, fixture.sessionId));
      expect(events.filter((e) => e.reasonCode === "HOLD_RELEASED")).toHaveLength(1);
    });

    it("one diverging order in a poll batch does not stop a healthy order in the same batch from reconciling", async () => {
      const db = await getTestDb();
      const bad = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
      const good = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });

      const rail = new RoutedRailStateSource(
        new Map([
          [bad.railOrderId, CAPTURED(999_000)],
          [good.railOrderId, CAPTURED(250_000)],
        ]),
      );

      const results = await pollPendingOrders(db, rail);
      const byOrderId = new Map(results.map((r) => [r.orderId, r]));
      expect(byOrderId.get(bad.orderId)).toMatchObject({ ok: true, outcome: { status: "DIVERGED" } });
      expect(byOrderId.get(good.orderId)).toMatchObject({ ok: true, outcome: { status: "CAPTURED" } });

      const [goodSession] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, good.sessionId));
      expect(goodSession!.state).toBe("SETTLED");
    });
  });

  // =========================================================================
  // Invariant 4 — every transition is audited, and the chain verifies
  // =========================================================================

  describe("INVARIANT: the reconciler audits every transition and the fetched-back chain verifies from genesis (PRD §13, §21.14)", () => {
    it("capture path: PAYMENT_CAPTURED and HOLD_COMMITTED extend the pre-payment chain and the whole thing verifies", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
      await seedPrePaymentLedger(db, fixture.sessionId);
      const prefixLength = (await getAuditEventsForSession(db, fixture.sessionId)).length;

      await reconcileOrder(db, new FixedRailStateSource(CAPTURED(230_000)), fixture.orderId);

      const events = await getAuditEventsForSession(db, fixture.sessionId);
      expect(events.length).toBe(prefixLength + 2);
      expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i));
      expect(events[0]!.prevHash).toBeNull();
      expect(events.slice(prefixLength).map((e) => e.reasonCode)).toEqual(["PAYMENT_CAPTURED", "HOLD_COMMITTED"]);

      expect(verifyChain(events as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: events.length });
    });

    it("divergence path: RAIL_STATE_DIVERGENCE and HOLD_RELEASED extend the chain and it still verifies", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
      await seedPrePaymentLedger(db, fixture.sessionId);
      const prefixLength = (await getAuditEventsForSession(db, fixture.sessionId)).length;

      await reconcileOrder(db, new FixedRailStateSource(CAPTURED(1)), fixture.orderId);

      const events = await getAuditEventsForSession(db, fixture.sessionId);
      expect(events.slice(prefixLength).map((e) => e.reasonCode)).toEqual(["RAIL_STATE_DIVERGENCE", "HOLD_RELEASED"]);
      expect(verifyChain(events as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: events.length });
    });

    it("a non-terminal poll writes no ledger event — only real transitions are audited", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { totalMinor: 250_000 });
      await seedPrePaymentLedger(db, fixture.sessionId);
      const prefixLength = (await getAuditEventsForSession(db, fixture.sessionId)).length;

      const outcome = await reconcileOrder(db, new FixedRailStateSource(AUTHORIZED), fixture.orderId);
      expect(outcome).toEqual({ status: "PENDING" });

      const events = await getAuditEventsForSession(db, fixture.sessionId);
      expect(events.length).toBe(prefixLength);
      expect(verifyChain(events as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: prefixLength });
    });

    it("tampering with a stored payment event breaks verification of the fetched chain, while the untouched fetch stays clean", async () => {
      const db = await getTestDb();
      const fixture = await insertAwaitingPaymentFixture(db, { tier: 2, totalMinor: 230_000 });
      await seedPrePaymentLedger(db, fixture.sessionId);
      const prefixLength = (await getAuditEventsForSession(db, fixture.sessionId)).length;
      await reconcileOrder(db, new FixedRailStateSource(CAPTURED(230_000)), fixture.orderId);

      const events = await getAuditEventsForSession(db, fixture.sessionId);
      expect(verifyChain(events as unknown as ChainEvent[]).valid).toBe(true);

      // The PAYMENT_CAPTURED event, mutated in an in-memory copy without
      // recomputing its hash — a stale-backup / out-of-band-write simulation.
      const tampered = events.map((event, index) =>
        index === prefixLength ? { ...event, reasonCode: "PAYMENT_FAILED" as const } : event,
      );
      const result = verifyChain(tampered as unknown as ChainEvent[]);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("HASH_MISMATCH");
        expect(result.brokenAtIndex).toBe(prefixLength);
      }

      expect(verifyChain(events as unknown as ChainEvent[]).valid).toBe(true);
    });
  });
});
