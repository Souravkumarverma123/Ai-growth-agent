import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyChain, type ChainEvent } from "@repo/policy";
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
  type CampaignHoldLedgerContext,
} from "../repositories/campaign-holds";
import { getAuditEventsForSession } from "../repositories/audit-events";
import type { SelectAuditEvent } from "../models/audit";

/**
 * TICKET-403 — campaign hold events in the ledger (PRD §6.5, §13.1; Settled by
 * Q13, Q22). Extends TICKET-107/108's hold functions (`reserveCampaignBudget`,
 * `releaseCampaignHold`, `commitCampaignHold`) so every hold transition also
 * appends exactly one ledger event, in the SAME transaction as the hold's own
 * state change (`../repositories/campaign-holds.ts`, `appendHoldLedgerEvent`).
 *
 * Acceptance criteria under test here:
 *   - every hold transition appears in the ledger with its amount
 *     (`campaignHoldId` + `campaignSpendMinor` on the appended event);
 *   - summing ledger hold events reproduces `available` (equivalently,
 *     reproduces `total - available` = outstanding, since `total` is fixed
 *     policy data untouched by any of this) after a full lifecycle.
 *
 * "Summing ledger hold events" means the NET effect of the three event types,
 * not a flat sum of every `campaignSpendMinor` seen: a `HOLD_RESERVED` event
 * adds its amount to outstanding budget, a `HOLD_RELEASED` event subtracts it
 * back out, and a `HOLD_COMMITTED` event changes nothing about the total
 * outstanding — the amount was already counted at reservation time and a
 * committed hold still counts against `available` exactly as a reserved one
 * does (`campaign-holds.ts`'s own module comment: "available = total -
 * reserved - committed"). Committing only moves which state variable
 * (RESERVED vs. COMMITTED) is responsible for continuing to count it. Naively
 * summing every event's amount regardless of type would double-count a
 * committed hold (once for HOLD_RESERVED, again for HOLD_COMMITTED) and is
 * deliberately not what `ledgerDerivedOutstandingMinor` below does.
 *
 * Same real-Postgres harness and fixture-construction pattern as
 * `campaign-hold-lifecycle.test.ts` / `campaign-budget-reservation.test.ts` /
 * `audit-events.test.ts` (CONTRACTS.md §8 — do not mock the database).
 * `truncateAllTables` between tests, not `withRollback`: this needs to read
 * back real committed rows across `appendAuditEvent`'s own internal
 * transaction, exactly like the sibling hold-lifecycle tests.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

function reserveLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
  };
}

function declineReleaseLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "HOLD_RELEASED",
  };
}

function commitLedgerFor(sessionId: string): CampaignHoldLedgerContext {
  return {
    sessionId,
    eventType: "HOLD_COMMITTED",
    fromState: "SETTLED",
    toState: "SETTLED",
    reasonCode: "HOLD_COMMITTED",
  };
}

async function insertMerchantWithPolicy(params: {
  campaignBudgetTotalMinor: number;
  perDealCapMinor: number;
}): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-403 hold-ledger test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: params.campaignBudgetTotalMinor,
    perDealCapMinor: params.perDealCapMinor,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

/** One negotiation session + one tier-2 offer, modeling one hold's lifecycle. */
async function insertSessionAndOffer(params: {
  merchantId: string;
  index: number;
  shortfallMinor: number;
}): Promise<{ offerId: string; sessionId: string }> {
  const db = await getTestDb();
  const { merchantId, index, shortfallMinor } = params;

  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: `hold-ledger-test-buyer-${index}`,
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
      engineSignature: "ticket-403-test-fixture-signature",
    })
    .returning({ id: offersTable.id });

  return { offerId: offer!.id, sessionId: session!.id };
}

