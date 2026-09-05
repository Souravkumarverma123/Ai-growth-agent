import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAllTables } from "../testing/db";
import { merchantPoliciesTable, merchantsTable } from "../schema";
import {
  approveMerchantPolicy,
  getMerchantPolicy,
  setNegotiationEnabled,
} from "../repositories/merchant-policies";

/**
 * TICKET-501 — merchant policy configuration and approval (PRD §5, §6.6,
 * §19). Required test per the ticket: "Approval writes a new policy
 * version." CONTRACTS.md §8 — do not mock the database; use the real one.
 */

async function insertMerchantWithPolicy(): Promise<string> {
  const db = await getTestDb();

  const [merchant] = await db
    .insert(merchantsTable)
    .values({ name: "TICKET-501 policy-approval test merchant" })
    .returning({ id: merchantsTable.id });

  await db.insert(merchantPoliciesTable).values({
    merchantId: merchant!.id,
    campaignBudgetTotalMinor: 500_000,
    perDealCapMinor: 20_000,
    concessionCurve: [0.4, 0.7, 1.0],
  });

  return merchant!.id;
}

describe("TICKET-501 — merchant policy approval", () => {
  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("a fresh policy row starts at policyVersion 1", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();

    const policy = await getMerchantPolicy(db, merchantId);
    expect(policy?.policyVersion).toBe(1);
  });

  it("approving edited fields increments policyVersion and persists the edits, including the three commitment values", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();

    const result = await approveMerchantPolicy(db, {
      merchantId,
      campaignBudgetTotalMinor: 750_000,
      perDealCapMinor: 25_000,
      maxRounds: 4,
      offerTtlSeconds: 900,
      allowedCommitments: [
        { commitmentType: "PREPAID", valueMinor: 15_000 },
        { commitmentType: "NON_RETURNABLE", valueMinor: 10_000 },
        { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 7_000 },
      ],
    });

    // The behavioural acceptance criterion: approval increments policyVersion.
    expect(result.policyVersion).toBe(2);

    const after = await getMerchantPolicy(db, merchantId);
    expect(after?.policyVersion).toBe(2);
    expect(after?.campaignBudgetTotalMinor).toBe(750_000);
    expect(after?.perDealCapMinor).toBe(25_000);
    expect(after?.maxRounds).toBe(4);
    expect(after?.offerTtlSeconds).toBe(900);
    expect(after?.allowedCommitments).toEqual(
      expect.arrayContaining([
        { commitmentType: "PREPAID", valueMinor: 15_000 },
        { commitmentType: "NON_RETURNABLE", valueMinor: 10_000 },
        { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 7_000 },
      ]),
    );
  });

  it("each successive approval increments policyVersion by exactly one", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();

    const params = {
      merchantId,
      campaignBudgetTotalMinor: 500_000,
      perDealCapMinor: 20_000,
      maxRounds: 3,
      offerTtlSeconds: 600,
      allowedCommitments: [],
    };

    const first = await approveMerchantPolicy(db, params);
    const second = await approveMerchantPolicy(db, params);
    const third = await approveMerchantPolicy(db, params);

    expect(first.policyVersion).toBe(2);
    expect(second.policyVersion).toBe(3);
    expect(third.policyVersion).toBe(4);
  });

  it("the kill switch (setNegotiationEnabled) flips negotiationEnabled WITHOUT changing policyVersion — it is exempt from the policy freeze (RA-1)", async () => {
    const merchantId = await insertMerchantWithPolicy();
    const db = await getTestDb();

    const before = await getMerchantPolicy(db, merchantId);
    expect(before?.negotiationEnabled).toBe(true);
    expect(before?.policyVersion).toBe(1);

    const result = await setNegotiationEnabled(db, merchantId, false);
    expect(result?.negotiationEnabled).toBe(false);

    const after = await getMerchantPolicy(db, merchantId);
    expect(after?.negotiationEnabled).toBe(false);
    expect(after?.policyVersion).toBe(1);
  });

  it("getMerchantPolicy returns undefined for a merchant with no policy row", async () => {
    const db = await getTestDb();
    const result = await getMerchantPolicy(db, randomUUID());
    expect(result).toBeUndefined();
  });

  it("setNegotiationEnabled on a merchant with no policy row is a safe no-op, returning undefined", async () => {
    const db = await getTestDb();
    const result = await setNegotiationEnabled(db, randomUUID(), false);
    expect(result).toBeUndefined();
  });
});
