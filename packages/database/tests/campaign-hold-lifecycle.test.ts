import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import {
  campaignHoldsTable,
  merchantPoliciesTable,
  merchantsTable,
  negotiationSessionsTable,
  offersTable,
} from "../schema";
import {
  commitCampaignHold,
  releaseCampaignHold,
  reserveCampaignBudget,
} from "../repositories/campaign-holds";

/**
 * TICKET-108 — campaign hold lifecycle: release and commit, the two
 * transitions out of `RESERVED` that TICKET-107 did not build.
 *
 * Same real-Postgres harness and fixture-construction pattern as
 * `campaign-budget-reservation.test.ts` (TICKET-107): a merchant + policy
 * row, a negotiation_sessions + offers row per hold, then
 * `reserveCampaignBudget` to actually create the `RESERVED` hold under test.
 * CONTRACTS.md §8 — do not mock the database; use the real one.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

async function insertMerchantWithPolicy(params: {
  campaignBudgetTotalMinor: number;
  perDealCapMinor: number;
}): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-108 hold-lifecycle test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: params.campaignBudgetTotalMinor,
    perDealCapMinor: params.perDealCapMinor,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

/** One negotiation session + one offer, modeling one tier-2 mint. */
async function insertSessionAndOffer(params: {
  merchantId: string;
  index: number;
  shortfallMinor: number;
}): Promise<string> {
  const db = await getTestDb();
  const { merchantId, index, shortfallMinor } = params;

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: `hold-lifecycle-test-buyer-${index}`,
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  const expiresAt = new Date(Date.now() + 600_000);

  const [offer] = await db
    .insert(offersTable)
    .values({
      sessionId: session!.id,
      candidateRef: `tier2-candidate-${index}`,
      roundIndex: 2,
      basket: fixtureBasket(230_000),
      totalMinor: 230_000,
      tier: 2,
      campaignSpendMinor: shortfallMinor,
      policyVersion: 1,
      reasonCode: "DILUTION_WITHIN_CAPS",
      expiresAt,
      engineSignature: "ticket-108-test-fixture-signature",
    })
    .returning({ id: offersTable.id });

  return offer!.id;
}

