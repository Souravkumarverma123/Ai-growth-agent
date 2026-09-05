import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { appendAuditEvent } from "@repo/database/repositories/audit-events";
import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import { merchantPoliciesTable, merchantsTable, negotiationSessionsTable } from "@repo/database/schema";
import type { Basket } from "@repo/policy/contracts";

import { auditRouter } from "../server/routes/audit/route";
import { tRPCContext } from "../server/trpc";
import type { Context } from "../server/context";

/**
 * TICKET-404 — ledger read API and chain verification endpoint.
 *
 * "A completed negotiation is fully reconstructable from this API alone" is
 * the acceptance criterion, so this test drives the exact worked-example
 * negotiation from PRD §18.2 (same sequence used by TICKET-401's
 * `packages/database/tests/audit-events.test.ts`) through the real append
 * function, then reconstructs it using ONLY `getSessionLedger` /
 * `verifyChain` — never reading `getAuditEventsForSession` results directly
 * to build the assertions, since the point is that the trpc read surface is
 * sufficient on its own.
 *
 * Real Postgres (CONTRACTS.md §8: do not mock the database), a sibling test
 * database — same harness `@repo/database/testing/db` exposes to its own
 * tests. The context is built by hand (`{ db: testDb }`) rather than via
 * `createContext`, because `createContext` points at the app's singleton
 * `DATABASE_URL`, not this sibling test database.
 */

const DUMMY_SKU_ID = randomUUID();

function fixtureBasket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: DUMMY_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

async function insertMerchantWithPolicy(): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-404 ledger route test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: 5_000_000,
    perDealCapMinor: 20_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

