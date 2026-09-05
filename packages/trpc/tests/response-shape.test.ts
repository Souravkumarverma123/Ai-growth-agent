import { describe, expect, it } from "vitest";

import type { Offer, SkuPolicy } from "@repo/policy/contracts";

import { toPublicBasketLines, toPublicOffer } from "../server/routes/negotiation/public-mappers";

/**
 * TICKET-204 — required test: "response-shape test asserting no forbidden
 * field is ever serialized, for a range of policy/offer fixtures"
 * (CONTRACTS.md §9): "Nothing on the buyer-facing surface may ever serialize
 * a floor price, an available campaign budget figure, a per-deal cap, or a
 * concession-curve value."
 *
 * Exercises the mapper functions directly — `toPublicOffer`/
 * `toPublicBasketLines`, `packages/trpc/server/routes/negotiation/
 * public-mappers.ts` — rather than only the wire-level zod output schema.
 * The zod `.output()` schema on every procedure in `route.ts` already
 * *strips* unknown keys before a response is ever serialized (zod's default
 * `z.object()` behaviour), which means a leak into the intermediate mapper
 * object could be silently invisible at the wire level while still being a
 * real bug in the code that computed it. Asserting directly on the mapper's
 * return value is the behavioural check that actually proves the forbidden
 * fields were never computed in the first place, not just that a later layer
 * happened to filter them out.
 */

const FORBIDDEN_SUBSTRINGS = [
  "floor",
  "Floor",
  "campaignSpend",
  "campaignBudget",
  "CampaignBudget",
  "perDealCap",
  "PerDealCap",
  "concessionCurve",
  "ConcessionCurve",
  "policyVersion",
  "PolicyVersion",
  "engineSignature",
  "reasonCode",
  "candidateId",
  "slowMoving",
  "SlowMoving",
  "negotiable",
  "affinityGroup",
];

function assertNoForbiddenField(value: unknown): void {
  const json = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(json ?? "", `serialized response must never contain "${forbidden}": ${json}`).not.toContain(
      forbidden,
    );
  }
}

const SKU_A: SkuPolicy = {
  skuId: "11111111-1111-1111-1111-111111111111",
  merchantId: "22222222-2222-2222-2222-222222222222",
  sku: "VITC-SERUM",
  name: "Vitamin C Serum",
  listPriceMinor: 180_000,
  floorPriceMinor: 120_000,
  negotiable: true,
  slowMoving: false,
  affinityGroup: "skincare",
};

const SKU_B: SkuPolicy = {
  skuId: "33333333-3333-3333-3333-333333333333",
  merchantId: "22222222-2222-2222-2222-222222222222",
  sku: "CLAY-MASK",
  name: "Clay Detox Mask",
  listPriceMinor: 90_000,
  floorPriceMinor: 40_000,
  negotiable: true,
  slowMoving: true,
  affinityGroup: null,
};

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: "44444444-4444-4444-4444-444444444444",
    sessionId: "55555555-5555-5555-5555-555555555555",
    candidateId: "C1",
    roundIndex: 1,
    basket: {
      lines: [{ skuId: SKU_A.skuId, quantity: 1, unitPriceMinor: 150_000 }],
      commitments: [],
      currency: "INR",
    },
    totalMinor: 150_000,
    currency: "INR",
    tier: 1,
    campaignSpendMinor: 0,
    policyVersion: 3,
    status: "PENDING",
    reasonCode: "TIER1_OFFERED",
    expiresAt: new Date("2026-01-01T00:10:00.000Z"),
    consumedAt: null,
    engineSignature: "deadbeef-signature-value",
    ...overrides,
  };
}

const MESSAGE_FRAMES = ["BUNDLE_VALUE", "SLOW_MOVING_CLEARANCE", "COMMITMENT_TRADE", "QUANTITY_VALUE", "FINAL_POSITION"] as const;

describe("TICKET-204 — response-shape: no forbidden field is ever serialized", () => {
  const fixtures: Array<{ label: string; offer: Offer; skuCatalogue: SkuPolicy[] }> = [
    {
      label: "Tier 1 offer, single line, no commitments",
      offer: makeOffer(),
      skuCatalogue: [SKU_A],
    },
    {
      label: "Tier 2 offer with nonzero campaignSpendMinor and a commitment",
      offer: makeOffer({
        tier: 2,
        campaignSpendMinor: 25_000,
        reasonCode: "DILUTION_WITHIN_CAPS",
        basket: {
          lines: [{ skuId: SKU_A.skuId, quantity: 1, unitPriceMinor: 130_000 }],
          commitments: ["PREPAID"],
          currency: "INR",
        },
      }),
      skuCatalogue: [SKU_A],
    },
    {
      label: "Offer over a slow-moving SKU, high policyVersion",
      offer: makeOffer({
        policyVersion: 42,
        basket: {
          lines: [{ skuId: SKU_B.skuId, quantity: 2, unitPriceMinor: 85_000 }],
          commitments: ["NON_RETURNABLE", "EXTENDED_DELIVERY_WINDOW"],
          currency: "INR",
        },
      }),
      skuCatalogue: [SKU_B],
    },
    {
      label: "Multi-line offer across two SKUs, one slow-moving one not",
      offer: makeOffer({
        basket: {
          lines: [
            { skuId: SKU_A.skuId, quantity: 1, unitPriceMinor: 160_000 },
            { skuId: SKU_B.skuId, quantity: 3, unitPriceMinor: 88_000 },
          ],
          commitments: [],
          currency: "INR",
        },
      }),
      skuCatalogue: [SKU_A, SKU_B],
    },
  ];

  for (const fixture of fixtures) {
    for (const messageFrame of MESSAGE_FRAMES) {
      it(`${fixture.label} — messageFrame ${messageFrame}`, () => {
        const publicOffer = toPublicOffer(fixture.offer, fixture.skuCatalogue, messageFrame);

        assertNoForbiddenField(publicOffer);
        expect(Object.keys(publicOffer).sort()).toEqual(
          ["offerId", "lines", "commitments", "totalMinor", "currency", "expiresAt", "message"].sort(),
        );

        for (const line of publicOffer.lines) {
          expect(Object.keys(line).sort()).toEqual(["sku", "name", "quantity", "unitPriceMinor"].sort());
        }
      });
    }
  }

  it("toPublicBasketLines never leaks floor price or negotiability across a range of catalogues", () => {
    for (const catalogue of [[SKU_A], [SKU_B], [SKU_A, SKU_B]]) {
      const lines = toPublicBasketLines(
        { lines: catalogue.map((sku) => ({ skuId: sku.skuId, quantity: 1, unitPriceMinor: sku.listPriceMinor })), commitments: [], currency: "INR" },
        catalogue,
      );
      assertNoForbiddenField(lines);
    }
  });

  it("the composed message text itself never contains a numeral (no smuggled amount)", () => {
    for (const messageFrame of MESSAGE_FRAMES) {
      const publicOffer = toPublicOffer(makeOffer(), [SKU_A], messageFrame);
      expect(publicOffer.message).not.toMatch(/[0-9]/);
    }
  });
});