async function sumOutstandingMinor(merchantId: string): Promise<number> {
  const db = await getTestDb();
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${campaignHoldsTable.amountMinor}), 0)` })
    .from(campaignHoldsTable)
    .where(
      and(
        eq(campaignHoldsTable.merchantId, merchantId),
        inArray(campaignHoldsTable.state, ["RESERVED", "COMMITTED"]),
      ),
    );
  return Number(row!.total);
}

/** Reserves a hold via TICKET-107's function, for use as this test's fixture. */
async function reserveHold(params: {
  merchantId: string;
  offerId: string;
  amountMinor: number;
}): Promise<string> {
  const db = await getTestDb();
  const result = await reserveCampaignBudget(db, {
    merchantId: params.merchantId,
    offerId: params.offerId,
    amountMinor: params.amountMinor,
    expiresAt: new Date(Date.now() + 600_000),
  });
  if (!result.reserved) {
    throw new Error(`test fixture: reservation unexpectedly failed (${result.reasonCode})`);
  }
  return result.hold.id;
}

describe("TICKET-108 — campaign hold lifecycle (release / commit)", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("full lifecycle across all three terminal release paths, plus commit", () => {
    it.each([
      ["buyer decline of a tier-2 offer"],
      ["TTL expiry"],
      ["payment failure"],
    ])(
      "release restores `available` — simulating %s",
      async () => {
        const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000; // ₹1,000
        const PER_DEAL_CAP_MINOR = 50_000;
        const AMOUNT_MINOR = 30_000; // ₹300

        const merchantId = await insertMerchantWithPolicy({
          campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
          perDealCapMinor: PER_DEAL_CAP_MINOR,
        });

        const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: AMOUNT_MINOR });
        const holdId = await reserveHold({ merchantId, offerId, amountMinor: AMOUNT_MINOR });

        // While RESERVED, a second reservation for an amount that only fits
        // if the first is released must fail.
        const offerId2 = await insertSessionAndOffer({ merchantId, index: 1, shortfallMinor: AMOUNT_MINOR });
        const db = await getTestDb();
        const blockedAttempt = await reserveCampaignBudget(db, {
          merchantId,
          offerId: offerId2,
          amountMinor: CAMPAIGN_BUDGET_TOTAL_MINOR - AMOUNT_MINOR + 1, // exceeds what's left
          expiresAt: new Date(Date.now() + 600_000),
        });
        expect(blockedAttempt.reserved).toBe(false);

        // The release, regardless of which real-world cause triggered it
        // (decline / expiry / payment failure), is the same DB-level call.
        const releaseResult = await releaseCampaignHold(db, holdId);
        expect(releaseResult.resolved).toBe(true);
        if (releaseResult.resolved) {
          expect(releaseResult.hold.state).toBe("RELEASED");
          expect(releaseResult.hold.resolvedAt).not.toBeNull();
        }

        // `available` is restored: a fresh reservation for the full budget
        // now succeeds again, where it wouldn't have while RESERVED.
        const offerId3 = await insertSessionAndOffer({ merchantId, index: 2, shortfallMinor: CAMPAIGN_BUDGET_TOTAL_MINOR });
        const afterReleaseResult = await reserveCampaignBudget(db, {
          merchantId,
          offerId: offerId3,
          amountMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
          expiresAt: new Date(Date.now() + 600_000),
        });
        expect(afterReleaseResult.reserved).toBe(true);

        const outstandingMinor = await sumOutstandingMinor(merchantId);
        expect(outstandingMinor).toBe(CAMPAIGN_BUDGET_TOTAL_MINOR);
      },
    );
  });

  it("commit keeps `available` reduced (a committed hold still counts against available)", async () => {
    const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
    const PER_DEAL_CAP_MINOR = 50_000;
    const AMOUNT_MINOR = 40_000;

    const merchantId = await insertMerchantWithPolicy({
      campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
    });

    const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: AMOUNT_MINOR });
    const holdId = await reserveHold({ merchantId, offerId, amountMinor: AMOUNT_MINOR });

    const db = await getTestDb();
    const commitResult = await commitCampaignHold(db, holdId);
    expect(commitResult.resolved).toBe(true);
    if (commitResult.resolved) {
      expect(commitResult.hold.state).toBe("COMMITTED");
      expect(commitResult.hold.resolvedAt).not.toBeNull();
    }

    // available = total - reserved - committed. COMMITTED still counts.
    const outstandingMinor = await sumOutstandingMinor(merchantId);
    expect(outstandingMinor).toBe(AMOUNT_MINOR);

    // A subsequent reservation that would only fit if the committed amount
    // were released must still fail — commit is not a release.
    const offerId2 = await insertSessionAndOffer({ merchantId, index: 1, shortfallMinor: AMOUNT_MINOR });
    const followupResult = await reserveCampaignBudget(db, {
      merchantId,
      offerId: offerId2,
      amountMinor: CAMPAIGN_BUDGET_TOTAL_MINOR - AMOUNT_MINOR + 1,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(followupResult.reserved).toBe(false);
  });

  it(
    "a RESERVED hold past its expires_at is excluded from `available` even without an explicit release",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
      const PER_DEAL_CAP_MINOR = 100_000;
      const AMOUNT_MINOR = 70_000;

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const db = await getTestDb();

      // Reserve, then simulate an abandoned offer by moving expires_at into
      // the past directly — no `releaseCampaignHold` call, so the row stays
      // RESERVED. Nothing in this codebase currently sweeps it to RELEASED.
      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: AMOUNT_MINOR });
      const holdId = await reserveHold({ merchantId, offerId, amountMinor: AMOUNT_MINOR });
      await db
        .update(campaignHoldsTable)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(campaignHoldsTable.id, holdId));

      // A second reservation that would only fit if the first hold's amount
      // were excluded must still succeed, because that first hold is expired.
      const offerId2 = await insertSessionAndOffer({ merchantId, index: 1, shortfallMinor: AMOUNT_MINOR });
      const secondResult = await reserveCampaignBudget(db, {
        merchantId,
        offerId: offerId2,
        amountMinor: AMOUNT_MINOR,
        expiresAt: new Date(Date.now() + 600_000),
      });
      expect(secondResult.reserved).toBe(true);

      // The expired hold's row is untouched (still RESERVED) — this is
      // exclusion from the availability sum, not an implicit release.
      const [expiredHold] = await db
        .select()
        .from(campaignHoldsTable)
        .where(eq(campaignHoldsTable.id, holdId));
      expect(expiredHold!.state).toBe("RESERVED");
    },
  );

  it(
    "committing a hold past its expires_at is a safe no-op, even though it is still RESERVED — it must not double-count against `available` once a later reservation has reused its slot",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
      const PER_DEAL_CAP_MINOR = 100_000;
      const AMOUNT_MINOR = 70_000;

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const db = await getTestDb();

      // Reserve, then expire it in place (no release), exactly as in the
      // "excluded from `available`" case above.
      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: AMOUNT_MINOR });
      const holdId = await reserveHold({ merchantId, offerId, amountMinor: AMOUNT_MINOR });
      await db
        .update(campaignHoldsTable)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(campaignHoldsTable.id, holdId));

      // A later reservation reuses the expired hold's excluded budget.
      const offerId2 = await insertSessionAndOffer({ merchantId, index: 1, shortfallMinor: AMOUNT_MINOR });
      const secondResult = await reserveCampaignBudget(db, {
        merchantId,
        offerId: offerId2,
        amountMinor: AMOUNT_MINOR,
        expiresAt: new Date(Date.now() + 600_000),
      });
      expect(secondResult.reserved).toBe(true);

      // A late payment-capture event now tries to commit the original,
      // still-RESERVED-but-expired hold. It must be rejected: committing it
      // would move it into the unconditionally-counted COMMITTED state,
      // double-counting the same budget slot the second reservation already
      // claimed.
      const commitResult = await commitCampaignHold(db, holdId);
      expect(commitResult.resolved).toBe(false);

      const [hold] = await db
        .select()
        .from(campaignHoldsTable)
        .where(eq(campaignHoldsTable.id, holdId));
      expect(hold!.state).toBe("RESERVED");
    },
  );

  it(
    "committing an expired hold races a concurrent reservation reusing its slot: the two never both count the same budget, whichever order the row lock resolves in",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
      const PER_DEAL_CAP_MINOR = 100_000;
      const AMOUNT_MINOR = 70_000;

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const db = await getTestDb();

      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: AMOUNT_MINOR });
      const holdId = await reserveHold({ merchantId, offerId, amountMinor: AMOUNT_MINOR });
      await db
        .update(campaignHoldsTable)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(campaignHoldsTable.id, holdId));

      // Fire the late commit and the budget-reusing reservation at the same
      // time. Without commitCampaignHold locking the same merchant_policies
      // row reserveCampaignBudget locks, these run as two fully
      // unsynchronized transactions and can both succeed — the exact race
      // this test guards against.
      const offerId2 = await insertSessionAndOffer({ merchantId, index: 1, shortfallMinor: AMOUNT_MINOR });
      const [commitResult, reserveResult] = await Promise.all([
        commitCampaignHold(db, holdId),
        reserveCampaignBudget(db, {
          merchantId,
          offerId: offerId2,
          amountMinor: AMOUNT_MINOR,
          expiresAt: new Date(Date.now() + 600_000),
        }),
      ]);

      // The already-expired hold must never win the commit, regardless of
      // which transaction acquired the merchant_policies lock first.
      expect(commitResult.resolved).toBe(false);
      // The reservation has genuine expired budget to reclaim either way,
      // so it must succeed.
      expect(reserveResult.reserved).toBe(true);

      const [hold] = await db
        .select()
        .from(campaignHoldsTable)
        .where(eq(campaignHoldsTable.id, holdId));
      expect(hold!.state).toBe("RESERVED");
    },
    30_000,
  );

  describe("never double-released or double-committed", () => {
    it(
      "two concurrent release attempts on the same hold: exactly one wins, the other is a safe no-op",
      async () => {
        const merchantId = await insertMerchantWithPolicy({
          campaignBudgetTotalMinor: 100_000,
          perDealCapMinor: 50_000,
        });
        const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: 20_000 });
        const holdId = await reserveHold({ merchantId, offerId, amountMinor: 20_000 });

        const db = await getTestDb();
        const [resultA, resultB] = await Promise.all([
          releaseCampaignHold(db, holdId),
          releaseCampaignHold(db, holdId),
        ]);

        const resolvedCount = [resultA, resultB].filter((r) => r.resolved).length;
        expect(resolvedCount).toBe(1);

        // The final row state is RELEASED exactly, never anything else,
        // and there is exactly one hold row for this offer.
        const holds = await db
          .select()
          .from(campaignHoldsTable)
          .where(eq(campaignHoldsTable.offerId, offerId));
        expect(holds).toHaveLength(1);
        expect(holds[0]!.state).toBe("RELEASED");
      },
      30_000,
    );

    it(
      "one release racing one commit on the same hold: exactly one wins, the other is a safe no-op",
      async () => {
        const merchantId = await insertMerchantWithPolicy({
          campaignBudgetTotalMinor: 100_000,
          perDealCapMinor: 50_000,
        });
        const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: 20_000 });
        const holdId = await reserveHold({ merchantId, offerId, amountMinor: 20_000 });

        const db = await getTestDb();
        const [releaseResult, commitResult] = await Promise.all([
          releaseCampaignHold(db, holdId),
          commitCampaignHold(db, holdId),
        ]);

        const resolvedCount = [releaseResult, commitResult].filter((r) => r.resolved).length;
        expect(resolvedCount).toBe(1);

        const holds = await db
          .select()
          .from(campaignHoldsTable)
          .where(eq(campaignHoldsTable.offerId, offerId));
        expect(holds).toHaveLength(1);
        // Whichever won, the row's final state matches exactly one of the two —
        // never something else, never both applied, never neither.
        expect(["RELEASED", "COMMITTED"]).toContain(holds[0]!.state);
        if (releaseResult.resolved) {
          expect(holds[0]!.state).toBe("RELEASED");
        } else {
          expect(holds[0]!.state).toBe("COMMITTED");
        }
      },
      30_000,
    );

    it("releasing an already-committed hold is a safe no-op, never a double-transition", async () => {
      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: 100_000,
        perDealCapMinor: 50_000,
      });
      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: 20_000 });
      const holdId = await reserveHold({ merchantId, offerId, amountMinor: 20_000 });

      const db = await getTestDb();
      const commitResult = await commitCampaignHold(db, holdId);
      expect(commitResult.resolved).toBe(true);

      const releaseAfterCommit = await releaseCampaignHold(db, holdId);
      expect(releaseAfterCommit.resolved).toBe(false);

      const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.id, holdId));
      expect(hold!.state).toBe("COMMITTED");
    });

    it("committing an already-released hold is a safe no-op, never a double-transition", async () => {
      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: 100_000,
        perDealCapMinor: 50_000,
      });
      const offerId = await insertSessionAndOffer({ merchantId, index: 0, shortfallMinor: 20_000 });
      const holdId = await reserveHold({ merchantId, offerId, amountMinor: 20_000 });

      const db = await getTestDb();
      const releaseResult = await releaseCampaignHold(db, holdId);
      expect(releaseResult.resolved).toBe(true);

      const commitAfterRelease = await commitCampaignHold(db, holdId);
      expect(commitAfterRelease.resolved).toBe(false);

      const [hold] = await db.select().from(campaignHoldsTable).where(eq(campaignHoldsTable.id, holdId));
      expect(hold!.state).toBe("RELEASED");
    });

    it("resolving a nonexistent hold id is a safe no-op", async () => {
      const db = await getTestDb();
      const releaseResult = await releaseCampaignHold(db, randomUUID());
      expect(releaseResult.resolved).toBe(false);

      const commitResult = await commitCampaignHold(db, randomUUID());
      expect(commitResult.resolved).toBe(false);
    });
  });

  it(
    "denial-of-budget: repeatedly reserving then releasing the same amount 50 times " +
      "cannot permanently reduce `available`",
    async () => {
      const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000; // ₹1,000
      const PER_DEAL_CAP_MINOR = 50_000;
      const AMOUNT_MINOR = 30_000; // ₹300 — well within budget, repeated many times
      const ITERATIONS = 50;

      const merchantId = await insertMerchantWithPolicy({
        campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        perDealCapMinor: PER_DEAL_CAP_MINOR,
      });

      const db = await getTestDb();
      const outstandingBefore = await sumOutstandingMinor(merchantId);
      expect(outstandingBefore).toBe(0);

      for (let i = 0; i < ITERATIONS; i++) {
        const offerId = await insertSessionAndOffer({ merchantId, index: i, shortfallMinor: AMOUNT_MINOR });
        const reserveResult = await reserveCampaignBudget(db, {
          merchantId,
          offerId,
          amountMinor: AMOUNT_MINOR,
          expiresAt: new Date(Date.now() + 600_000),
        });

        // Each iteration must succeed: if abandoned holds were leaking
        // budget, later iterations would start failing well before 50.
        expect(reserveResult.reserved).toBe(true);
        if (!reserveResult.reserved) continue;

        const releaseResult = await releaseCampaignHold(db, reserveResult.hold.id);
        expect(releaseResult.resolved).toBe(true);
      }

      const outstandingAfter = await sumOutstandingMinor(merchantId);
      expect(outstandingAfter).toBe(0);

      // Bit-for-bit identical to before the loop — no accumulation, no leak.
      expect(outstandingAfter).toBe(outstandingBefore);

      // And the full budget really is available again: one final reservation
      // for the entire amount succeeds.
      const finalOfferId = await insertSessionAndOffer({
        merchantId,
        index: ITERATIONS,
        shortfallMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      });
      const finalResult = await reserveCampaignBudget(db, {
        merchantId,
        offerId: finalOfferId,
        amountMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
        expiresAt: new Date(Date.now() + 600_000),
      });
      expect(finalResult.reserved).toBe(true);
    },
    60_000,
  );
});
