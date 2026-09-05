import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import {
  auditEventsTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
  ordersTable,
  skuPoliciesTable,
} from "@repo/database/schema";
import { computeCounterfactualContribution } from "@repo/policy";
import type { SkuPolicy } from "@repo/policy/contracts";

/**
 * TICKET-204 — negotiation protocol procedures (PRD §18, CONTRACTS.md §9).
 *
 * The primary seam (CONTRACTS.md §8): "tRPC caller against a real Postgres."
 * Nothing here mocks the database. The one thing this file DOES mock is
 * `@repo/payments`'s `createOrder` — not to avoid the database, but because:
 *   (1) the real implementation makes a live network call to Razorpay's API
 *       (`packages/payments/src/razorpay-client.ts`'s own `fetch`), which no
 *       automated test in this repository is meant to do (payments' own
 *       tests mock this same call for the same reason); and
 *   (2) `getOfferById`/`createOrder` internally import `@repo/database`'s
 *       exported singleton `db` directly (`packages/payments/src/
 *       offer-repository.ts`) rather than accepting a database handle as a
 *       parameter — unlike every other repository in this codebase, which is
 *       generic over `NodePgDatabase` specifically so it can run against
 *       `getTestDb()`'s sibling test database. That singleton points at
 *       `DATABASE_URL`, a different physical database from the one this
 *       test's own `ctx.db` (`getTestDb()`) uses, so the real function could
 *       never find a row this test just inserted. Recorded as ISSUE-012 in
 *       `issue-tracker.md` — this is the first ticket that composes
 *       `packages/payments` with the shared test-db harness at all.
 * The mock below inserts its own `orders` row into the SAME test database
 * this test uses, so `acceptOffer`'s follow-up `getOrderByOfferId` read still
 * finds a real row — only the Razorpay HTTP call and the cross-package
 * db-singleton mismatch are stubbed out, not the negotiation logic itself.
 * It reads the real offer's `totalMinor`/`currency` first (the same fields
 * the real `reserveOrder`'s `INSERT ... SELECT` derives them from,
 * `packages/database/repositories/orders.ts`) rather than hardcoding a
 * placeholder amount, so the local order row this test produces can never
 * silently disagree with the offer it was authorized against.
 */
vi.mock("@repo/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/payments")>();
  return {
    ...actual,
    createOrder: vi.fn(async (offerId: string) => {
      const db = await getTestDb();
      const [offer] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      if (!offer) throw new Error(`mocked createOrder: no offer found for offerId "${offerId}"`);
      const railOrderId = `rzp_test_order_${offerId.slice(0, 8)}`;
      await db.insert(ordersTable).values({
        offerId,
        railOrderId,
        amountMinor: offer.totalMinor,
        currency: offer.currency,
      });
      return {
        id: railOrderId,
        entity: "order",
        amount: offer.totalMinor,
        currency: offer.currency,
        receipt: offerId,
        status: "created",
        notes: {},
        created_at: Math.floor(Date.now() / 1000),
      };
    }),
  };
});

// Imported AFTER the mock is declared, matching this repo's own convention
// (`vi.mock` calls are hoisted by vitest regardless of import order, but
// importing the router only once the mock factory exists keeps the file
// readable top-to-bottom).
const { serverRouter } = await import("../server");

async function insertMerchantWithPolicyAndSku(
  overrides: { maxRounds?: number; autonomousPaymentExecution?: boolean } = {},
): Promise<{
  merchantId: string;
  skuPolicy: SkuPolicy;
}> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-204 tRPC test merchant" })
    .returning({ id: merchantsTable.id });
  const merchantId = merchant!.id;

  await db.insert(merchantPoliciesTable).values({
    merchantId,
    negotiationEnabled: true,
    campaignBudgetTotalMinor: 500_000,
    perDealCapMinor: 50_000,
    maxRounds: overrides.maxRounds ?? 3,
    concessionCurve: [0.4, 0.7, 1.0],
    offerTtlSeconds: 600,
    autonomousPaymentExecution: overrides.autonomousPaymentExecution ?? false,
  });

  const [sku] = await db
    .insert(skuPoliciesTable)
    .values({
      merchantId,
      sku: "VITC-SERUM",
      name: "Vitamin C Serum",
      listPriceMinor: 100_000,
      floorPriceMinor: 80_000,
      negotiable: true,
      slowMoving: false,
    })
    .returning();

  const skuPolicy: SkuPolicy = {
    skuId: sku!.id,
    merchantId,
    sku: sku!.sku,
    name: sku!.name,
    listPriceMinor: sku!.listPriceMinor,
    floorPriceMinor: sku!.floorPriceMinor,
    negotiable: sku!.negotiable,
    slowMoving: sku!.slowMoving,
    affinityGroup: sku!.affinityGroup,
  };

  return { merchantId, skuPolicy };
}

