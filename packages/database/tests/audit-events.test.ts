import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyChain, type ChainEvent } from "@repo/policy";
import type { Basket } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { merchantPoliciesTable, merchantsTable, negotiationSessionsTable } from "../schema";
import * as auditEventsRepository from "../repositories/audit-events";
import { appendAuditEvent, getAuditEventsForSession } from "../repositories/audit-events";

/**
 * TICKET-401 — append-only ledger writer with hash chaining (PRD §13,
 * CONTRACTS.md §7).
 *
 * Real-Postgres half of this ticket (CONTRACTS.md §8: "do not mock the
 * database; use the real one"). Same harness and fixture-construction
 * pattern as TICKET-107/108 (`campaign-budget-reservation.test.ts`,
 * `campaign-hold-lifecycle.test.ts`): a merchant + policy row, then a
 * negotiation_sessions row to attach audit events to. The pure hash-chain
 * unit tests (determinism, hand-constructed valid/broken chains) live in
 * `packages/policy/tests/hash-chain.test.ts` and need no database at all.
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
    .values({ name: "TICKET-401 ledger test merchant" })
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
      buyerAgentId: "ticket-401-test-buyer",
      policyVersion: 1,
      originalBasket: fixtureBasket(250_000),
      counterfactualContributionMinor: 95_000,
    })
    .returning({ id: negotiationSessionsTable.id });

  return session!.id;
}

/**
 * Appends a plausible multi-round negotiation for one session — the exact
 * codes from PRD §18.2's worked example (flag at risk, open, evaluate
 * candidates, offer tier 1, buyer refuses it, offer tier 2 within caps,
 * reserve the hold, buyer accepts). Round-trips through the real append
 * function every step, exactly as production code would call it one
 * transition at a time.
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

describe("TICKET-401 — append-only ledger writer with hash chaining", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("exports no update or delete function from the ledger module", () => {
    const exportedNames = Object.keys(auditEventsRepository);
    expect(exportedNames).toContain("appendAuditEvent");
    expect(exportedNames).toContain("getAuditEventsForSession");
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(/update|delete|remove|mutate|patch/);
    }
  });

  it("chain verifies over a full negotiation: genesis through acceptance", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);

    await appendFullNegotiation(sessionId);

    const db = await getTestDb();
    const events = await getAuditEventsForSession(db, sessionId);

    expect(events).toHaveLength(8);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(events[0]!.prevHash).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prevHash).toBe(events[i - 1]!.eventHash);
    }

    const result = verifyChain(events as unknown as ChainEvent[]);
    expect(result).toEqual({ valid: true, eventCount: 8 });
  });

  it("sequence and prevHash chain correctly across two independent sessions (no cross-session leakage)", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionA = await insertSession(merchantId);
    const sessionB = await insertSession(merchantId);

    await appendFullNegotiation(sessionA);

    const db = await getTestDb();
    // A fresh session's genesis event must not chain to another session's
    // events — sequence restarts at 0 and prevHash is null, independently.
    await appendAuditEvent(db, {
      sessionId: sessionB,
      eventType: "ELIGIBILITY_RULES_MATCH",
      fromState: "IDLE",
      toState: "AT_RISK",
      reasonCode: "SESSION_FLAGGED_AT_RISK",
      payload: {},
    });

    const eventsB = await getAuditEventsForSession(db, sessionB);
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]!.sequence).toBe(0);
    expect(eventsB[0]!.prevHash).toBeNull();

    const resultB = verifyChain(eventsB as unknown as ChainEvent[]);
    expect(resultB).toEqual({ valid: true, eventCount: 1 });

    // Session A's own chain is unaffected by session B's append.
    const eventsA = await getAuditEventsForSession(db, sessionA);
    expect(eventsA).toHaveLength(8);
    expect(verifyChain(eventsA as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: 8 });
  });

  it(
    "tampering with a stored event breaks verification: an in-memory mutated copy fails while the real, " +
      "unmutated fetch still verifies clean",
    async () => {
      const merchantId = await insertMerchantWithPolicy();
      const sessionId = await insertSession(merchantId);
      await appendFullNegotiation(sessionId);

      const db = await getTestDb();
      const events = await getAuditEventsForSession(db, sessionId);

      // The real, unmutated fetch verifies clean.
      expect(verifyChain(events as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: 8 });

      // Simulate a corrupted read / out-of-band data change: mutate one
      // event's reasonCode in an in-memory copy, without recomputing its
      // hash. Real UPDATEs against this table are already rejected outright
      // by the DB-level append-only triggers (TICKET-005,
      // 0002_audit_events_append_only.sql) — that is a different, already-
      // covered guarantee. This test is about the OTHER half: if stored data
      // is ever altered by any means (a bug, a restore from a stale backup,
      // direct superuser tampering bypassing the triggers), the hash chain
      // must catch it on read.
      const tamperedIndex = 5; // the DILUTION_WITHIN_CAPS event
      const tampered = events.map((event, index) =>
        index === tamperedIndex ? { ...event, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" as const } : event,
      );

      const tamperedResult = verifyChain(tampered as unknown as ChainEvent[]);
      expect(tamperedResult.valid).toBe(false);
      if (!tamperedResult.valid) {
        expect(tamperedResult.reason).toBe("HASH_MISMATCH");
        expect(tamperedResult.brokenAtIndex).toBe(tamperedIndex);
      }

      // The original, unmutated array is untouched by building the tampered
      // copy and still verifies clean.
      expect(verifyChain(events as unknown as ChainEvent[])).toEqual({ valid: true, eventCount: 8 });
    },
  );

  it("tampering with a stored event's payload also breaks verification", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);
    await appendFullNegotiation(sessionId);

    const db = await getTestDb();
    const events = await getAuditEventsForSession(db, sessionId);

    const tamperedIndex = 3; // the TIER1_OFFERED event
    const tampered = events.map((event, index) =>
      index === tamperedIndex ? { ...event, payload: { candidateId: "cand-bundle-1", totalMinor: 1 } } : event,
    );

    const tamperedResult = verifyChain(tampered as unknown as ChainEvent[]);
    expect(tamperedResult.valid).toBe(false);
    if (!tamperedResult.valid) {
      expect(tamperedResult.reason).toBe("HASH_MISMATCH");
      expect(tamperedResult.brokenAtIndex).toBe(tamperedIndex);
    }
  });

  it("genesis has no predecessor: the first event for a session always has a null prevHash", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const sessionId = await insertSession(merchantId);

    const db = await getTestDb();
    const genesis = await appendAuditEvent(db, {
      sessionId,
      eventType: "ELIGIBILITY_RULES_MATCH",
      fromState: "IDLE",
      toState: "AT_RISK",
      reasonCode: "SESSION_FLAGGED_AT_RISK",
      payload: {},
    });

    expect(genesis.sequence).toBe(0);
    expect(genesis.prevHash).toBeNull();
    expect(genesis.eventHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