async function insertSession(merchantId: string): Promise<string> {
  const db = await getTestDb();
  const [session] = await db
    .insert(negotiationSessionsTable)
    .values({
      merchantId,
      buyerAgentId: "ticket-404-test-buyer",
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  return session!.id;
}

/**
 * The same worked-example negotiation as TICKET-401's test: flag at risk,
 * open, evaluate candidates, offer tier 1, buyer refuses, offer tier 2
 * within caps, reserve the hold, buyer accepts.
 */
async function appendFullNegotiation(sessionId: string) {
  const db = await getTestDb();

  await appendAuditEvent(db, {
    sessionId,
    eventType: "ELIGIBILITY_RULES_MATCH",
    fromState: "IDLE",
    toState: "AT_RISK",
    reasonCode: "SESSION_FLAGGED_AT_RISK",
    payload: { cartAgeSeconds: 900 },
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "NEGOTIATION_REQUESTED",
    fromState: "AT_RISK",
    toState: "OPEN",
    reasonCode: "NEGOTIATION_OPENED",
    payload: {},
    policyVersion: 1,
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "CANDIDATES_GENERATED",
    fromState: "OPEN",
    toState: "OPEN",
    reasonCode: "CANDIDATES_EVALUATED",
    payload: { evaluated: 12, feasible: 9, tier1: 4 },
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "TIER1_OFFERED",
    payload: { candidateId: "cand-bundle-1", totalMinor: 302_000 },
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "BUYER_DECLINES",
    fromState: "OFFER_PENDING",
    toState: "OPEN",
    reasonCode: "TIER1_REFUSED_BY_BUYER",
    payload: { candidateId: "cand-bundle-1" },
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "OFFER_MINTED",
    fromState: "OPEN",
    toState: "OFFER_PENDING",
    reasonCode: "DILUTION_WITHIN_CAPS",
    payload: { candidateId: "cand-original-cart", shortfallMinor: 20_000 },
    campaignSpendMinor: 20_000,
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "BUDGET_RESERVED",
    fromState: "OFFER_PENDING",
    toState: "OFFER_PENDING",
    reasonCode: "HOLD_RESERVED",
    payload: { amountMinor: 20_000 },
    campaignSpendMinor: 20_000,
  });
  await appendAuditEvent(db, {
    sessionId,
    eventType: "BUYER_ACCEPTS",
    fromState: "OFFER_PENDING",
    toState: "ACCEPTED",
    reasonCode: "OFFER_ACCEPTED",
    payload: { candidateId: "cand-original-cart" },
    modelExplanation: "Buyer accepted the original cart at the reduced price.",
  });
}

const createCaller = tRPCContext.createCallerFactory(auditRouter);

describe("TICKET-404 — ledger read API and chain verification endpoint", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("fully reconstructs a completed negotiation from getSessionLedger reads alone", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    await appendFullNegotiation(sessionId);

    const testDb = await getTestDb();
    const caller = createCaller({ db: testDb } satisfies Context);

    const { events } = await caller.getSessionLedger({ sessionId });

    expect(events).toHaveLength(8);

    // Sequence is contiguous from genesis and every timestamp round-trips
    // through the API as a string.
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const event of events) {
      expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
      expect(typeof event.eventId).toBe("string");
    }

    // Genesis has no predecessor; every later event chains to the one before it.
    expect(events[0]!.prevHash).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prevHash).toBe(events[i - 1]!.eventHash);
    }

    // The reason codes are the full worked-example story, in order — THE
    // JUSTIFICATION, reconstructable without touching any other table.
    expect(events.map((e) => e.reasonCode)).toEqual([
      "SESSION_FLAGGED_AT_RISK",
      "NEGOTIATION_OPENED",
      "CANDIDATES_EVALUATED",
      "TIER1_OFFERED",
      "TIER1_REFUSED_BY_BUYER",
      "DILUTION_WITHIN_CAPS",
      "HOLD_RESERVED",
      "OFFER_ACCEPTED",
    ]);
    expect(events.map((e) => e.fromState)).toEqual([
      "IDLE",
      "AT_RISK",
      "OPEN",
      "OPEN",
      "OFFER_PENDING",
      "OPEN",
      "OFFER_PENDING",
      "OFFER_PENDING",
    ]);
    expect(events.map((e) => e.toState)).toEqual([
      "AT_RISK",
      "OPEN",
      "OPEN",
      "OFFER_PENDING",
      "OPEN",
      "OFFER_PENDING",
      "OFFER_PENDING",
      "ACCEPTED",
    ]);

    // Payload survives the round trip verbatim — this is the evidence.
    expect(events[3]!.payload).toEqual({ candidateId: "cand-bundle-1", totalMinor: 302_000 });
    expect(events[5]!.payload).toEqual({ candidateId: "cand-original-cart", shortfallMinor: 20_000 });

    // Metadata columns reconstruct the money story: which offer, which
    // policy version, how much campaign spend this transition touched.
    expect(events[1]!.policyVersion).toBe(1);
    expect(events[5]!.campaignSpendMinor).toBe(20_000);
    expect(events[6]!.campaignSpendMinor).toBe(20_000);

    // THE EXPLANATION — present only where the app supplied one, and every
    // single event labels it non-authoritative in the response shape itself
    // (not just in a comment), so a consumer can never mistake it for the
    // reason the decision was made.
    for (const event of events) {
      expect(event.modelExplanationIsAuthoritative).toBe(false);
    }
    expect(events[7]!.modelExplanation).toBe("Buyer accepted the original cart at the reduced price.");
    for (let i = 0; i < 7; i++) {
      expect(events[i]!.modelExplanation).toBeNull();
    }
  });

  it("verifyChain reports the same negotiation as a valid, self-anchored chain", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    await appendFullNegotiation(sessionId);

    const testDb = await getTestDb();
    const caller = createCaller({ db: testDb } satisfies Context);

    const result = await caller.verifyChain({ sessionId });

    expect(result).toEqual({
      valid: true,
      eventCount: 8,
      brokenAtSequence: null,
      selfAnchored: true,
    });
  });

  it("getSessionLedger returns an empty ledger for a session with no events", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);

    const testDb = await getTestDb();
    const caller = createCaller({ db: testDb } satisfies Context);

    const { events } = await caller.getSessionLedger({ sessionId });
    expect(events).toEqual([]);

    const result = await caller.verifyChain({ sessionId });
    expect(result).toEqual({
      valid: true,
      eventCount: 0,
      brokenAtSequence: null,
      selfAnchored: true,
    });
  });
});
