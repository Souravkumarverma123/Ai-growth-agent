import { closeTestDb, getTestDb, truncateAllTables } from "@repo/database/testing/db";
import { merchantPoliciesTable, merchantsTable } from "@repo/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { serverRouter } from "../server";

/**
 * TICKET-501 — merchant policy configuration and approval (PRD §5, §6.6,
 * §19). Exercises the actual tRPC procedure bodies (not just the repository
 * layer covered in `packages/database`'s own test), against the real
 * Postgres test database — the primary seam per CONTRACTS.md §8.
 */

async function insertMerchantWithPolicy(): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-501 tRPC test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: 500_000,
    perDealCapMinor: 20_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

describe("TICKET-501 — merchant router procedures", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("getPolicy returns the seeded policy at policyVersion 1", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const policy = await caller.merchant.getPolicy({ merchantId });

    expect(policy.merchantId).toBe(merchantId);
    expect(policy.policyVersion).toBe(1);
    expect(policy.negotiationEnabled).toBe(true);
    // The 3% rule: fixed, not merchant-editable, still present in the view.
    expect(policy.slowMovingTolerance).toBeCloseTo(0.03);
  });

  it("approvePolicy increments policyVersion and getPolicy reflects it afterward", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const approveResult = await caller.merchant.approvePolicy({
      merchantId,
      campaignBudgetTotalMinor: 800_000,
      perDealCapMinor: 30_000,
      maxRounds: 5,
      offerTtlSeconds: 1_200,
      allowedCommitments: [
        { commitmentType: "PREPAID", valueMinor: 20_000 },
        { commitmentType: "NON_RETURNABLE", valueMinor: 12_000 },
        { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 8_000 },
      ],
    });

    expect(approveResult.policyVersion).toBe(2);

    const after = await caller.merchant.getPolicy({ merchantId });
    expect(after.policyVersion).toBe(2);
    expect(after.campaignBudgetTotalMinor).toBe(800_000);
    expect(after.perDealCapMinor).toBe(30_000);
    expect(after.maxRounds).toBe(5);
    expect(after.offerTtlSeconds).toBe(1_200);
    expect(after.allowedCommitments).toEqual(
      expect.arrayContaining([
        { commitmentType: "PREPAID", valueMinor: 20_000 },
        { commitmentType: "NON_RETURNABLE", valueMinor: 12_000 },
        { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 8_000 },
      ]),
    );
  });

  it("setNegotiationEnabled (the kill switch) flips negotiationEnabled independently of policyVersion", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    const killSwitchResult = await caller.merchant.setNegotiationEnabled({
      merchantId,
      enabled: false,
    });
    expect(killSwitchResult.negotiationEnabled).toBe(false);

    const after = await caller.merchant.getPolicy({ merchantId });
    expect(after.negotiationEnabled).toBe(false);
    // The freeze applies to every other field, never to the kill switch itself.
    expect(after.policyVersion).toBe(1);
  });

  it("getPolicy for an unknown merchant fails with NOT_FOUND", async () => {
    const db = await getTestDb();
    const caller = serverRouter.createCaller({ db });

    await expect(caller.merchant.getPolicy({ merchantId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow();
  });
});