async function insertSession(params: {
  merchantId: string;
  skuPolicy: SkuPolicy;
  state: "IDLE" | "AT_RISK";
}): Promise<string> {
  const db = await getTestDb();
  const originalBasket = {
    lines: [{ skuId: params.skuPolicy.skuId, quantity: 1, unitPriceMinor: params.skuPolicy.listPriceMinor }],
    commitments: [] as const,
    currency: "INR" as const,
  };
  const counterfactualContributionMinor = computeCounterfactualContribution(originalBasket, [params.skuPolicy]);

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId: params.merchantId,
      buyerAgentId: "buyer-agent-1",
      state: params.state,
      roundIndex: 0,
      tier1Refused: false,
      policyVersion: 1,
      originalBasket,
      counterfactualContributionMinor,
    })
    .returning({ id: negotiationSessionsTable.id });

  return session!.id;
}

describe("TICKET-204 — negotiation router procedures", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("ineligible-refusal path", () => {
    it("an unflagged session (state IDLE) refuses openNegotiation with NOT_AT_RISK and logs it to the audit ledger", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "IDLE" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      const result = await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });

      expect(result.opened).toBe(false);
      expect(result.reasonCode).toBe("NOT_AT_RISK");
      expect(result.negotiationId).toBe(sessionId);

      // Logged to the audit ledger (TICKET-401/402's writer, not a second
      // logging path) — CONTRACTS.md §9's own acceptance criterion.
      const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, sessionId));
      expect(events).toHaveLength(1);
      expect(events[0]!.reasonCode).toBe("NOT_AT_RISK");
      expect(events[0]!.eventType).toBe("NEGOTIATION_REQUESTED");
      expect(events[0]!.fromState).toBe("IDLE");
      expect(events[0]!.toState).toBe("IDLE");

      // The session itself never silently advances past IDLE.
      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("IDLE");
    });

    it("getSessionContext reports negotiationAvailable: false for an unflagged (IDLE) session", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "IDLE" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      const context = await caller.negotiation.getSessionContext({ sessionId });

      expect(context.negotiationAvailable).toBe(false);
      expect(context.lines).toEqual([
        { sku: "VITC-SERUM", name: "Vitamin C Serum", quantity: 1, unitPriceMinor: 100_000 },
      ]);
    });

    it("a kill-switched merchant (negotiationEnabled: false) refuses an AT_RISK session with NEGOTIATION_DISABLED", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const db = await getTestDb();
      await db
        .update(merchantPoliciesTable)
        .set({ negotiationEnabled: false })
        .where(eq(merchantPoliciesTable.merchantId, merchantId));
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "AT_RISK" });
      const caller = serverRouter.createCaller({ db });

      const result = await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });

      expect(result.opened).toBe(false);
      expect(result.reasonCode).toBe("NEGOTIATION_DISABLED");

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("HALTED");
    });
  });

  describe("happy path: open -> propose -> accept", () => {
    it("drives a full negotiation to a payment handle, never a captured payment", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "AT_RISK" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      const opened = await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });
      expect(opened.opened).toBe(true);
      expect(opened.reasonCode).toBe("NEGOTIATION_OPENED");

      const proposed = await caller.negotiation.propose({
        negotiationId: sessionId,
        message: "Can you do better on this?",
      });

      expect(proposed.terminal).toBe(false);
      expect(proposed.offer).not.toBeNull();
      expect(proposed.offer!.currency).toBe("INR");
      expect(proposed.offer!.totalMinor).toBeGreaterThan(0);
      // No forbidden field on the actual wire response either (double-checks
      // response-shape.test.ts's direct mapper-level assertions).
      const wireJson = JSON.stringify(proposed);
      for (const forbidden of ["floor", "campaignSpend", "perDealCap", "concessionCurve", "policyVersion"]) {
        expect(wireJson).not.toContain(forbidden);
      }

      const accepted = await caller.negotiation.acceptOffer({
        negotiationId: sessionId,
        offerId: proposed.offer!.offerId,
      });

      expect(accepted.accepted).toBe(true);
      expect(accepted.reasonCode).toBe("OFFER_ACCEPTED");
      expect(accepted.paymentHandle).not.toBeNull();
      expect(accepted.paymentHandle!.currency).toBe("INR");
      expect(accepted.paymentHandle!.railOrderId).toMatch(/^rzp_test_order_/);
      // A payment HANDLE, never a captured payment: no capture-shaped field
      // exists on the response at all, and the session sits in
      // AWAITING_PAYMENT — a rail report, not this endpoint, is what would
      // ever move it to SETTLED (TICKET-304/305, not yet built).
      expect(accepted.paymentHandle).not.toHaveProperty("captured");
      expect(accepted.paymentHandle).not.toHaveProperty("status");

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("AWAITING_PAYMENT");

      const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, sessionId));
      const reasonCodes = events.map((e) => e.reasonCode);
      expect(reasonCodes).toContain("NEGOTIATION_OPENED");
      expect(reasonCodes).toContain("OFFER_ACCEPTED");
      expect(reasonCodes).toContain("ORDER_CREATED");
    });

    // TICKET-306 — autonomous-payment gate. The "true" branch must exist and
    // fail closed, not be an assumption nobody flips the flag to check.
    it("acceptOffer fails closed with NOT_IMPLEMENTED when autonomousPaymentExecution is true, never a silent success or a real charge", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku({ autonomousPaymentExecution: true });
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "AT_RISK" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });
      const proposed = await caller.negotiation.propose({ negotiationId: sessionId, message: "hello" });
      expect(proposed.offer).not.toBeNull();
      const offerId = proposed.offer!.offerId;

      await expect(
        caller.negotiation.acceptOffer({ negotiationId: sessionId, offerId }),
      ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });

      // Audited with its reason code — the refusal is a real, findable event,
      // not a silently swallowed one.
      const events = await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, sessionId));
      expect(events.map((e) => e.reasonCode)).toContain("AUTONOMOUS_PAYMENT_NOT_AUTHORIZED");

      // Checked BEFORE any write (this session's own earlier fix for the
      // stranding bug): the offer is untouched and the session never
      // advanced to ACCEPTED, so a merchant who later disables the flag can
      // still let the buyer accept this same, still-valid offer.
      const [offer] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(offer!.status).toBe("PENDING");
      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("OFFER_PENDING");

      // No capture/charge call is even reachable to get to: createRazorpayOrder
      // (the only network call in packages/payments) is mocked in this file
      // and was never invoked for this offer.
      const { createOrder } = await import("@repo/payments");
      expect(createOrder).not.toHaveBeenCalled();
    });

    it("respondToOffer(DECLINE_AND_CONTINUE) on a Tier 1 offer unlocks Tier 2 and returns to OPEN", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "AT_RISK" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });
      const proposed = await caller.negotiation.propose({ negotiationId: sessionId, message: "hello" });
      expect(proposed.offer).not.toBeNull();

      const responded = await caller.negotiation.respondToOffer({
        negotiationId: sessionId,
        offerId: proposed.offer!.offerId,
        response: "DECLINE_AND_CONTINUE",
      });

      expect(responded.terminal).toBe(false);
      expect(["TIER1_REFUSED_BY_BUYER", "HOLD_RELEASED"]).toContain(responded.reasonCode);

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("OPEN");
    });

    it("respondToOffer(WALK_AWAY) ends the session as DECLINED", async () => {
      const { merchantId, skuPolicy } = await insertMerchantWithPolicyAndSku();
      const sessionId = await insertSession({ merchantId, skuPolicy, state: "AT_RISK" });
      const db = await getTestDb();
      const caller = serverRouter.createCaller({ db });

      await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "buyer-agent-1" });
      const proposed = await caller.negotiation.propose({ negotiationId: sessionId, message: "hello" });

      const responded = await caller.negotiation.respondToOffer({
        negotiationId: sessionId,
        offerId: proposed.offer!.offerId,
        response: "WALK_AWAY",
      });

      expect(responded.terminal).toBe(true);
      expect(responded.reasonCode).toBe("BUYER_DECLINED");

      const [session] = await db
        .select()
        .from(negotiationSessionsTable)
        .where(eq(negotiationSessionsTable.id, sessionId));
      expect(session!.state).toBe("DECLINED");
    });
  });
});
