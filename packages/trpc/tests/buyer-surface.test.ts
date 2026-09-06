import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import { auditEventsTable, negotiationSessionsTable, offersTable } from "@repo/database/schema";

import { seedNegotiationSession } from "./support/negotiation-fixtures";

/**
 * TICKET-506 — Minimal buyer surface (PRD §9, §19).
 *
 * The buyer surface (`apps/web/app/buyer/[sessionId]`) has no logic of its
 * own: it renders whatever the public `negotiation.*` procedures return and
 * calls them back in sequence. `apps/web` has no test runner and
 * CONTRACTS.md §8 bars introducing a fourth test seam for one, so the
 * ticket's required test ("accept-to-handle flow works end to end") lives
 * here, at the primary seam — a tRPC caller against a real Postgres, driving
 * the exact call sequence the screen drives:
 *
 *   getSessionContext → openNegotiation → propose → (decline → propose) →
 *   acceptOffer → payment handle
 *
 * and asserting the response at each step carries everything the screen
 * needs to render that step, and nothing capture-shaped.
 *
 * The one mock is `@repo/payments`'s `createOrder`, for the reasons
 * `negotiation-route.test.ts` documents (live Razorpay HTTP call + the
 * `@repo/database` singleton / test-db mismatch, ISSUE-012).
 * `insertTestOrderForOffer` writes a real `orders` row into this test's own
 * database so the downstream read still finds one.
 */
vi.mock("@repo/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/payments")>();
  const { insertTestOrderForOffer: insertOrder } = await import("./support/negotiation-fixtures");
  return {
    ...actual,
    createOrder: vi.fn((offerId: string) => insertOrder(offerId)),
  };
});

const { serverRouter } = await import("../server");

describe("TICKET-506 — buyer surface: accept-to-handle flow", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("a human can drive one negotiation from cart to a payment handle", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "AT_RISK" });
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    // 1. The screen's first call: render the cart and whether the merchant
    //    flagged this checkout.
    const context = await caller.negotiation.getSessionContext({ sessionId });
    expect(context.negotiationAvailable).toBe(true);
    expect(context.currency).toBe("INR");
    expect(context.lines.length).toBeGreaterThan(0);
    for (const line of context.lines) {
      expect(Number.isInteger(line.unitPriceMinor)).toBe(true);
      expect(line.name.length).toBeGreaterThan(0);
    }

    // 2. "Open negotiation".
    const opened = await caller.negotiation.openNegotiation({
      sessionId,
      buyerAgentId: "human-buyer-abc123",
    });
    expect(opened.opened).toBe(true);
    expect(opened.reasonCode).toBe("NEGOTIATION_OPENED");

    // 3. First message → an offer to render on the offer card.
    const firstRound = await caller.negotiation.propose({
      negotiationId: sessionId,
      message: "This is over my budget — what can you do?",
    });
    expect(firstRound.terminal).toBe(false);
    expect(firstRound.offer).not.toBeNull();
    const firstOffer = firstRound.offer!;
    expect(firstOffer.lines.length).toBeGreaterThan(0);
    expect(firstOffer.totalMinor).toBeGreaterThan(0);
    expect(Number.isInteger(firstOffer.totalMinor)).toBe(true);
    expect(firstOffer.message.length).toBeGreaterThan(0);
    expect(() => new Date(firstOffer.expiresAt).toISOString()).not.toThrow();

    // 4. "Decline & continue" — the transcript loop the screen supports.
    const declined = await caller.negotiation.respondToOffer({
      negotiationId: sessionId,
      offerId: firstOffer.offerId,
      response: "DECLINE_AND_CONTINUE",
    });
    expect(declined.terminal).toBe(false);

    // 5. Another message → another offer.
    const secondRound = await caller.negotiation.propose({
      negotiationId: sessionId,
      message: "Still too high. Anything closer to what I had?",
    });
    expect(secondRound.offer).not.toBeNull();
    const secondOffer = secondRound.offer!;

    // 6. "Accept offer" → the payment authorization handoff.
    const accepted = await caller.negotiation.acceptOffer({
      negotiationId: sessionId,
      offerId: secondOffer.offerId,
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.reasonCode).toBe("OFFER_ACCEPTED");

    const handle = accepted.paymentHandle;
    expect(handle).not.toBeNull();
    // Everything the handoff card renders, and everything Razorpay checkout
    // needs (order_id + amount + currency).
    expect(typeof handle!.orderId).toBe("string");
    expect(handle!.railOrderId).toMatch(/^rzp_test_order_/);
    expect(handle!.amountMinor).toBe(secondOffer.totalMinor);
    expect(handle!.currency).toBe("INR");
    // A handle, never a captured payment.
    expect(handle).not.toHaveProperty("captured");
    expect(handle).not.toHaveProperty("status");

    // The offer row is consumed and the session is awaiting the buyer's
    // authorization, not settled by this call.
    const [offerRow] = await db.select().from(offersTable).where(eq(offersTable.id, secondOffer.offerId));
    expect(offerRow!.consumedAt).not.toBeNull();
    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, sessionId));
    expect(session!.state).toBe("AWAITING_PAYMENT");

    const reasonCodes = (
      await db.select().from(auditEventsTable).where(eq(auditEventsTable.sessionId, sessionId))
    ).map((event) => event.reasonCode);
    expect(reasonCodes).toContain("NEGOTIATION_OPENED");
    expect(reasonCodes).toContain("OFFER_ACCEPTED");
    expect(reasonCodes).toContain("ORDER_CREATED");
  });

  it("never serializes a policy internal anywhere the buyer surface can read it", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "AT_RISK" });
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "human-buyer-xyz" });
    const round = await caller.negotiation.propose({
      negotiationId: sessionId,
      message: "What can you do on price?",
    });

    const wire = JSON.stringify(round);
    for (const forbidden of ["floor", "campaignSpend", "perDealCap", "concessionCurve", "availableBudget"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("a checkout the merchant has not flagged reads as unavailable and refuses to open", async () => {
    const { sessionId } = await seedNegotiationSession({ state: "IDLE" });
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const context = await caller.negotiation.getSessionContext({ sessionId });
    expect(context.negotiationAvailable).toBe(false);

    const opened = await caller.negotiation.openNegotiation({
      sessionId,
      buyerAgentId: "human-buyer-idle",
    });
    expect(opened.opened).toBe(false);
    expect(opened.reasonCode).toBe("NOT_AT_RISK");
  });
});
