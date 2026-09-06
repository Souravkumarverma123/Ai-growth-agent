import { describe, expect, it } from "vitest";

import type { Basket, Candidate, MerchantPolicy, SkuPolicy } from "../contracts";
import { MAX_CANDIDATES, TRANSITIONS } from "../contracts";
import { computeBasketContribution, computeCounterfactualContribution } from "../economics";
import type { TieredCandidate } from "../generation";
import {
  assertNoFloorBreach,
  assignTiersAndFeasibility,
  generateCandidates,
  selectCandidate,
} from "../generation";
import { mintOffer } from "../minting";
import {
  resolveBudgetReservedTransition,
  resolveBuyerDeclinesTransition,
  resolveHoldCommittedTransition,
  resolveHoldReleaseTransition,
} from "../ledger";
import {
  createSeededRandom,
  randomChoice,
  randomInt,
  randomUuid,
  shuffle,
} from "./support/seeded-random";

/**
 * TICKET-601 — the economics invariant suite (PRD §6, §7.1, §8, §21).
 *
 * Phase 6's own preamble: "Invariant tests are P0 and are not optional. They
 * are the product claim." Where the per-ticket suites (TICKET-103/104/105/
 * 107/108/109) each exercise ONE function in isolation, this file drives the
 * whole engine pipeline end to end —
 *
 *   generateCandidates -> assignTiersAndFeasibility -> selectCandidate -> mintOffer
 *
 * — over randomized catalogues, baskets, rounds and budgets, and asserts the
 * seven economic invariants this ticket names hold as *emergent properties of
 * the composition*, not just of any single stage. `packages/policy` is pure
 * (CONTRACTS.md §8: "call it directly") so there is no seam and no database —
 * the campaign-budget hold LIFECYCLE proper is `packages/database`'s share
 * (TICKET-108) and its concurrency safety `packages/payments`' (TICKET-305,
 * TICKET-604); what this file owns for invariant 4 is the frozen state
 * machine's reading, asserted through the transition resolvers.
 *
 * All money is integer minor units (paise) throughout (CONTRACTS.md §3).
 */

// ---------------------------------------------------------------------------
// A standard, non-random scenario — rich enough that every move type has
// something real to select, mirroring candidate-generation.test.ts's fixture.
// ---------------------------------------------------------------------------

const STANDARD_MERCHANT_ID = "99999999-9999-4999-8999-999999999999";
const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";
const CLEANSER_SKU_ID = "22222222-2222-4222-8222-222222222222";
const NIGHT_CREAM_SKU_ID = "33333333-3333-4333-8333-333333333333";
const BOOSTER_SKU_ID = "44444444-4444-4444-8444-444444444444";
const FOAMING_CLEANSER_SKU_ID = "55555555-5555-4555-8555-555555555555";
const TONER_SKU_ID = "66666666-6666-4666-8666-666666666666";
const GIFT_SET_SKU_ID = "77777777-7777-4777-8777-777777777777";

const standardCatalogue: SkuPolicy[] = [
  {
    skuId: SERUM_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "VIT-C-SERUM",
    name: "Vitamin C Serum",
    listPriceMinor: 180000,
    floorPriceMinor: 110000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    skuId: CLEANSER_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "GENTLE-CLEANSER",
    name: "Gentle Cleanser",
    listPriceMinor: 70000,
    floorPriceMinor: 45000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    skuId: NIGHT_CREAM_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "NIGHT-CREAM",
    name: "Night Cream",
    listPriceMinor: 90000,
    floorPriceMinor: 52000,
    negotiable: true,
    slowMoving: true,
    affinityGroup: "moisturizers",
  },
  {
    skuId: BOOSTER_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "VIT-C-BOOSTER",
    name: "Vitamin C Booster",
    listPriceMinor: 120000,
    floorPriceMinor: 80000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    skuId: FOAMING_CLEANSER_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "FOAMING-CLEANSER",
    name: "Foaming Cleanser",
    listPriceMinor: 60000,
    floorPriceMinor: 38000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "cleansers",
  },
  {
    skuId: TONER_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "DISCONTINUED-TONER",
    name: "Discontinued Toner",
    listPriceMinor: 50000,
    floorPriceMinor: 20000,
    negotiable: true,
    slowMoving: true,
    affinityGroup: "toners",
  },
  {
    skuId: GIFT_SET_SKU_ID,
    merchantId: STANDARD_MERCHANT_ID,
    sku: "LIMITED-GIFT-SET",
    name: "Limited Edition Gift Set",
    listPriceMinor: 250000,
    floorPriceMinor: 250000,
    negotiable: false,
    slowMoving: false,
    affinityGroup: null,
  },
];

