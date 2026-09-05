import { describe, expect, it } from "vitest";

import type { Basket, Candidate, MerchantPolicy, SkuPolicy } from "../contracts";
import { computeCounterfactualContribution } from "../economics";
import {
  FloorBreachError,
  assertGeneratedCandidateRespectsFloors,
  assertNoFloorBreach,
  assertOriginalBasketRespectsFloors,
  assertSkuCatalogueIsSane,
  findFloorBreaches,
  generateCandidates,
} from "../generation";
import { createSeededRandom, randomChoice, randomInt, randomUuid, shuffle } from "./support/seeded-random";

/**
 * TICKET-106 — floor enforcement and the defensive mint-time assertion (PRD
 * §8, §14, §17 row 9; state-machine.ts's SUB_FLOOR_CANDIDATE_DETECTED row).
 *
 * The generation-time guarantee ("the generator cannot construct a sub-floor
 * candidate") was already established by TICKET-103's own test suite
 * (`candidate-generation.test.ts`'s randomized property test) and is not
 * re-derived here from scratch — this file's property test exercises the
 * SAME invariant through the extracted `findFloorBreaches` primitive
 * directly, so the extraction itself (not just the original inline code) is
 * under test. The genuinely new piece is `assertNoFloorBreach`: the
 * defensive assertion this ticket adds at mint time.
 */

const MERCHANT_ID = "99999999-9999-4999-8999-999999999999";
const SKU_ID = "11111111-1111-4111-8111-111111111111";

const skuCatalogue: SkuPolicy[] = [
  {
    skuId: SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "VIT-C-SERUM",
    name: "Vitamin C Serum",
    listPriceMinor: 180000,
    floorPriceMinor: 110000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: null,
  },
];

function basket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: "candidate-1",
    sessionId: "22222222-2222-4222-8222-222222222222",
    roundIndex: 1,
    moveType: "PRICE_CONCESSION",
    basket: basket(150000),
    totalMinor: 150000,
    contributionMinor: 40000,
    contributionDeltaMinor: -10000,
    tier: 2,
    requiredCampaignSpendMinor: 10000,
    clearsSlowMoving: false,
    feasible: true,
    infeasibleReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findFloorBreaches — the shared primitive
// ---------------------------------------------------------------------------

describe("findFloorBreaches", () => {
  it("returns no breaches for a basket priced at or above every line's floor", () => {
    expect(findFloorBreaches(basket(110000), skuCatalogue)).toEqual([]);
    expect(findFloorBreaches(basket(180000), skuCatalogue)).toEqual([]);
  });

  it("reports a line priced even one minor unit below its floor", () => {
    expect(findFloorBreaches(basket(109999), skuCatalogue)).toEqual([
      { skuId: SKU_ID, unitPriceMinor: 109999, floorPriceMinor: 110000 },
    ]);
  });

  it("throws if a basket line references a SKU absent from the catalogue", () => {
    const unknownSkuBasket = basket(150000);
    expect(() => findFloorBreaches(unknownSkuBasket, [])).toThrow(/no sku policy supplied/i);
  });
});

// ---------------------------------------------------------------------------
// The defensive mint-time assertion — required test: a deliberately
// corrupted candidate triggers the halt
// ---------------------------------------------------------------------------

