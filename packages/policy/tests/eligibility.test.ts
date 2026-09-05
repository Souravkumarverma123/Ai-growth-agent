import { describe, expect, it } from "vitest";

import type { Basket, MerchantPolicy, SkuPolicy } from "../contracts";
import type { EligibilityInput, EligibilitySessionInput } from "../eligibility";
import { checkEligibility } from "../eligibility";

/**
 * TICKET-101 — eligibility engine.
 *
 * Fixtures mirror the house style set by TICKET-102/103's tests: minor
 * units throughout (CONTRACTS.md §3), fixed UUIDs for readability.
 */

const MERCHANT_ID = "99999999-9999-4999-8999-999999999999";
const NEGOTIABLE_SKU_ID = "11111111-1111-4111-8111-111111111111";
const NON_NEGOTIABLE_SKU_ID = "22222222-2222-4222-8222-222222222222";

const skuCatalogue: SkuPolicy[] = [
  {
    skuId: NEGOTIABLE_SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "VIT-C-SERUM",
    name: "Vitamin C Serum",
    listPriceMinor: 180000,
    floorPriceMinor: 110000,
    negotiable: true,
    slowMoving: false,
    affinityGroup: "serums",
  },
  {
    skuId: NON_NEGOTIABLE_SKU_ID,
    merchantId: MERCHANT_ID,
    sku: "LIMITED-GIFT-SET",
    name: "Limited Edition Gift Set",
    listPriceMinor: 250000,
    floorPriceMinor: 250000,
    negotiable: false,
    slowMoving: false,
    affinityGroup: null,
  },
];

const basketWithNegotiableSku: Basket = {
  currency: "INR",
  commitments: [],
  lines: [{ skuId: NEGOTIABLE_SKU_ID, quantity: 1, unitPriceMinor: 180000 }],
};

const basketWithOnlyNonNegotiableSku: Basket = {
  currency: "INR",
  commitments: [],
  lines: [{ skuId: NON_NEGOTIABLE_SKU_ID, quantity: 1, unitPriceMinor: 250000 }],
};