const standardBasket: Basket = {
  currency: "INR",
  commitments: [],
  lines: [
    { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 180000 },
    { skuId: CLEANSER_SKU_ID, quantity: 1, unitPriceMinor: 70000 },
    { skuId: GIFT_SET_SKU_ID, quantity: 1, unitPriceMinor: 250000 },
  ],
};

const standardPolicy: MerchantPolicy = {
  merchantId: STANDARD_MERCHANT_ID,
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

// ---------------------------------------------------------------------------
// Pipeline runner — the composition under test
// ---------------------------------------------------------------------------

type Scenario = {
  catalogue: readonly SkuPolicy[];
  policy: MerchantPolicy;
  originalBasket: Basket;
  roundIndex: number;
  tier1Refused: boolean;
  availableCampaignBudgetMinor: number;
};

type PipelineResult =
  | { feasible: false }
  | {
      feasible: true;
      tiered: readonly TieredCandidate[];
      selectable: readonly TieredCandidate[];
      selected: TieredCandidate;
      mint: ReturnType<typeof mintOffer>;
    };

const SESSION_ID = "abcdefab-abcd-4abc-8abc-abcdefabcdef";

/** Adds the three identity fields tiering deliberately leaves off, so a
 *  `TieredCandidate` can be handed to `mintOffer`. `roundIndex` is threaded
 *  from the scenario, not hardcoded, so a round-2/3 scenario actually carries
 *  its round into the candidate set and the minted offer. */
function toCandidate(tiered: TieredCandidate, index: number, roundIndex: number): Candidate {
  return { ...tiered, candidateId: `cand-${index}`, sessionId: SESSION_ID, roundIndex };
}

function runPipeline(scenario: Scenario): PipelineResult {
  const {
    catalogue,
    policy,
    originalBasket,
    roundIndex,
    tier1Refused,
    availableCampaignBudgetMinor,
  } = scenario;

  const generated = generateCandidates({
    session: {
      originalBasket,
      counterfactualContributionMinor: computeCounterfactualContribution(originalBasket, catalogue),
      roundIndex,
    },
    policy,
    skuCatalogue: catalogue,
  });

  const tiering = assignTiersAndFeasibility({
    candidates: generated.candidates,
    tier1Refused,
    perDealCapMinor: policy.perDealCapMinor,
    availableCampaignBudgetMinor,
  });

  if (!tiering.feasible) {
    return { feasible: false };
  }

  const selected = selectCandidate(tiering.selectableCandidates);
  // `mintOffer`'s contract (mint.ts) wants the WHOLE round set, not just the
  // selectable subset — so a forged/locked/infeasible candidate id is rejected
  // with the right shape rather than a bare "not found".
  const candidatesInRound = tiering.candidates.map((c, i) => toCandidate(c, i, roundIndex));
  const selectedCandidate = candidatesInRound[tiering.candidates.indexOf(selected)]!;

  const mint = mintOffer({
    sessionId: SESSION_ID,
    roundIndex,
    policyVersion: policy.policyVersion,
    tier1Refused,
    candidatesInRound,
    candidateId: selectedCandidate.candidateId,
    campaignBudgetReservation:
      selected.tier === 2
        ? {
            reserved: true,
            offerId: "11111111-2222-4333-8444-555555555555",
            amountMinor: selected.requiredCampaignSpendMinor,
          }
        : undefined,
    now: new Date("2026-09-06T00:00:00.000Z"),
    offerTtlSeconds: policy.offerTtlSeconds,
    signingSecret: "invariant-suite-signing-secret",
  });

  return {
    feasible: true,
    tiered: tiering.candidates,
    selectable: tiering.selectableCandidates,
    selected,
    mint,
  };
}

// ---------------------------------------------------------------------------
// Randomized scenario generation
// ---------------------------------------------------------------------------

type Rng = ReturnType<typeof createSeededRandom>;

function randomSkuPolicy(rng: Rng, merchantId: string, index: number): SkuPolicy {
  const floorPriceMinor = randomInt(rng, 1_000, 100_000);
  const headroom = randomInt(rng, 0, 120_000);
  const groups = ["serums", "cleansers", "moisturizers", "toners", null, null] as const;
  return {
    skuId: randomUuid(rng),
    merchantId,
    sku: `RAND-SKU-${index}`,
    name: `Random SKU ${index}`,
    listPriceMinor: floorPriceMinor + headroom,
    floorPriceMinor,
    negotiable: rng() > 0.15,
    slowMoving: rng() > 0.55,
    affinityGroup: randomChoice(rng, groups),
  };
}

function randomScenario(rng: Rng): Scenario {
  const merchantId = randomUuid(rng);
  const catalogueSize = randomInt(rng, 4, 24);
  const catalogue = Array.from({ length: catalogueSize }, (_, i) =>
    randomSkuPolicy(rng, merchantId, i),
  );
  const lineCount = randomInt(rng, 1, Math.min(4, catalogueSize));
  const chosen = shuffle(rng, catalogue).slice(0, lineCount);
  const originalBasket: Basket = {
    currency: "INR",
    commitments: [],
    // Captured at list, as a freshly at-risk cart would be.
    lines: chosen.map((sku) => ({
      skuId: sku.skuId,
      quantity: randomInt(rng, 1, 3),
      unitPriceMinor: sku.listPriceMinor,
    })),
  };
  const campaignBudgetTotalMinor = randomInt(rng, 0, 2_000_000);
  return {
    catalogue,
    policy: {
      ...standardPolicy,
      merchantId,
      perDealCapMinor: randomInt(rng, 5_000, 120_000),
      campaignBudgetTotalMinor,
    },
    originalBasket,
    roundIndex: randomInt(rng, 1, 3),
    tier1Refused: rng() > 0.5,
    // `available = total - reserved - committed` (PRD §6.5) — never above total.
    availableCampaignBudgetMinor: randomInt(rng, 0, campaignBudgetTotalMinor),
  };
}

function skuById(catalogue: readonly SkuPolicy[]): Map<string, SkuPolicy> {
  return new Map(catalogue.map((sku) => [sku.skuId, sku] as const));
}

// ===========================================================================
// Invariant 1 — an offer can never violate a SKU floor
// ===========================================================================

describe("INVARIANT: no candidate or minted offer ever prices a line below its SKU floor (PRD §8, §21.7)", () => {
  it("holds across 200 randomized catalogues, baskets, rounds and budgets — through the full pipeline", () => {
    const rng = createSeededRandom(0x601_0001);

    for (let trial = 0; trial < 200; trial += 1) {
      const scenario = randomScenario(rng);
      const result = runPipeline(scenario);
      const catalogueIndex = skuById(scenario.catalogue);

      const generated = generateCandidates({
        session: {
          originalBasket: scenario.originalBasket,
          counterfactualContributionMinor: computeCounterfactualContribution(
            scenario.originalBasket,
            scenario.catalogue,
          ),
          roundIndex: scenario.roundIndex,
        },
        policy: scenario.policy,
        skuCatalogue: scenario.catalogue,
      });

      expect(generated.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);

      for (const candidate of generated.candidates) {
        for (const line of candidate.basket.lines) {
          const sku = catalogueIndex.get(line.skuId);
          expect(sku).toBeDefined();
          expect(line.unitPriceMinor).toBeGreaterThanOrEqual(sku!.floorPriceMinor);
        }
      }

      if (result.feasible && result.mint.minted) {
        const offer = result.mint.offer;
        for (const line of offer.basket.lines) {
          const sku = catalogueIndex.get(line.skuId);
          expect(line.unitPriceMinor).toBeGreaterThanOrEqual(sku!.floorPriceMinor);
        }
        // The mint-time defensive assertion agrees — a sub-floor line in the
        // candidate that became this offer would throw FloorBreachError here
        // (PRD §17 row 9). `offer.basket` is a verbatim copy of the selected
        // candidate's basket (mint.ts), so checking the candidate covers it.
        expect(() =>
          assertNoFloorBreach(
            toCandidate(result.selected, 0, scenario.roundIndex),
            scenario.catalogue,
            scenario.policy.merchantId,
          ),
        ).not.toThrow();
      }
    }
  });

  it("a non-negotiable SKU is never discounted in any candidate, whatever move type produced it", () => {
    const rng = createSeededRandom(0x601_0002);

    for (let trial = 0; trial < 60; trial += 1) {
      const scenario = randomScenario(rng);
      const generated = generateCandidates({
        session: {
          originalBasket: scenario.originalBasket,
          counterfactualContributionMinor: computeCounterfactualContribution(
            scenario.originalBasket,
            scenario.catalogue,
          ),
          roundIndex: scenario.roundIndex,
        },
        policy: scenario.policy,
        skuCatalogue: scenario.catalogue,
      });
      const catalogueIndex = skuById(scenario.catalogue);

      for (const candidate of generated.candidates) {
        for (const line of candidate.basket.lines) {
          const sku = catalogueIndex.get(line.skuId)!;
          if (!sku.negotiable) {
            const originalLine = scenario.originalBasket.lines.find((l) => l.skuId === line.skuId);
            expect(line.unitPriceMinor).toBe(
              originalLine ? originalLine.unitPriceMinor : sku.listPriceMinor,
            );
          }
        }
      }
    }
  });
});

// ===========================================================================
// Invariant 2 — campaign spend cannot exceed the per-deal cap
// Invariant 3 — campaign spend cannot exceed remaining campaign budget
// ===========================================================================

describe("INVARIANT: a selectable/minted Tier 2 offer's campaign spend never exceeds the per-deal cap or the remaining budget (PRD §6.4, §21.7)", () => {
  it("holds across 200 randomized scenarios — every feasible Tier 2 candidate the tiering step produces", () => {
    const rng = createSeededRandom(0x601_0003);
    let feasibleTier2Seen = 0;
    let rejectedTier2Seen = 0;

    for (let trial = 0; trial < 200; trial += 1) {
      const scenario = randomScenario(rng);
      const result = runPipeline(scenario);
      if (!result.feasible) continue;

      for (const candidate of result.tiered) {
        if (candidate.tier === 2 && candidate.feasible) {
          feasibleTier2Seen += 1;
          expect(candidate.requiredCampaignSpendMinor).toBeLessThanOrEqual(
            scenario.policy.perDealCapMinor,
          );
          expect(candidate.requiredCampaignSpendMinor).toBeLessThanOrEqual(
            scenario.availableCampaignBudgetMinor,
          );
          expect(candidate.requiredCampaignSpendMinor).toBeGreaterThan(0);
        }
        // The contrapositive of invariants 2 & 3: a Tier 2 candidate whose
        // spend WOULD exceed a cap is rejected, with the reason code that
        // matches which limit it broke — per-deal cap checked first (PRD §6.4).
        if (candidate.tier === 2 && !candidate.feasible) {
          rejectedTier2Seen += 1;
          const shortfall = candidate.requiredCampaignSpendMinor;
          if (shortfall > scenario.policy.perDealCapMinor) {
            expect(candidate.infeasibleReason).toBe("DILUTION_EXCEEDS_PER_DEAL_CAP");
          } else {
            expect(shortfall).toBeGreaterThan(scenario.availableCampaignBudgetMinor);
            expect(candidate.infeasibleReason).toBe("CAMPAIGN_BUDGET_EXHAUSTED");
          }
        }
        // A Tier 1 candidate never consumes campaign budget at all.
        if (candidate.tier === 1) {
          expect(candidate.requiredCampaignSpendMinor).toBe(0);
        }
      }

      // In a single-shot pipeline a Tier 1 candidate (INCREASE_QUANTITY or a
      // COMMITMENT_SWAP) is almost always present and always outranks a
      // dilutive Tier 2 one, so the selected candidate is nearly always Tier 1
      // (ISSUE-012 sub-issue 12e). When a Tier 2 candidate IS selected, it
      // still must respect both caps.
      if (result.selected.tier === 2) {
        expect(result.selected.requiredCampaignSpendMinor).toBeLessThanOrEqual(
          scenario.policy.perDealCapMinor,
        );
        expect(result.selected.requiredCampaignSpendMinor).toBeLessThanOrEqual(
          scenario.availableCampaignBudgetMinor,
        );
      }
      if (result.mint.minted) {
        const offer = result.mint.offer;
        expect(offer.campaignSpendMinor).toBe(
          offer.tier === 2 ? result.selected.requiredCampaignSpendMinor : 0,
        );
        if (offer.tier === 2) {
          expect(offer.campaignSpendMinor).toBeLessThanOrEqual(scenario.policy.perDealCapMinor);
          expect(offer.campaignSpendMinor).toBeLessThanOrEqual(
            scenario.availableCampaignBudgetMinor,
          );
        }
      }
    }

    // The sweep must actually exercise both a feasible Tier 2 candidate and a
    // cap/budget-rejected one, even if it rarely selects either.
    expect(feasibleTier2Seen).toBeGreaterThan(0);
    expect(rejectedTier2Seen).toBeGreaterThan(0);
  });

  it("a fully-infeasible pipeline (every Tier 2 over cap, no Tier 1) resolves to NO_FEASIBLE_BASKET", () => {
    const tiering = assignTiersAndFeasibility({
      candidates: [-25_000, -40_000].map((contributionDeltaMinor, i) => ({
        moveType: "PRICE_CONCESSION" as const,
        basket: {
          currency: "INR" as const,
          commitments: [],
          lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 150_000 + i }],
        },
        totalMinor: 150_000 + i,
        contributionMinor: 100_000 + contributionDeltaMinor,
        contributionDeltaMinor,
        clearsSlowMoving: false,
      })),
      tier1Refused: true,
      perDealCapMinor: 20_000,
      availableCampaignBudgetMinor: 5_000_000,
    });
    expect(tiering).toEqual({ feasible: false, reasonCode: "NO_FEASIBLE_BASKET" });
  });

  it("when a Tier 2 candidate IS selected (no Tier 1 in play) and minted, its spend equals the shortfall and clears both caps", () => {
    // Forced: only dilutive candidates, tier1Refused true, so the selectable
    // set is Tier-2-only and selectCandidate must pick one.
    const perDealCapMinor = 20_000;
    const availableCampaignBudgetMinor = 50_000;
    const dilutiveDeltas = [-8_000, -15_000, -20_000]; // all within the ₹200 cap

    const tiering = assignTiersAndFeasibility({
      candidates: dilutiveDeltas.map((contributionDeltaMinor, i) => ({
        moveType: "PRICE_CONCESSION" as const,
        basket: {
          currency: "INR" as const,
          commitments: [],
          lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 150_000 + i }],
        },
        totalMinor: 150_000 + i,
        contributionMinor: 100_000 + contributionDeltaMinor,
        contributionDeltaMinor,
        clearsSlowMoving: false,
      })),
      tier1Refused: true,
      perDealCapMinor,
      availableCampaignBudgetMinor,
    });
    if (!tiering.feasible) throw new Error("expected feasible");

    const selected = selectCandidate(tiering.selectableCandidates);
    expect(selected.tier).toBe(2);
    expect(selected.requiredCampaignSpendMinor).toBeLessThanOrEqual(perDealCapMinor);
    expect(selected.requiredCampaignSpendMinor).toBeLessThanOrEqual(availableCampaignBudgetMinor);

    const candidatesInRound = tiering.candidates.map((c, i) => toCandidate(c, i, 1));
    const mint = mintOffer({
      sessionId: SESSION_ID,
      roundIndex: 1,
      policyVersion: 1,
      tier1Refused: true,
      candidatesInRound,
      candidateId: candidatesInRound[tiering.candidates.indexOf(selected)]!.candidateId,
      campaignBudgetReservation: {
        reserved: true,
        offerId: "11111111-2222-4333-8444-555555555555",
        amountMinor: selected.requiredCampaignSpendMinor,
      },
      now: new Date("2026-09-06T00:00:00.000Z"),
      offerTtlSeconds: 600,
      signingSecret: "invariant-suite-signing-secret",
    });
    if (!mint.minted) throw new Error(`expected mint, got ${mint.reasonCode}`);
    expect(mint.offer.campaignSpendMinor).toBe(selected.requiredCampaignSpendMinor);
    expect(mint.offer.campaignSpendMinor).toBe(-selected.contributionDeltaMinor);
    expect(mint.offer.campaignSpendMinor).toBeLessThanOrEqual(perDealCapMinor);
    expect(mint.offer.campaignSpendMinor).toBeLessThanOrEqual(availableCampaignBudgetMinor);
  });

  it("campaign spend equals the EXACT contribution shortfall — no rounding, no buffer (PRD §6.4)", () => {
    const rng = createSeededRandom(0x601_0004);

    for (let trial = 0; trial < 120; trial += 1) {
      const scenario = { ...randomScenario(rng), tier1Refused: true };
      const result = runPipeline(scenario);
      if (!result.feasible) continue;

      for (const candidate of result.tiered) {
        if (candidate.tier !== 2) continue;
        const counterfactual = computeCounterfactualContribution(
          scenario.originalBasket,
          scenario.catalogue,
        );
        const proposed = computeBasketContribution(
          candidate.basket,
          scenario.catalogue,
          scenario.policy.allowedCommitments,
        );
        expect(candidate.requiredCampaignSpendMinor).toBe(counterfactual - proposed);
        expect(candidate.requiredCampaignSpendMinor).toBe(-candidate.contributionDeltaMinor);
      }
    }
  });

  it("a candidate whose shortfall is one minor unit over the cap is never selectable (boundary)", () => {
    // Deterministic scenario: a single dilutive candidate exactly 1 over cap.
    const dilutive: TieredCandidate = {
      moveType: "PRICE_CONCESSION",
      basket: standardBasket,
      totalMinor: 500000,
      contributionMinor: 100_000,
      contributionDeltaMinor: -(standardPolicy.perDealCapMinor + 1),
      clearsSlowMoving: false,
      tier: 2,
      requiredCampaignSpendMinor: standardPolicy.perDealCapMinor + 1,
      feasible: false,
      infeasibleReason: "DILUTION_EXCEEDS_PER_DEAL_CAP",
    };
    const tier1: TieredCandidate = {
      ...dilutive,
      contributionDeltaMinor: 0,
      contributionMinor: 120_000,
      tier: 1,
      requiredCampaignSpendMinor: 0,
      feasible: true,
      infeasibleReason: null,
    };

    const result = assignTiersAndFeasibility({
      candidates: [
        {
          moveType: dilutive.moveType,
          basket: dilutive.basket,
          totalMinor: dilutive.totalMinor,
          contributionMinor: dilutive.contributionMinor,
          contributionDeltaMinor: dilutive.contributionDeltaMinor,
          clearsSlowMoving: false,
        },
        {
          moveType: tier1.moveType,
          basket: tier1.basket,
          totalMinor: tier1.totalMinor,
          contributionMinor: tier1.contributionMinor,
          contributionDeltaMinor: 0,
          clearsSlowMoving: false,
        },
      ],
      tier1Refused: true,
      perDealCapMinor: standardPolicy.perDealCapMinor,
      availableCampaignBudgetMinor: standardPolicy.campaignBudgetTotalMinor,
    });

    if (!result.feasible) throw new Error("expected feasible");
    expect(result.selectableCandidates.every((c) => c.tier === 1)).toBe(true);
  });
});