/** The same "available" arithmetic `reserveCampaignBudget` itself uses, read directly off `campaign_holds`. */
async function outstandingMinorFromHoldsTable(merchantId: string): Promise<number> {
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

/**
 * Reconstructs outstanding campaign budget purely from the ledger: a
 * HOLD_RESERVED event adds its amount, a HOLD_RELEASED event subtracts it,
 * and a HOLD_COMMITTED event is a no-op on the net total (see module comment
 * above for why). This is "summing ledger hold events" as the acceptance
 * criteria mean it — not a flat sum of every event's amount.
 */
function ledgerDerivedOutstandingMinor(events: SelectAuditEvent[]): number {
  return events.reduce((total, event) => {
    if (event.campaignHoldId == null || event.campaignSpendMinor == null) return total;
    switch (event.reasonCode) {
      case "HOLD_RESERVED":
        return total + event.campaignSpendMinor;
      case "HOLD_RELEASED":
        return total - event.campaignSpendMinor;
      case "HOLD_COMMITTED":
        return total;
      default:
        return total;
    }
  }, 0);
}

describe("TICKET-403 — campaign hold events in the ledger", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("reserve then commit: every transition lands in the ledger with its amount, and ledger-derived outstanding equals campaign_holds-derived outstanding at each step", async () => {
    const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000; // ₹1,000
    const PER_DEAL_CAP_MINOR = 50_000;
    const AMOUNT_MINOR = 40_000; // ₹400

    const merchantId = await insertMerchantWithPolicy({
      campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
    });
    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: AMOUNT_MINOR,
    });

    const db = await getTestDb();

    // --- Step 1: reserve --------------------------------------------------
    const reserveResult = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: AMOUNT_MINOR,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    expect(reserveResult.reserved).toBe(true);
    if (!reserveResult.reserved) throw new Error("unreachable");
    const holdId = reserveResult.hold.id;

    const eventsAfterReserve = await getAuditEventsForSession(db, sessionId);
    expect(eventsAfterReserve).toHaveLength(1);
    const reservedEvent = eventsAfterReserve[0]!;
    expect(reservedEvent.eventType).toBe("BUDGET_RESERVED");
    expect(reservedEvent.reasonCode).toBe("HOLD_RESERVED");
    expect(reservedEvent.fromState).toBe("OFFER_PENDING");
    expect(reservedEvent.toState).toBe("OFFER_PENDING");
    expect(reservedEvent.campaignHoldId).toBe(holdId);
    expect(reservedEvent.campaignSpendMinor).toBe(AMOUNT_MINOR);
    expect(reservedEvent.offerId).toBe(offerId);
    expect(reservedEvent.sequence).toBe(0);
    expect(reservedEvent.prevHash).toBeNull();

    expect(ledgerDerivedOutstandingMinor(eventsAfterReserve)).toBe(
      await outstandingMinorFromHoldsTable(merchantId),
    );
    expect(await outstandingMinorFromHoldsTable(merchantId)).toBe(AMOUNT_MINOR);

    // --- Step 2: commit -----------------------------------------------------
    const commitResult = await commitCampaignHold(db, holdId, commitLedgerFor(sessionId));
    expect(commitResult.resolved).toBe(true);

    const eventsAfterCommit = await getAuditEventsForSession(db, sessionId);
    expect(eventsAfterCommit).toHaveLength(2);
    const committedEvent = eventsAfterCommit[1]!;
    expect(committedEvent.eventType).toBe("HOLD_COMMITTED");
    expect(committedEvent.reasonCode).toBe("HOLD_COMMITTED");
    expect(committedEvent.fromState).toBe("SETTLED");
    expect(committedEvent.toState).toBe("SETTLED");
    expect(committedEvent.campaignHoldId).toBe(holdId);
    expect(committedEvent.campaignSpendMinor).toBe(AMOUNT_MINOR);
    expect(committedEvent.sequence).toBe(1);
    expect(committedEvent.prevHash).toBe(reservedEvent.eventHash);

    // Committing does not free budget — a committed hold still counts
    // against `available` exactly as a reserved one did.
    const outstandingAfterCommit = await outstandingMinorFromHoldsTable(merchantId);
    expect(outstandingAfterCommit).toBe(AMOUNT_MINOR);

    // The core acceptance criterion: ledger-derived outstanding still equals
    // the stored (campaign_holds-derived) outstanding after the full
    // lifecycle, not just after the first step.
    expect(ledgerDerivedOutstandingMinor(eventsAfterCommit)).toBe(outstandingAfterCommit);

    // The hash chain over this session's hold events verifies clean.
    const chainResult = verifyChain(eventsAfterCommit as unknown as ChainEvent[]);
    expect(chainResult).toEqual({ valid: true, eventCount: 2 });
  });

  it("reserve then release: ledger-derived outstanding returns to zero, matching campaign_holds-derived outstanding", async () => {
    const CAMPAIGN_BUDGET_TOTAL_MINOR = 100_000;
    const PER_DEAL_CAP_MINOR = 50_000;
    const AMOUNT_MINOR = 25_000;

    const merchantId = await insertMerchantWithPolicy({
      campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
    });
    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: AMOUNT_MINOR,
    });

    const db = await getTestDb();

    const reserveResult = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: AMOUNT_MINOR,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    expect(reserveResult.reserved).toBe(true);
    if (!reserveResult.reserved) throw new Error("unreachable");
    const holdId = reserveResult.hold.id;

    const releaseResult = await releaseCampaignHold(db, holdId, declineReleaseLedgerFor(sessionId));
    expect(releaseResult.resolved).toBe(true);

    const events = await getAuditEventsForSession(db, sessionId);
    expect(events).toHaveLength(2);

    const releasedEvent = events[1]!;
    expect(releasedEvent.eventType).toBe("BUYER_DECLINES");
    expect(releasedEvent.reasonCode).toBe("HOLD_RELEASED");
    expect(releasedEvent.fromState).toBe("OFFER_PENDING");
    expect(releasedEvent.toState).toBe("OPEN");
    expect(releasedEvent.campaignHoldId).toBe(holdId);
    expect(releasedEvent.campaignSpendMinor).toBe(AMOUNT_MINOR);

    const outstandingAfterRelease = await outstandingMinorFromHoldsTable(merchantId);
    expect(outstandingAfterRelease).toBe(0);

    // The released hold's amount is fully unwound: reserve (+X) then
    // release (-X) nets to zero, matching the real, committed campaign_holds
    // state (the row is RELEASED, no longer outstanding).
    expect(ledgerDerivedOutstandingMinor(events)).toBe(0);
    expect(ledgerDerivedOutstandingMinor(events)).toBe(outstandingAfterRelease);

    const chainResult = verifyChain(events as unknown as ChainEvent[]);
    expect(chainResult).toEqual({ valid: true, eventCount: 2 });
  });

  it("a failed reservation (budget exhausted) appends no ledger event — there is no hold transition to record", async () => {
    const CAMPAIGN_BUDGET_TOTAL_MINOR = 10_000; // ₹100 — too small for the attempt below
    const PER_DEAL_CAP_MINOR = 50_000;
    const AMOUNT_MINOR = 40_000; // ₹400 — exceeds the tiny budget

    const merchantId = await insertMerchantWithPolicy({
      campaignBudgetTotalMinor: CAMPAIGN_BUDGET_TOTAL_MINOR,
      perDealCapMinor: PER_DEAL_CAP_MINOR,
    });
    const { offerId, sessionId } = await insertSessionAndOffer({
      merchantId,
      index: 0,
      shortfallMinor: AMOUNT_MINOR,
    });

    const db = await getTestDb();
    const reserveResult = await reserveCampaignBudget(db, {
      merchantId,
      offerId,
      amountMinor: AMOUNT_MINOR,
      expiresAt: new Date(Date.now() + 600_000),
      ledger: reserveLedgerFor(sessionId),
    });
    expect(reserveResult.reserved).toBe(false);

    const events = await getAuditEventsForSession(db, sessionId);
    expect(events).toHaveLength(0);
  });
});
