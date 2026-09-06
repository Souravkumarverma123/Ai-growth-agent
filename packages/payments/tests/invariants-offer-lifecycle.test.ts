import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import { merchantsTable, negotiationSessionsTable, offersTable, ordersTable } from "@repo/database/schema";
import { acceptOffer } from "@repo/database/repositories/offers";
import { attachRailOrder, reserveOrder } from "@repo/database/repositories/orders";

/**
 * TICKET-602 — the offer-lifecycle-and-idempotency invariant suite,
 * database-enforced half (PRD §10.2, §11, §21; Settled by Q13).
 *
 * The pure accept-time *rule* — the three closed refusal codes and the fixed
 * order they are checked in — is proven in
 * `packages/policy/tests/invariants-offer-lifecycle.test.ts`. This file owns
 * everything that is only true because a real Postgres enforces it:
 *
 *   1. one offer cannot create multiple orders, including under concurrency
 *   2. an expired offer cannot be consumed  (transactional CAS, not a snapshot)
 *   3. a consumed offer cannot be consumed again, even under a genuine race
 *   4. a basket altered between mint and accept is refused, and the offer
 *      stays live for a correct accept afterwards
 *
 * Same real-Postgres harness and env dance as `reconcile-order.test.ts`
 * (TICKET-304): `vitest.config.ts` pins `DATABASE_URL` to an inert
 * placeholder for this package's mocked tests, so the genuine value —
 * preserved as `REAL_DATABASE_URL` — is restored before the test-db harness
 * is dynamically imported. CONTRACTS.md §8: "do not mock the database; use
 * the real one." `packages/payments/vitest.config.ts` already carries
 * `fileParallelism: false` (ISSUE-014), so this third real-DB file in the
 * package does not race the other two on the shared sibling database.
 *
 * The functions under test — `reserveOrder` / `attachRailOrder` / `acceptOffer`
 * — live in `packages/database`, but the offer→order path is
 * `packages/payments`' own (`createOrder`, `src/create-order.ts`, which
 * delegates straight to `reserveOrder` via `src/order-repository.ts`). This
 * file is where TICKET-602 lists that package as `Affected`;
 * `reconcile-order.test.ts` set the precedent of a payments test exercising a
 * `@repo/database` repository directly against real Postgres (ISSUE-012
 * sub-issue 12b: `createOrder`'s own singleton `db` can't reach the sibling
 * test database, so the repositories it delegates to are driven directly).
 * `createOrder`'s wrapper composition (reserve strictly before the Razorpay
 * POST) is covered behaviourally in `create-order.test.ts`.
 *
 * All money is integer minor units (paise) (CONTRACTS.md §3).
 */

let closeTestDb: typeof import("@repo/database/testing/db").closeTestDb;
let getTestDb: typeof import("@repo/database/testing/db").getTestDb;
let truncateAllTables: typeof import("@repo/database/testing/db").truncateAllTables;

const DUMMY_SKU_ID = randomUUID();
const OTHER_SKU_ID = randomUUID();

function fixtureBasket(overrides?: Partial<Basket>): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
    ...overrides,
  };
}

type Db = Awaited<ReturnType<typeof getTestDb>>;