// ===========================================================================
// Invariant 4 — holds are reserved, released and committed with exactly one
// reason code each, and the frozen state machine's release paths match the
// causes PRD §6.5 lists (frozen-table reading; PRD §6.5, §21.8). The one
// terminal path that is NOT covered — BUYER_ENDS_SESSION -> DECLINED — is
// pinned as an explicit known gap (ISSUE-015), not left implicit.
// ===========================================================================

describe("INVARIANT: the campaign-hold lifecycle is single-coded, and its release paths match the frozen state machine (PRD §6.5)", () => {
  it("reserve resolves to exactly HOLD_RESERVED, and only for Tier 2", () => {
    const reserve = resolveBudgetReservedTransition(2);
    expect(reserve.reasonCode).toBe("HOLD_RESERVED");
    expect(reserve.event).toBe("BUDGET_RESERVED");
    expect(reserve.from).toBe("OFFER_PENDING");
    expect(() => resolveBudgetReservedTransition(1)).toThrow(/tier 2/i);
  });

  it("commit resolves to exactly HOLD_COMMITTED on SETTLED, and only for Tier 2", () => {
    const commit = resolveHoldCommittedTransition(2);
    expect(commit.reasonCode).toBe("HOLD_COMMITTED");
    expect(commit.from).toBe("SETTLED");
    expect(commit.to).toBe("SETTLED");
    expect(() => resolveHoldCommittedTransition(1)).toThrow(/tier 2/i);
  });

  it("every way a Tier 2 hold can be unwound resolves to exactly HOLD_RELEASED", () => {
    // The three real-world release causes (PRD §6.5): buyer declines a Tier 2
    // offer, the offer's TTL elapses, or the payment fails / diverges.
    expect(resolveBuyerDeclinesTransition(2).reasonCode).toBe("HOLD_RELEASED");
    expect(resolveHoldReleaseTransition("EXPIRED", 2).reasonCode).toBe("HOLD_RELEASED");
    expect(resolveHoldReleaseTransition("PAYMENT_FAILED", 2).reasonCode).toBe("HOLD_RELEASED");

    // Tier 1 has no hold — releasing one is a caller bug, not a silent no-op.
    expect(() => resolveHoldReleaseTransition("EXPIRED", 1)).toThrow(/tier 2/i);
  });

  it("the frozen table's HOLD_RELEASED transitions fire from OFFER_PENDING (decline), EXPIRED and PAYMENT_FAILED", () => {
    const releaseFroms = TRANSITIONS.filter((t) => t.reasonCode === "HOLD_RELEASED")
      .map((t) => t.from)
      .sort();
    // A hold is reserved in OFFER_PENDING and released when the offer is
    // declined (OFFER_PENDING -> OPEN), expires (EXPIRED) or the payment fails
    // (PAYMENT_FAILED). If ISSUE-015 is resolved, "DECLINED" joins this list.
    expect(releaseFroms).toEqual(["EXPIRED", "OFFER_PENDING", "PAYMENT_FAILED"]);
  });

  it("KNOWN GAP (ISSUE-015): DECLINED — the buyer-ends-session terminal state — has no hold-release transition", () => {
    // A Tier 2 hold reserved in OFFER_PENDING can still be outstanding when the
    // buyer ends the session outright (OFFER_PENDING -> BUYER_ENDS_SESSION ->
    // DECLINED). The frozen state machine has no transition originating from
    // DECLINED at all — so such a hold has no HOLD_RELEASED event and
    // self-heals only via its TTL (issue-tracker.md ISSUE-015). This pins the
    // gap as an explicit expectation rather than a buried comment: adding a
    // `DECLINED --HOLD_RELEASED--> DECLINED` self-loop (the ISSUE-015 fix)
    // makes this test fail and points the author here.
    const buyerEndsSession = TRANSITIONS.find((t) => t.event === "BUYER_ENDS_SESSION");
    expect(buyerEndsSession?.to).toBe("DECLINED");

    // `as string` on purpose — the frozen table's inferred `from` union does
    // not even include "DECLINED", which is exactly the gap being pinned.
    const fromStates = TRANSITIONS.map((t) => t.from as string);
    expect(fromStates).not.toContain("DECLINED");
  });

  it("HOLD_RESERVED / HOLD_RELEASED / HOLD_COMMITTED are each the only code on their transition, never merged with a session code", () => {
    for (const code of ["HOLD_RESERVED", "HOLD_RELEASED", "HOLD_COMMITTED"] as const) {
      const rows = TRANSITIONS.filter((t) => t.reasonCode === code);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // A hold transition never also carries a session-outcome meaning:
        // OFFER_EXPIRED / PAYMENT_FAILED / PAYMENT_CAPTURED live on their own
        // separate rows (different events).
        expect(["BUDGET_RESERVED", "BUYER_DECLINES", "HOLD_RELEASED", "HOLD_COMMITTED"]).toContain(
          row.event,
        );
      }
    }
  });
});