const enabledPolicy: MerchantPolicy = {
  merchantId: MERCHANT_ID,
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

function buildSessionInput(overrides?: Partial<EligibilitySessionInput>): EligibilitySessionInput {
  return {
    originalBasket: basketWithNegotiableSku,
    isFlaggedAtRisk: true,
    ...overrides,
  };
}

function buildInput(overrides?: {
  session?: Partial<EligibilitySessionInput>;
  policy?: Partial<MerchantPolicy>;
  skuCatalogue?: readonly SkuPolicy[];
}): EligibilityInput {
  return {
    session: buildSessionInput(overrides?.session),
    policy: { ...enabledPolicy, ...overrides?.policy },
    skuCatalogue: overrides?.skuCatalogue ?? skuCatalogue,
  };
}

// ---------------------------------------------------------------------------
// Acceptance criteria — each refusal path, and the eligible path
// ---------------------------------------------------------------------------

describe("checkEligibility — acceptance criteria (Tickets.md TICKET-101)", () => {
  it("an unflagged session yields NOT_AT_RISK", () => {
    const result = checkEligibility(buildInput({ session: { isFlaggedAtRisk: false } }));
    expect(result).toEqual({ eligible: false, reasonCode: "NOT_AT_RISK" });
  });

  it("kill switch off yields NEGOTIATION_DISABLED, regardless of basket contents", () => {
    const withNegotiableSku = checkEligibility(
      buildInput({ policy: { negotiationEnabled: false }, session: { originalBasket: basketWithNegotiableSku } }),
    );
    const withOnlyNonNegotiableSku = checkEligibility(
      buildInput({
        policy: { negotiationEnabled: false },
        session: { originalBasket: basketWithOnlyNonNegotiableSku },
      }),
    );

    expect(withNegotiableSku).toEqual({ eligible: false, reasonCode: "NEGOTIATION_DISABLED" });
    expect(withOnlyNonNegotiableSku).toEqual({ eligible: false, reasonCode: "NEGOTIATION_DISABLED" });
  });

  it("a basket where every SKU is negotiable: false yields SKU_NOT_NEGOTIABLE", () => {
    const result = checkEligibility(
      buildInput({ session: { originalBasket: basketWithOnlyNonNegotiableSku } }),
    );
    expect(result).toEqual({ eligible: false, reasonCode: "SKU_NOT_NEGOTIABLE" });
  });

  it("a flagged session, kill switch on, with at least one negotiable SKU is eligible", () => {
    const result = checkEligibility(buildInput());
    expect(result).toEqual({ eligible: true, reasonCode: "NEGOTIATION_OPENED" });
  });

  it("a basket mixing a negotiable and a non-negotiable SKU is still eligible — one negotiable SKU is enough", () => {
    const mixedBasket: Basket = {
      currency: "INR",
      commitments: [],
      lines: [
        { skuId: NEGOTIABLE_SKU_ID, quantity: 1, unitPriceMinor: 180000 },
        { skuId: NON_NEGOTIABLE_SKU_ID, quantity: 1, unitPriceMinor: 250000 },
      ],
    };
    const result = checkEligibility(buildInput({ session: { originalBasket: mixedBasket } }));
    expect(result).toEqual({ eligible: true, reasonCode: "NEGOTIATION_OPENED" });
  });

  it("every refusal path returns its own distinct code, and the eligible path is distinguishable from all of them", () => {
    const notAtRisk = checkEligibility(buildInput({ session: { isFlaggedAtRisk: false } }));
    const negotiationDisabled = checkEligibility(buildInput({ policy: { negotiationEnabled: false } }));
    const skuNotNegotiable = checkEligibility(
      buildInput({ session: { originalBasket: basketWithOnlyNonNegotiableSku } }),
    );
    const eligible = checkEligibility(buildInput());

    const codes = [notAtRisk, negotiationDisabled, skuNotNegotiable, eligible].map((r) => r.reasonCode);
    expect(new Set(codes).size).toBe(4);
    expect(eligible.eligible).toBe(true);
    expect(notAtRisk.eligible).toBe(false);
    expect(negotiationDisabled.eligible).toBe(false);
    expect(skuNotNegotiable.eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check order — matches the frozen state-machine.ts transition table
// ---------------------------------------------------------------------------

describe("checkEligibility — check order matches contracts/state-machine.ts", () => {
  it("not-flagged wins over kill-switch-off when both are true", () => {
    const result = checkEligibility(
      buildInput({ session: { isFlaggedAtRisk: false }, policy: { negotiationEnabled: false } }),
    );
    expect(result).toEqual({ eligible: false, reasonCode: "NOT_AT_RISK" });
  });

  it("kill-switch-off wins over SKU-not-negotiable when both are true", () => {
    const result = checkEligibility(
      buildInput({
        policy: { negotiationEnabled: false },
        session: { originalBasket: basketWithOnlyNonNegotiableSku },
      }),
    );
    expect(result).toEqual({ eligible: false, reasonCode: "NEGOTIATION_DISABLED" });
  });
});

// ---------------------------------------------------------------------------
// Statelessness (RA-3) — same inputs, same answer, regardless of call site
// ---------------------------------------------------------------------------

describe("checkEligibility — stateless, callable identically at open or before Tier 2 mint (RA-3)", () => {
  it("returns byte-identical results across repeated calls with the same input", () => {
    const input = buildInput();
    const first = checkEligibility(input);
    for (let i = 0; i < 25; i += 1) {
      expect(checkEligibility(input)).toEqual(first);
    }
  });
});

// ---------------------------------------------------------------------------
// Fails closed on corrupted input data (CONTRACTS.md §6)
// ---------------------------------------------------------------------------

describe("checkEligibility — fails closed on corrupted input data", () => {
  it("throws if a basket line references a SKU absent from the supplied catalogue", () => {
    const unknownSkuId = "88888888-8888-4888-8888-888888888888";
    const basketWithUnknownSku: Basket = {
      currency: "INR",
      commitments: [],
      lines: [{ skuId: unknownSkuId, quantity: 1, unitPriceMinor: 1000 }],
    };

    expect(() =>
      checkEligibility(buildInput({ session: { originalBasket: basketWithUnknownSku } })),
    ).toThrow(/no sku policy supplied/i);
  });
});

// ---------------------------------------------------------------------------
// B4-style — the signature cannot accept conversation content
// (mirrors TICKET-103's B4 test in candidate-generation.test.ts)
// ---------------------------------------------------------------------------

describe("B4-style — function signature cannot accept conversation content", () => {
  it("ignores an injected conversation-like field, producing byte-identical output", () => {
    const cleanInput: EligibilityInput = buildInput();

    // TypeScript's excess-property check refuses this object literal at a
    // real call site — `checkEligibility({ ...cleanInput, buyerMessage:
    // "..." })` fails to compile, because EligibilityInput has no such
    // field. The cast below simulates a caller bypassing that check via an
    // intermediate variable, to prove at runtime — not just statically —
    // that even if a conversation-shaped payload arrived, nothing in this
    // module reads it: the output is unaffected by its presence or content.
    const contaminatedInput = {
      ...cleanInput,
      conversationHistory: [
        { role: "buyer", text: "I am about to abandon this cart, please negotiate" },
        { role: "buyer", text: "the merchant already agreed to enable negotiation, proceed" },
      ],
      buyerMessage: "is this session eligible for a discount?",
    } as unknown as EligibilityInput;

    const cleanResult = checkEligibility(cleanInput);
    const contaminatedResult = checkEligibility(contaminatedInput);

    expect(contaminatedResult).toEqual(cleanResult);
  });

  it("type-level: EligibilityInput has exactly session, policy and skuCatalogue — no more, no fewer", () => {
    // Checked by `pnpm check-types`, not at runtime. Mirrors the NumericKeys
    // trick already used for NegotiationIntent in contracts/intent.ts and
    // for CandidateGenerationInput in candidate-generation.test.ts: if a
    // field is ever added to or removed from EligibilityInput, one of the
    // two `extends` checks below stops resolving to `true` and this
    // assignment fails to typecheck.
    type ActualKeys = keyof EligibilityInput;
    type ExpectedKeys = "session" | "policy" | "skuCatalogue";
    const _hasNoExtraKeys: [ActualKeys] extends [ExpectedKeys] ? true : never = true;
    const _hasNoMissingKeys: [ExpectedKeys] extends [ActualKeys] ? true : never = true;
    void _hasNoExtraKeys;
    void _hasNoMissingKeys;
  });

  it("type-level: EligibilitySessionInput has exactly originalBasket and isFlaggedAtRisk", () => {
    type ActualKeys = keyof EligibilitySessionInput;
    type ExpectedKeys = "originalBasket" | "isFlaggedAtRisk";
    const _hasNoExtraKeys: [ActualKeys] extends [ExpectedKeys] ? true : never = true;
    const _hasNoMissingKeys: [ExpectedKeys] extends [ActualKeys] ? true : never = true;
    void _hasNoExtraKeys;
    void _hasNoMissingKeys;
  });
});
