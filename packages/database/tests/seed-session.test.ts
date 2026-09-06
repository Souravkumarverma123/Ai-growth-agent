import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { computeCounterfactualContribution } from "@repo/policy";
import type { SkuPolicy } from "@repo/policy/contracts";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { merchantPoliciesTable, negotiationSessionsTable, skuPoliciesTable } from "../schema";
import { REFERENCE_CART, SEED_MERCHANT_ID, seedDatabase } from "../seed";
import { seedSession } from "../seed-session";

/**
 * The dev helper `db:seed-session` (`packages/database/seed-session.ts`) — the
 * one step nothing in the MVP does from a UI: put an `AT_RISK` negotiation
 * session in front of the `apps/web` console. Real Postgres, sibling test
 * database (CONTRACTS.md §8).
 */

describe("db:seed-session helper", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("inserts an AT_RISK session against the seeded merchant and §18.2 reference cart", async () => {
    const db = await getTestDb();
    await seedDatabase(db);

    const sessionId = await seedSession(db);

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, sessionId));

    expect(session).toBeDefined();
    expect(session!.state).toBe("AT_RISK");
    expect(session!.roundIndex).toBe(0);
    expect(session!.tier1Refused).toBe(false);
    expect(session!.merchantId).toBe(SEED_MERCHANT_ID);
    expect(session!.originalBasket).toEqual(REFERENCE_CART);

    const [policy] = await db
      .select()
      .from(merchantPoliciesTable)
      .where(eq(merchantPoliciesTable.merchantId, SEED_MERCHANT_ID));
    expect(session!.policyVersion).toBe(policy!.policyVersion);
  });

  it("records the counterfactual contribution the engine will judge every basket against", async () => {
    const db = await getTestDb();
    await seedDatabase(db);
    const sessionId = await seedSession(db);

    const skuRows = await db
      .select()
      .from(skuPoliciesTable)
      .where(eq(skuPoliciesTable.merchantId, SEED_MERCHANT_ID));
    const skuPolicies: SkuPolicy[] = skuRows.map((row) => ({
      skuId: row.id,
      merchantId: row.merchantId,
      sku: row.sku,
      name: row.name,
      listPriceMinor: row.listPriceMinor,
      floorPriceMinor: row.floorPriceMinor,
      negotiable: row.negotiable,
      slowMoving: row.slowMoving,
      affinityGroup: row.affinityGroup,
    }));
    const expected = computeCounterfactualContribution(REFERENCE_CART, skuPolicies);

    const [session] = await db
      .select()
      .from(negotiationSessionsTable)
      .where(eq(negotiationSessionsTable.id, sessionId));

    expect(session!.counterfactualContributionMinor).toBe(expected);
    expect(session!.counterfactualContributionMinor).toBeGreaterThan(0);
  });

  it("creates a fresh session every run — a used session cannot be reset (append-only ledger)", async () => {
    const db = await getTestDb();
    await seedDatabase(db);

    const first = await seedSession(db);
    const second = await seedSession(db);

    expect(first).not.toBe(second);
    const rows = await db
      .select()
      .from(negotiationSessionsTable)
      .orderBy(desc(negotiationSessionsTable.createdAt));
    expect(rows).toHaveLength(2);
  });

  it("fails with a pointer to db:seed when the merchant catalogue is absent", async () => {
    const db = await getTestDb();
    await expect(seedSession(db)).rejects.toThrow(/db:seed/);
  });
});