// ===========================================================================
// Invariant 5 — Tier 2 cannot unlock before a Tier 1 refusal (RA-2)
// ===========================================================================

describe("INVARIANT: no Tier 2 candidate is selectable or mintable before a Tier 1 refusal is logged (PRD §7.1, §21.5)", () => {
  it("across 200 randomized scenarios, selectableCandidates holds zero Tier 2 entries whenever tier1Refused is false", () => {
    const rng = createSeededRandom(0x601_0005);
    let checkedWhileLocked = 0;

    for (let trial = 0; trial < 200; trial += 1) {
      const scenario = { ...randomScenario(rng), tier1Refused: false };
      const result = runPipeline(scenario);
      if (!result.feasible) continue;
      checkedWhileLocked += 1;

      expect(result.selectable.every((c) => c.tier === 1)).toBe(true);
      expect(result.selected.tier).toBe(1);
      if (result.mint.minted) {
        expect(result.mint.offer.tier).toBe(1);
      }
    }

    expect(checkedWhileLocked).toBeGreaterThan(0);
  });

  it("a feasible Tier 2 candidate flips from locked to selectable purely on tier1Refused, nothing else changing", () => {
    const scenario: Scenario = {
      catalogue: standardCatalogue,
      policy: standardPolicy,
      // Toner alone at list: its round-1 PRICE_CONCESSION releases
      // floor(30_000 * 0.4) = 12_000, a shortfall inside the ₹200 per-deal cap
      // — a genuinely feasible Tier 2 candidate, gated only by the refusal.
      originalBasket: {
        currency: "INR",
        commitments: [],
        lines: [{ skuId: TONER_SKU_ID, quantity: 1, unitPriceMinor: 50000 }],
      },
      roundIndex: 1,
      tier1Refused: false,
      availableCampaignBudgetMinor: 5_000_000,
    };

    const locked = runPipeline({ ...scenario, tier1Refused: false });
    const unlocked = runPipeline({ ...scenario, tier1Refused: true });
    if (!locked.feasible || !unlocked.feasible) throw new Error("expected both runs feasible");

    // The tiered set is identical — only the gate moved.
    expect(unlocked.tiered).toEqual(locked.tiered);
    const feasibleTier2 = unlocked.tiered.filter((c) => c.tier === 2 && c.feasible);
    expect(feasibleTier2.length).toBeGreaterThan(0);

    // Locked: not one of those feasible Tier 2 candidates is selectable.
    expect(locked.selectable.some((c) => c.tier === 2)).toBe(false);
    // Unlocked: they are.
    expect(unlocked.selectable.some((c) => c.tier === 2)).toBe(true);
  });

  it("mintOffer throws if handed a Tier 2 candidate id while tier1Refused is false (RA-2 backstop)", () => {
    const tier2Candidate: Candidate = {
      candidateId: "cand-tier2",
      sessionId: SESSION_ID,
      roundIndex: 1,
      moveType: "PRICE_CONCESSION",
      basket: standardBasket,
      totalMinor: 500000,
      contributionMinor: 80_000,
      contributionDeltaMinor: -10_000,
      tier: 2,
      requiredCampaignSpendMinor: 10_000,
      clearsSlowMoving: false,
      feasible: true,
      infeasibleReason: null,
    };

    expect(() =>
      mintOffer({
        sessionId: SESSION_ID,
        roundIndex: 1,
        policyVersion: 1,
        tier1Refused: false,
        candidatesInRound: [tier2Candidate],
        candidateId: "cand-tier2",
        campaignBudgetReservation: {
          reserved: true,
          offerId: "11111111-2222-4333-8444-555555555555",
          amountMinor: 10_000,
        },
        now: new Date("2026-09-06T00:00:00.000Z"),
        offerTtlSeconds: 600,
        signingSecret: "invariant-suite-signing-secret",
      }),
    ).toThrow(/tier 2.*tier1Refused is false|RA-2/i);
  });
});