// `truncateAllTables` runs before every test, and nothing here relies on a
// unique `buyerAgentId` / `candidateRef` — so the fixtures carry no
// per-test index, unlike the older `offer-acceptance.test.ts`.
async function seedOffer(
  db: Db,
  params: {
    basket?: Basket;
    totalMinor?: number;
    expiresAt?: Date;
    consumedAt?: Date | null;
  } = {},
): Promise<string> {
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-602 offer-lifecycle test merchant" })
    .returning({ id: merchantsTable.id });

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId: merchant!.id,
      buyerAgentId: `ticket-602-buyer-${randomUUID()}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: session!.id,
      candidateRef: "ticket-602-candidate",
      roundIndex: 1,
      basket: params.basket ?? fixtureBasket(),
      totalMinor: params.totalMinor ?? 302_000,
      tier: 1,
      campaignSpendMinor: 0,
      policyVersion: 1,
      reasonCode: "TIER1_OFFERED",
      expiresAt: params.expiresAt ?? new Date(Date.now() + 600_000),
      consumedAt: params.consumedAt ?? null,
      engineSignature: "ticket-602-test-fixture-signature",
    })
    .returning({ id: offersTable.id });
  return offer!.id;
}

async function ordersFor(db: Db, offerId: string) {
  return db.select().from(ordersTable).where(eq(ordersTable.offerId, offerId));
}

describe("TICKET-602 — offer lifecycle and idempotency (database-enforced)", () => {
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
  // Invariant 1 — one offer, at most one order, including under concurrency
  // =========================================================================

  describe("INVARIANT: one offer can create at most one order (PRD §11, §21.9)", () => {
    // 20 exceeds the node-postgres pool (max 10), so the surplus attempts are
    // genuinely queued and only reach the unique index after the winner has
    // committed — the case that most needs to still come back as a clean
    // domain result rather than a raw error.
    it.each([2, 5, 20])(
      "%i concurrent reservations for the SAME offer leave exactly one order row",
      async (attemptCount) => {
        const db = await getTestDb();
        const offerId = await seedOffer(db, { totalMinor: 250_000 });

        const results = await Promise.all(
          Array.from({ length: attemptCount }, () => reserveOrder(db, { offerId })),
        );

        const reserved = results.filter((r) => r.reserved);
        const rejected = results.filter((r) => !r.reserved);
        expect(reserved).toHaveLength(1);
        expect(rejected).toHaveLength(attemptCount - 1);
        for (const r of rejected) {
          // A clean domain result, never a raw Postgres error escaping.
          expect(r.reserved).toBe(false);
          if (!r.reserved) {
            expect(r.reason).toBe("ORDER_ALREADY_EXISTS");
            expect(r.existingOrder.offerId).toBe(offerId);
          }
        }

        // The real, committed state — not merely "the in-process results agree".
        const rows = await ordersFor(db, offerId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.amountMinor).toBe(250_000);
      },
      30_000,
    );

    it("a sequential retry after a successful reservation never produces a second order", async () => {
      const db = await getTestDb();
      const offerId = await seedOffer(db);

      const first = await reserveOrder(db, { offerId });
      expect(first.reserved).toBe(true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const retry = await reserveOrder(db, { offerId });
        expect(retry.reserved).toBe(false);
      }

      expect(await ordersFor(db, offerId)).toHaveLength(1);
    });

    it("attaching a rail order id to the one reservation does not open the door to a second order", async () => {
      const db = await getTestDb();
      const offerId = await seedOffer(db);

      const reservation = await reserveOrder(db, { offerId });
      if (!reservation.reserved) throw new Error("expected the first reservation to succeed");
      await attachRailOrder(db, {
        orderId: reservation.order.id,
        railOrderId: `rzp_order_${randomUUID()}`,
        railPayload: { status: "created" },
      });

      const second = await reserveOrder(db, { offerId });
      expect(second.reserved).toBe(false);
      if (!second.reserved) {
        // The caller can tell a completed order from a stuck reservation.
        expect(second.existingOrder.railOrderId).not.toBeNull();
      }
      expect(await ordersFor(db, offerId)).toHaveLength(1);
    });

    it("the second order for one offer is stopped by the database itself, not by application logic", async () => {
      const db = await getTestDb();
      const offerId = await seedOffer(db);

      await db.insert(ordersTable).values({ offerId, amountMinor: 302_000, currency: "INR" });

      // A raw INSERT that bypasses every application-level check still cannot
      // create a second row — the guarantee is our own unique index on
      // orders.offer_id (models/payment.ts: "IDEMPOTENCY IS OURS, NOT THE
      // RAIL'S"), enforced by Postgres, so a duplicate is rejected outright.
      await expect(
        db.insert(ordersTable).values({ offerId, amountMinor: 302_000, currency: "INR" }),
      ).rejects.toThrow();

      expect(await ordersFor(db, offerId)).toHaveLength(1);
    });

    it("concurrent reservations against DIFFERENT offers all succeed — the guarantee is per-offer, not a global lock", async () => {
      const db = await getTestDb();
      const offerIds = await Promise.all(Array.from({ length: 8 }, () => seedOffer(db)));

      const results = await Promise.all(offerIds.map((offerId) => reserveOrder(db, { offerId })));
      expect(results.every((r) => r.reserved)).toBe(true);
      for (const offerId of offerIds) {
        expect(await ordersFor(db, offerId)).toHaveLength(1);
      }
    });
  });

  // =========================================================================
  // Invariant 2 — an expired offer cannot be consumed
  // =========================================================================

  describe("INVARIANT: an expired offer cannot be consumed (PRD §10.2, §21.10)", () => {
    it("refuses an accept past the 600s TTL and leaves consumed_at null", async () => {
      const db = await getTestDb();
      const now = new Date();
      const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() - 1) });

      const result = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });

      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt).toBeNull();
    });

    it("the CAS boundary matches the pure rule: accepted exactly at expiresAt, refused one ms later", async () => {
      const db = await getTestDb();

      const atInstant = await seedOffer(db, { expiresAt: new Date() });
      const [atRow] = await db.select().from(offersTable).where(eq(offersTable.id, atInstant));
      const acceptedAt = await acceptOffer(db, {
        offerId: atInstant,
        acceptedBasket: fixtureBasket(),
        now: atRow!.expiresAt,
      });
      expect(acceptedAt.accepted).toBe(true);

      const pastInstant = await seedOffer(db, { expiresAt: new Date() });
      const [pastRow] = await db.select().from(offersTable).where(eq(offersTable.id, pastInstant));
      const refused = await acceptOffer(db, {
        offerId: pastInstant,
        acceptedBasket: fixtureBasket(),
        now: new Date(pastRow!.expiresAt.getTime() + 1),
      });
      expect(refused).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    });
  });

  // =========================================================================
  // Invariant 3 — a consumed offer cannot be consumed again, under a race
  // =========================================================================

  describe("INVARIANT: an offer is consumed at most once, ever, even under concurrency (PRD §10.2, §21.10)", () => {
    it.each([2, 10, 25])(
      "%i simultaneous accepts of one valid offer leave exactly one consumption",
      async (attemptCount) => {
        const db = await getTestDb();
        const now = new Date();
        const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() + 600_000) });

        const results = await Promise.all(
          Array.from({ length: attemptCount }, () =>
            acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now }),
          ),
        );

        expect(results.filter((r) => r.accepted)).toHaveLength(1);
        const losers = results.filter((r) => !r.accepted);
        expect(losers).toHaveLength(attemptCount - 1);
        expect(
          losers.every((r) => !r.accepted && r.reasonCode === "OFFER_ALREADY_CONSUMED"),
        ).toBe(true);

        const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
        expect(row!.consumedAt).not.toBeNull();
      },
      30_000,
    );

    it("a second sequential accept is refused and never moves consumed_at", async () => {
      const db = await getTestDb();
      const now = new Date();
      const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() + 600_000) });

      const first = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      if (!first.accepted) throw new Error("expected the first accept to succeed");
      const consumedAt = first.offer.consumedAt?.getTime();

      const second = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(second).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });

      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt?.getTime()).toBe(consumedAt);
    });
  });

  // =========================================================================
  // Invariant 4 — a basket altered between mint and accept is refused
  // =========================================================================

  describe("INVARIANT: a basket altered between mint and accept is refused (PRD §10.2, §21.10)", () => {
    const mismatches: ReadonlyArray<{ name: string; acceptedBasket: () => Basket }> = [
      { name: "a different SKU", acceptedBasket: () => fixtureBasket({ lines: [{ skuId: OTHER_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }] }) },
      { name: "a different quantity", acceptedBasket: () => fixtureBasket({ lines: [{ skuId: DUMMY_SKU_ID, quantity: 2, unitPriceMinor: 302_000 }] }) },
      { name: "a one-paise price change", acceptedBasket: () => fixtureBasket({ lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor: 301_999 }] }) },
      { name: "an extra line", acceptedBasket: () => fixtureBasket({ lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }, { skuId: OTHER_SKU_ID, quantity: 1, unitPriceMinor: 5_000 }] }) },
      { name: "an added commitment", acceptedBasket: () => fixtureBasket({ commitments: ["PREPAID"] }) },
    ];

    it.each(mismatches)("refuses $name and never consumes the offer", async ({ acceptedBasket }) => {
      const db = await getTestDb();
      const now = new Date();
      const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() + 600_000) });

      const result = await acceptOffer(db, { offerId, acceptedBasket: acceptedBasket(), now });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });

      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt).toBeNull();
    });

    it("a mismatched accept leaves the offer live — the exact basket still accepts afterwards", async () => {
      const db = await getTestDb();
      const now = new Date();
      const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() + 600_000) });

      const wrong = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({ lines: [{ skuId: OTHER_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }] }),
        now,
      });
      expect(wrong).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });

      const right = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(right.accepted).toBe(true);
    });

    it("a commitment set in a different order is NOT a mismatch (order-insensitive, per the pure rule)", async () => {
      const db = await getTestDb();
      const now = new Date();
      const offerId = await seedOffer(db, {
        basket: fixtureBasket({ commitments: ["PREPAID", "NON_RETURNABLE"] }),
        expiresAt: new Date(now.getTime() + 600_000),
      });

      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({ commitments: ["NON_RETURNABLE", "PREPAID"] }),
        now,
      });
      expect(result.accepted).toBe(true);
    });
  });

  // =========================================================================
  // The whole lifecycle as one timeline — the invariants compose
  // =========================================================================

  it("a single offer's full lifecycle: bad accepts bounce, one good accept consumes, one order is reserved, everything after is refused", async () => {
    const db = await getTestDb();
    const now = new Date();
    const offerId = await seedOffer(db, { expiresAt: new Date(now.getTime() + 600_000) });

    // Wrong basket — refused, offer still live.
    expect(
      await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({ lines: [{ skuId: OTHER_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }] }),
        now,
      }),
    ).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });

    // Correct accept — consumes exactly once.
    const accept = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
    expect(accept.accepted).toBe(true);

    // Exactly one order for the consumed offer.
    const reservation = await reserveOrder(db, { offerId });
    expect(reservation.reserved).toBe(true);

    // Every further attempt — re-accept or re-order — is refused.
    expect(await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now })).toEqual({
      accepted: false,
      reasonCode: "OFFER_ALREADY_CONSUMED",
    });
    expect((await reserveOrder(db, { offerId })).reserved).toBe(false);

    expect(await ordersFor(db, offerId)).toHaveLength(1);
    const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
    expect(row!.consumedAt).not.toBeNull();
  });
});
