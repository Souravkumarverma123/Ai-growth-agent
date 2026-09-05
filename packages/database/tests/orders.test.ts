import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { merchantsTable, negotiationSessionsTable, offersTable, ordersTable } from "../schema";
import { attachRailOrder, reserveOrder } from "../repositories/orders";

/**
 * TICKET-302 — offer-to-order uniqueness (PRD §11, CONTRACTS.md §2, §8).
 * "`offer_id -> exactly one order`, enforced by the database." Same
 * real-Postgres harness and fixture-construction pattern as
 * `campaign-budget-reservation.test.ts` / `offer-acceptance.test.ts`
 * (TICKET-107/111): a merchant, a negotiation session, an offer, then
 * `reserveOrder` against the real database — CONTRACTS.md §8, "do not mock
 * the database; use the real one."
 *
 * The concurrency test below is this ticket's own required proof:
 * "concurrent double-create leaves exactly one order." Unlike
 * TICKET-107's concurrency test (which needed N distinct offers, since
 * `campaign_holds.offer_id` is itself unique — one hold per offer), every
 * concurrent attempt here targets the exact SAME `offerId` on purpose: that
 * is the entire invariant under test.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

async function insertMerchant(): Promise<string> {
  const db = await getTestDb();
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-302 orders test merchant" })
    .returning({ id: merchantsTable.id });
  return merchant!.id;
}

async function insertSession(merchantId: string, index: number): Promise<string> {
  const db = await getTestDb();
  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: `orders-test-buyer-${index}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });
  return session!.id;
}

async function insertOffer(params: {
  sessionId: string;
  index: number;
  totalMinor: number;
}): Promise<string> {
  const db = await getTestDb();
  const { sessionId, index, totalMinor } = params;

  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId,
      candidateRef: `orders-test-candidate-${index}`,
      roundIndex: 1,
      basket: fixtureBasket(totalMinor),
      totalMinor,
      tier: 1,
      campaignSpendMinor: 0,
      policyVersion: 1,
      reasonCode: "TIER1_OFFERED",
      expiresAt: new Date(Date.now() + 600_000),
      engineSignature: "ticket-302-test-fixture-signature",
    })
    .returning({ id: offersTable.id });

  return offer!.id;
}

async function ordersFor(offerId: string) {
  const db = await getTestDb();
  return db.select().from(ordersTable).where(eq(ordersTable.offerId, offerId));
}

describe("TICKET-302 — offer-to-order uniqueness", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reserves an order for a fresh offer", async () => {
    const merchantId = await insertMerchant();
    const sessionId = await insertSession(merchantId, 0);
    const offerId = await insertOffer({ sessionId, index: 0, totalMinor: 302_000 });
    const db = await getTestDb();

    const result = await reserveOrder(db, {
      offerId,
      amountMinor: 302_000,
      currency: "INR",
    });

    expect(result.reserved).toBe(true);
    if (result.reserved) {
      expect(result.order.offerId).toBe(offerId);
      expect(result.order.amountMinor).toBe(302_000);
      expect(result.order.currency).toBe("INR");
      expect(result.order.localState).toBe("CREATED");
      expect(result.order.railOrderId).toBeNull();
    }

    const rows = await ordersFor(offerId);
    expect(rows).toHaveLength(1);
  });

  it(
    "a second sequential reservation for the same offer fails at the database " +
      "level and comes back as a clean domain result, never a thrown raw Postgres error",
    async () => {
      const merchantId = await insertMerchant();
      const sessionId = await insertSession(merchantId, 1);
      const offerId = await insertOffer({ sessionId, index: 1, totalMinor: 302_000 });
      const db = await getTestDb();

      const first = await reserveOrder(db, { offerId, amountMinor: 302_000, currency: "INR" });
      expect(first.reserved).toBe(true);

      const second = await reserveOrder(db, { offerId, amountMinor: 302_000, currency: "INR" });
      expect(second).toEqual({ reserved: false, reason: "ORDER_ALREADY_EXISTS" });

      const rows = await ordersFor(offerId);
      expect(rows).toHaveLength(1);
    },
  );

  it(
    "20 concurrent reservations for the SAME offer leave exactly one order row, " +
      "and every losing call gets the clean domain result rather than throwing",
    async () => {
      const merchantId = await insertMerchant();
      const sessionId = await insertSession(merchantId, 2);
      const offerId = await insertOffer({ sessionId, index: 2, totalMinor: 302_000 });
      const db = await getTestDb();

      const ATTEMPT_COUNT = 20;

      const results = await Promise.all(
        Array.from({ length: ATTEMPT_COUNT }, () =>
          reserveOrder(db, { offerId, amountMinor: 302_000, currency: "INR" }),
        ),
      );

      const successes = results.filter((result) => result.reserved);
      const failures = results.filter((result) => !result.reserved);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(ATTEMPT_COUNT - 1);

      for (const failure of failures) {
        expect(failure).toEqual({ reserved: false, reason: "ORDER_ALREADY_EXISTS" });
      }

      // The actual invariant this ticket exists to protect: read back the
      // true, committed state — exactly one row, not merely "results agree."
      const rows = await ordersFor(offerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amountMinor).toBe(302_000);
    },
    30_000,
  );

  it.each([
    ["negative", -100],
    ["zero", 0],
    ["non-integer", 100.5],
  ])("rejects a %s amountMinor before touching the database", async (_label, amountMinor) => {
    const merchantId = await insertMerchant();
    const sessionId = await insertSession(merchantId, 3);
    const offerId = await insertOffer({ sessionId, index: 3, totalMinor: 302_000 });
    const db = await getTestDb();

    await expect(
      reserveOrder(db, { offerId, amountMinor, currency: "INR" }),
    ).rejects.toThrow(/amountMinor must be a positive integer/);

    const rows = await ordersFor(offerId);
    expect(rows).toHaveLength(0);
  });

  it("attachRailOrder persists the rail order id and payload onto the reserved row", async () => {
    const merchantId = await insertMerchant();
    const sessionId = await insertSession(merchantId, 4);
    const offerId = await insertOffer({ sessionId, index: 4, totalMinor: 302_000 });
    const db = await getTestDb();

    const reservation = await reserveOrder(db, {
      offerId,
      amountMinor: 302_000,
      currency: "INR",
    });
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) return;

    const updated = await attachRailOrder(db, {
      orderId: reservation.order.id,
      railOrderId: "order_mock_rzp",
      railPayload: { id: "order_mock_rzp", status: "created" },
    });

    expect(updated?.railOrderId).toBe("order_mock_rzp");
    expect(updated?.railPayload).toEqual({ id: "order_mock_rzp", status: "created" });
  });
});
