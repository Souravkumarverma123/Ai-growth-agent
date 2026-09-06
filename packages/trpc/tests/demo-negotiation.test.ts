import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import { seedSession } from "@repo/database/seed-session";

import { serverRouter } from "../server";

/**
 * The `propose` path negotiates — it concedes toward the buyer and reaches a
 * campaign-funded Tier 2 rescue end to end.
 *
 * This closes ISSUE-012 sub-issue 12e: before TICKET-508's follow-up the
 * tRPC `DeterministicMerchantModel` always picked the highest-contribution
 * candidate (an upsell), so `propose` offered the same thing every round and
 * a Tier 2 offer was never minted through this surface. It now offers the
 * cheapest exposed candidate; on the demo scenario (`db:seed-session demo`,
 * ₹700 per-deal cap) that produces the PRD §18.2 arc.
 *
 * Real Postgres, sibling test database (CONTRACTS.md §8). `@repo/payments` is
 * NOT mocked — this test never reaches order creation (no accept).
 */

describe("propose — concession + Tier 2 rescue (demo scenario)", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("concedes on price across rounds and funds a Tier 2 rescue from the campaign budget", async () => {
    const db = await getTestDb();
    const sessionId = await seedSession(db, "demo");
    const caller = serverRouter.createCaller({ db });

    await caller.negotiation.openNegotiation({ sessionId, buyerAgentId: "demo-buyer" });

    // Round 1 — a Tier 1 offer (self-funding; no campaign spend).
    const r1 = await caller.negotiation.propose({ negotiationId: sessionId, message: "too expensive" });
    expect(r1.offer).not.toBeNull();
    expect(r1.reasonCode).toBe("TIER1_OFFERED");
    const round1Total = r1.offer!.totalMinor;

    // Refuse it — one refusal unlocks Tier 2 (RA-2).
    const d1 = await caller.negotiation.respondToOffer({
      negotiationId: sessionId,
      offerId: r1.offer!.offerId,
      response: "DECLINE_AND_CONTINUE",
    });
    expect(d1.terminal).toBe(false);
    expect(d1.reasonCode).toBe("TIER1_REFUSED_BY_BUYER");

    // Round 2 — a campaign-funded Tier 2 rescue: cheaper than round 1, and
    // the ledger records the spend.
    const r2 = await caller.negotiation.propose({ negotiationId: sessionId, message: "still too high" });
    expect(r2.offer).not.toBeNull();
    expect(r2.reasonCode).toBe("DILUTION_WITHIN_CAPS");
    expect(r2.offer!.totalMinor).toBeLessThan(round1Total);

    const ledger = await caller.audit.getSessionLedger({ sessionId });
    const reserved = ledger.events.find((e) => e.reasonCode === "HOLD_RESERVED");
    const minted = ledger.events.find((e) => e.reasonCode === "DILUTION_WITHIN_CAPS");
    expect(reserved?.campaignSpendMinor).toBeGreaterThan(0);
    expect(minted?.campaignSpendMinor).toBe(reserved?.campaignSpendMinor);

    // The buyer surface still never leaks a cap/floor/budget figure.
    expect(r2.offer).not.toHaveProperty("perDealCap");
    expect(r2.offer).not.toHaveProperty("floor");
  });
});