// ===========================================================================
// Invariant 6 — the 3% slow-moving band changes selection at 2% and not at 4%
// ===========================================================================

describe("INVARIANT: the fixed 3% slow-moving tolerance band changes selection at 2% behind and not at 4% (PRD §6.6)", () => {
  const BEST = 100_000;

  function candidate(overrides: Partial<TieredCandidate>): TieredCandidate {
    return {
      moveType: "PRICE_CONCESSION",
      basket: {
        currency: "INR",
        commitments: [],
        lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 1 }],
      },
      totalMinor: 1,
      contributionMinor: BEST,
      contributionDeltaMinor: 0,
      clearsSlowMoving: false,
      tier: 1,
      requiredCampaignSpendMinor: 0,
      feasible: true,
      infeasibleReason: null,
      ...overrides,
    };
  }

  it("prefers a slow-moving candidate 2% behind the best (inside the band)", () => {
    const best = candidate({ contributionMinor: BEST });
    const slow2pct = candidate({
      contributionMinor: 98_000,
      clearsSlowMoving: true,
      basket: {
        currency: "INR",
        commitments: [],
        lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 2 }],
      },
    });
    expect(selectCandidate([best, slow2pct])).toBe(slow2pct);
  });

  it("does NOT prefer a slow-moving candidate 4% behind the best (outside the band)", () => {
    const best = candidate({ contributionMinor: BEST });
    const slow4pct = candidate({
      contributionMinor: 96_000,
      clearsSlowMoving: true,
      basket: {
        currency: "INR",
        commitments: [],
        lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 3 }],
      },
    });
    expect(selectCandidate([best, slow4pct])).toBe(best);
  });

  it("treats exactly 3% behind as inside the band", () => {
    const best = candidate({ contributionMinor: BEST });
    const slow3pct = candidate({
      contributionMinor: 97_000,
      clearsSlowMoving: true,
      basket: {
        currency: "INR",
        commitments: [],
        lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 4 }],
      },
    });
    expect(selectCandidate([best, slow3pct])).toBe(slow3pct);
  });
});

