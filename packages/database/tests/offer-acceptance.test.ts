import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { merchantsTable, negotiationSessionsTable, offersTable } from "../schema";
import { acceptOffer } from "../repositories/offers";

/**
 * TICKET-111 — offer TTL, single-use, and basket binding (PRD §10.2,
 * CONTRACTS.md §8). "Three refusals that make an offer unreplayable,
 * unreassignable, and perishable" plus the ticket's required concurrency
 * proof: "concurrent double-accept leaves exactly one consumption."
 *
 * Same real-Postgres harness and fixture-construction pattern as
 * `campaign-hold-lifecycle.test.ts` / `campaign-budget-reservation.test.ts`
 * (TICKET-107/108): a merchant, one negotiation_sessions row per offer, then
 * the offer row itself with whatever expiresAt/consumedAt/basket the test
 * needs. CONTRACTS.md §8 — do not mock the database; use the real one.
 */

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

async function insertMerchant(): Promise<string> {
  const db = await getTestDb();
  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-111 offer-acceptance test merchant" })
    .returning({ id: merchantsTable.id });
  return merchant!.id;
}

async function insertSession(merchantId: string, index: number): Promise<string> {
  const db = await getTestDb();
  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: `offer-acceptance-test-buyer-${index}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });
  return session!.id;
}

async function insertOffer(params: {
  sessionId: string;
  index: number;
  basket: Basket;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<string> {
  const db = await getTestDb();
  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: params.sessionId,
      candidateRef: `candidate-${params.index}`,
      roundIndex: 1,
      basket: params.basket,
      totalMinor: 302_000,
      tier: 1,
      campaignSpendMinor: 0,
      policyVersion: 1,
      reasonCode: "TIER1_OFFERED",
      expiresAt: params.expiresAt,
      consumedAt: params.consumedAt ?? null,
      engineSignature: "ticket-111-test-fixture-signature",
    })
    .returning({ id: offersTable.id });
  return offer!.id;
}

/** One merchant + one session + one offer, ready for a single test to accept. */
async function seedOffer(params: {
  index: number;
  basket?: Basket;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<string> {
  const merchantId = await insertMerchant();
  const sessionId = await insertSession(merchantId, params.index);
  return insertOffer({
    sessionId,
    index: params.index,
    basket: params.basket ?? fixtureBasket(),
    expiresAt: params.expiresAt,
    consumedAt: params.consumedAt,
  });
}

describe("TICKET-111 — acceptOffer (TTL, single-use, basket binding)", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("accepts a valid, unexpired, unconsumed offer whose basket matches exactly, setting consumed_at", async () => {
    const now = new Date();
    const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

    const db = await getTestDb();
    const result = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.offer.consumedAt).not.toBeNull();
      expect(result.offer.id).toBe(offerId);
    }

    const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
    expect(row!.consumedAt).not.toBeNull();
  });

  describe("OFFER_EXPIRED", () => {
    it("refuses an offer past its 600s TTL", async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() - 1) });

      const db = await getTestDb();
      const result = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });

      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });

      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt).toBeNull();
    });

    it("accepts at exactly the expiry instant — the boundary is inclusive", async () => {
      const expiresAt = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt });

      const db = await getTestDb();
      const result = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now: expiresAt });

      expect(result.accepted).toBe(true);
    });

    it("refuses one millisecond past the expiry instant", async () => {
      const expiresAt = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket(),
        now: new Date(expiresAt.getTime() + 1),
      });

      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    });
  });

  describe("OFFER_ALREADY_CONSUMED", () => {
    it("refuses a second sequential accept of the same offer", async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

      const db = await getTestDb();
      const first = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(first.accepted).toBe(true);
      if (!first.accepted) throw new Error("unreachable — asserted above");
      const consumedAtAfterFirst = first.offer.consumedAt?.getTime();

      const second = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(second).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });

      // consumed_at set exactly once — the second call never touched it.
      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt?.getTime()).toBe(consumedAtAfterFirst);
    });

    it("refuses an offer that was already consumed before this call ever ran", async () => {
      const now = new Date();
      const offerId = await seedOffer({
        index: 0,
        expiresAt: new Date(now.getTime() + 600_000),
        consumedAt: new Date(now.getTime() - 1000),
      });

      const db = await getTestDb();
      const result = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
    });
  });

  describe("BASKET_MISMATCH", () => {
    it("refuses when the accepted basket has a different SKU, and does not consume the offer", async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({
          lines: [{ skuId: OTHER_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
        }),
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });

      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt).toBeNull();

      // The offer is still live: a correct accept afterwards still succeeds.
      const retry = await acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now });
      expect(retry.accepted).toBe(true);
    });

    it("refuses when the accepted basket has a different quantity", async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({
          lines: [{ skuId: DUMMY_SKU_ID, quantity: 2, unitPriceMinor: 302_000 }],
        }),
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses when the accepted basket has a different unit price", async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({
          lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor: 301_999 }],
        }),
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses when the accepted basket has a different commitment set", async () => {
      const now = new Date();
      const offerId = await seedOffer({
        index: 0,
        basket: fixtureBasket({ commitments: ["PREPAID"] }),
        expiresAt: new Date(now.getTime() + 600_000),
      });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        acceptedBasket: fixtureBasket({ commitments: [] }),
        now,
      });

      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("accepts when the commitment set matches but is listed in a different order", async () => {
      const now = new Date();
      const offerId = await seedOffer({
        index: 0,
        basket: fixtureBasket({ commitments: ["PREPAID", "NON_RETURNABLE"] }),
        expiresAt: new Date(now.getTime() + 600_000),
      });

      const db = await getTestDb();
      const result = await acceptOffer(db, {
        offerId,
        // Same set, reversed order — commitments carry no meaningful order
        // of their own (see evaluateOfferAcceptance's basketsMatch), so this
        // must accept, not be misreported as OFFER_ALREADY_CONSUMED.
        acceptedBasket: fixtureBasket({ commitments: ["NON_RETURNABLE", "PREPAID"] }),
        now,
      });

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.offer.consumedAt).not.toBeNull();
      }
    });
  });

  it("a nonexistent offer id throws rather than returning a coded refusal", async () => {
    const db = await getTestDb();
    await expect(
      acceptOffer(db, { offerId: randomUUID(), acceptedBasket: fixtureBasket() }),
    ).rejects.toThrow();
  });

  it(
    "concurrent double-accept: 25 simultaneous accept attempts against the same offer " +
      "leave exactly one consumption",
    async () => {
      const now = new Date();
      const offerId = await seedOffer({ index: 0, expiresAt: new Date(now.getTime() + 600_000) });

      const db = await getTestDb();
      const ATTEMPTS = 25;

      const results = await Promise.all(
        Array.from({ length: ATTEMPTS }, () =>
          acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now }),
        ),
      );

      const acceptedCount = results.filter((r) => r.accepted).length;
      expect(acceptedCount).toBe(1);

      const refusedReasons = results.filter((r) => !r.accepted).map((r) => (r.accepted ? null : r.reasonCode));
      expect(refusedReasons).toHaveLength(ATTEMPTS - 1);
      expect(refusedReasons.every((code) => code === "OFFER_ALREADY_CONSUMED")).toBe(true);

      // Exactly one consumption is visible in the committed row, not just in
      // the in-process results.
      const [row] = await db.select().from(offersTable).where(eq(offersTable.id, offerId));
      expect(row!.consumedAt).not.toBeNull();
    },
    30_000,
  );

  it(
    "concurrent accepts against DIFFERENT offers all succeed independently — " +
      "the single-use guarantee is per-offer, not a global lock",
    async () => {
      const now = new Date();
      const OFFER_COUNT = 10;
      const offerIds = await Promise.all(
        Array.from({ length: OFFER_COUNT }, (_, index) =>
          seedOffer({ index, expiresAt: new Date(now.getTime() + 600_000) }),
        ),
      );

      const db = await getTestDb();
      const results = await Promise.all(
        offerIds.map((offerId) => acceptOffer(db, { offerId, acceptedBasket: fixtureBasket(), now })),
      );

      expect(results.every((r) => r.accepted)).toBe(true);
    },
    30_000,
  );
});