describe("assertNoFloorBreach — the defensive mint-time assertion (PRD §14 FLOOR_BREACH, §17 row 9)", () => {
  it("does not throw for a candidate whose every line is at or above its floor", () => {
    const clean = buildCandidate({ basket: basket(110000) });
    expect(() => assertNoFloorBreach(clean, skuCatalogue, MERCHANT_ID)).not.toThrow();
  });

  it("halts on a deliberately corrupted candidate priced below floor, throwing a distinctive FloorBreachError tagged FLOOR_BREACH", () => {
    const corrupted = buildCandidate({ basket: basket(1) }); // ₹0.01, deep below the ₹1,100 floor

    let thrown: unknown;
    try {
      assertNoFloorBreach(corrupted, skuCatalogue, MERCHANT_ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FloorBreachError);
    const floorBreachError = thrown as FloorBreachError;
    expect(floorBreachError.reasonCode).toBe("FLOOR_BREACH");
    expect(floorBreachError.candidateId).toBe(corrupted.candidateId);
    expect(floorBreachError.breaches).toEqual([
      { skuId: SKU_ID, unitPriceMinor: 1, floorPriceMinor: 110000 },
    ]);
  });

  it("halts rather than continues — the assertion throws, it never returns a silently-ignorable value", () => {
    const corrupted = buildCandidate({ basket: basket(1) });
    expect(() => assertNoFloorBreach(corrupted, skuCatalogue, MERCHANT_ID)).toThrow(FloorBreachError);
  });

  it("does not trust the catalogue: halts on a duplicate skuId even when the winning last-write entry alone would look clean", () => {
    const clean = buildCandidate({ basket: basket(150000) }); // above floor per the legitimate entry
    const lowerFloorDuplicate: SkuPolicy = { ...skuCatalogue[0]!, floorPriceMinor: 200000 };
    const catalogueWithDuplicate = [skuCatalogue[0]!, lowerFloorDuplicate];

    expect(() => assertNoFloorBreach(clean, catalogueWithDuplicate, MERCHANT_ID)).toThrow(/duplicate/i);
  });

  it("does not trust the catalogue: halts when a supplied SKU belongs to a different merchant", () => {
    const clean = buildCandidate({ basket: basket(150000) });
    expect(() => assertNoFloorBreach(clean, skuCatalogue, "not-this-merchant")).toThrow(/merchantId/i);
  });

  it("reports every sub-floor line, not just the first, when a multi-line candidate is corrupted on more than one line", () => {
    const otherSkuId = "33333333-3333-4333-8333-333333333333";
    const twoSkuCatalogue: SkuPolicy[] = [
      ...skuCatalogue,
      {
        skuId: otherSkuId,
        merchantId: MERCHANT_ID,
        sku: "GENTLE-CLEANSER",
        name: "Gentle Cleanser",
        listPriceMinor: 70000,
        floorPriceMinor: 45000,
        negotiable: true,
        slowMoving: false,
        affinityGroup: null,
      },
    ];
    const corrupted = buildCandidate({
      basket: {
        currency: "INR",
        commitments: [],
        lines: [
          { skuId: SKU_ID, quantity: 1, unitPriceMinor: 1 },
          { skuId: otherSkuId, quantity: 1, unitPriceMinor: 1 },
        ],
      },
    });

    expect(() => assertNoFloorBreach(corrupted, twoSkuCatalogue, MERCHANT_ID)).toThrow(FloorBreachError);
    try {
      assertNoFloorBreach(corrupted, twoSkuCatalogue, MERCHANT_ID);
      throw new Error("expected assertNoFloorBreach to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FloorBreachError);
      expect((error as FloorBreachError).breaches).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Generation-time extraction — assertOriginalBasketRespectsFloors,
// assertGeneratedCandidateRespectsFloors, assertSkuCatalogueIsSane
// ---------------------------------------------------------------------------

describe("assertOriginalBasketRespectsFloors (extracted from candidates.ts)", () => {
  it("does not throw for a basket that respects every floor", () => {
    expect(() => assertOriginalBasketRespectsFloors(basket(110000), skuCatalogue)).not.toThrow();
  });

  it("throws for a basket already carrying a sub-floor line", () => {
    expect(() => assertOriginalBasketRespectsFloors(basket(1), skuCatalogue)).toThrow(/already below floor/i);
  });
});

describe("assertGeneratedCandidateRespectsFloors (extracted from candidates.ts's pushCandidate)", () => {
  it("does not throw for a candidate basket that respects every floor", () => {
    expect(() =>
      assertGeneratedCandidateRespectsFloors("PRICE_CONCESSION", basket(110000), skuCatalogue),
    ).not.toThrow();
  });

  it("throws, naming the offending move type, for a sub-floor candidate basket", () => {
    expect(() => assertGeneratedCandidateRespectsFloors("PRICE_CONCESSION", basket(1), skuCatalogue)).toThrow(
      /PRICE_CONCESSION.*below its floor/i,
    );
  });
});

describe("assertSkuCatalogueIsSane (extracted from candidates.ts)", () => {
  it("does not throw for a sane catalogue", () => {
    expect(() => assertSkuCatalogueIsSane(skuCatalogue, MERCHANT_ID)).not.toThrow();
  });

  it("throws if a floor exceeds list price", () => {
    const broken = [{ ...skuCatalogue[0]!, floorPriceMinor: skuCatalogue[0]!.listPriceMinor + 1 }];
    expect(() => assertSkuCatalogueIsSane(broken, MERCHANT_ID)).toThrow(/above/i);
  });

  it("throws on a duplicate skuId", () => {
    const broken = [skuCatalogue[0]!, skuCatalogue[0]!];
    expect(() => assertSkuCatalogueIsSane(broken, MERCHANT_ID)).toThrow(/duplicate/i);
  });

  it("throws if a SKU belongs to a different merchant", () => {
    expect(() => assertSkuCatalogueIsSane(skuCatalogue, "not-this-merchant")).toThrow(/merchantId/i);
  });
});

// ---------------------------------------------------------------------------
// Property test over randomized catalogues — required test
// ---------------------------------------------------------------------------

function randomSkuPolicy(
  rng: ReturnType<typeof createSeededRandom>,
  merchantId: string,
  index: number,
): SkuPolicy {
  const floorPriceMinor = randomInt(rng, 1_000, 100_000);
  const headroom = randomInt(rng, 0, 100_000);
  const affinityGroupOptions = ["serums", "cleansers", "moisturizers", "toners", null, null] as const;
  return {
    skuId: randomUuid(rng),
    merchantId,
    sku: `RAND-SKU-${index}`,
    name: `Random SKU ${index}`,
    listPriceMinor: floorPriceMinor + headroom,
    floorPriceMinor,
    negotiable: rng() > 0.15,
    slowMoving: rng() > 0.6,
    affinityGroup: randomChoice(rng, affinityGroupOptions),
  };
}

function randomCatalogue(
  rng: ReturnType<typeof createSeededRandom>,
  merchantId: string,
  size: number,
): SkuPolicy[] {
  return Array.from({ length: size }, (_, index) => randomSkuPolicy(rng, merchantId, index));
}

function randomOriginalBasket(
  rng: ReturnType<typeof createSeededRandom>,
  catalogue: readonly SkuPolicy[],
  lineCount: number,
): Basket {
  const chosen = shuffle(rng, catalogue).slice(0, lineCount);
  return {
    currency: "INR",
    commitments: [],
    lines: chosen.map((sku) => ({
      skuId: sku.skuId,
      quantity: randomInt(rng, 1, 3),
      unitPriceMinor: sku.listPriceMinor,
    })),
  };
}

const basePolicy: Omit<MerchantPolicy, "merchantId"> = {
  negotiationEnabled: true,
  campaignBudgetTotalMinor: 5_000_000,
  perDealCapMinor: 20_000,
  maxRounds: 3,
  concessionCurve: [0.4, 0.7, 1.0],
  offerTtlSeconds: 600,
  slowMovingTolerance: 0.03,
  allowedCommitments: [
    { commitmentType: "PREPAID", valueMinor: 12000 },
    { commitmentType: "NON_RETURNABLE", valueMinor: 9000 },
    { commitmentType: "EXTENDED_DELIVERY_WINDOW", valueMinor: 6000 },
  ],
  autonomousPaymentExecution: false,
  policyVersion: 1,
};

describe("property test — no candidate the generator produces ever has a line below its floor (randomized catalogues + baskets)", () => {
  it("holds across 80 randomized catalogues, baskets and rounds, checked through the extracted findFloorBreaches primitive", () => {
    const rng = createSeededRandom(10620250905);

    for (let trial = 0; trial < 80; trial += 1) {
      const merchantId = randomUuid(rng);
      const catalogueSize = randomInt(rng, 4, 30);
      const catalogue = randomCatalogue(rng, merchantId, catalogueSize);
      const lineCount = randomInt(rng, 1, Math.min(4, catalogueSize));
      const trialOriginalBasket = randomOriginalBasket(rng, catalogue, lineCount);
      const roundIndex = randomInt(rng, 1, 3);
      const trialPolicy: MerchantPolicy = { ...basePolicy, merchantId };

      const result = generateCandidates({
        session: {
          originalBasket: trialOriginalBasket,
          counterfactualContributionMinor: computeCounterfactualContribution(trialOriginalBasket, catalogue),
          roundIndex,
        },
        policy: trialPolicy,
        skuCatalogue: catalogue,
      });

      for (const candidate of result.candidates) {
        expect(findFloorBreaches(candidate.basket, catalogue)).toEqual([]);
      }
    }
  });
});