// ===========================================================================
// Invariant 7 — candidate generation is deterministic across 100 runs
// ===========================================================================

describe("INVARIANT: the engine pipeline is deterministic — identical input yields byte-identical output across 100 runs (PRD §8, §21)", () => {
  it("generateCandidates is byte-identical across 100 runs of the standard scenario", () => {
    const session = {
      originalBasket: standardBasket,
      counterfactualContributionMinor: computeCounterfactualContribution(
        standardBasket,
        standardCatalogue,
      ),
      roundIndex: 2,
    };
    const first = generateCandidates({
      session,
      policy: standardPolicy,
      skuCatalogue: standardCatalogue,
    });
    for (let run = 0; run < 100; run += 1) {
      expect(
        generateCandidates({ session, policy: standardPolicy, skuCatalogue: standardCatalogue }),
      ).toEqual(first);
    }
  });

  it("the deterministic pipeline stages (generate -> tier -> select) are byte-identical across 100 runs", () => {
    // Offer minting deliberately mints a fresh random offerId for a Tier 1
    // candidate (mint.ts), so the minted Offer is NOT byte-stable and is
    // excluded here — invariant 7 is about candidate GENERATION determinism
    // (PRD §8), which flows through tiering and selection unchanged.
    const scenario: Scenario = {
      catalogue: standardCatalogue,
      policy: standardPolicy,
      originalBasket: standardBasket,
      roundIndex: 2,
      tier1Refused: true,
      availableCampaignBudgetMinor: 5_000_000,
    };
    const deterministicPart = () => {
      const r = runPipeline(scenario);
      if (!r.feasible) return { feasible: false as const };
      return {
        feasible: true as const,
        tiered: r.tiered,
        selectable: r.selectable,
        selected: r.selected,
      };
    };
    const first = deterministicPart();
    for (let run = 0; run < 100; run += 1) {
      expect(deterministicPart()).toEqual(first);
    }
  });

  it("selection is independent of the candidate array's own order (10 randomized scenarios, each shuffled 8 ways)", () => {
    const rng = createSeededRandom(0x601_0007);

    for (let trial = 0; trial < 10; trial += 1) {
      const scenario = { ...randomScenario(rng), tier1Refused: true };
      const generated = generateCandidates({
        session: {
          originalBasket: scenario.originalBasket,
          counterfactualContributionMinor: computeCounterfactualContribution(
            scenario.originalBasket,
            scenario.catalogue,
          ),
          roundIndex: scenario.roundIndex,
        },
        policy: scenario.policy,
        skuCatalogue: scenario.catalogue,
      });
      const tiering = assignTiersAndFeasibility({
        candidates: generated.candidates,
        tier1Refused: true,
        perDealCapMinor: scenario.policy.perDealCapMinor,
        availableCampaignBudgetMinor: scenario.availableCampaignBudgetMinor,
      });
      if (!tiering.feasible) continue;

      const canonicalWinner = selectCandidate(tiering.selectableCandidates);
      for (let shuffleRun = 0; shuffleRun < 8; shuffleRun += 1) {
        const shuffled = shuffle(rng, tiering.selectableCandidates);
        expect(selectCandidate(shuffled)).toEqual(canonicalWinner);
      }
    }
  });
});
