import { describe, expect, it } from "vitest";

import type { Basket, Candidate } from "../contracts";
import { mintOffer, type CampaignBudgetReservationOutcome, type MintOfferInput } from "../minting";
import { signOfferPayload, verifyOfferSignature, type SignableOfferFields } from "../minting/signing";
import * as policyBarrel from "../index";

/**
 * TICKET-110 — offer minting and signature.
 *
 * Fixture money figures reproduce PRD §18.2's worked example verbatim (also
 * reproduced in packages/database/tests/seed.test.ts and
 * packages/policy/tests/tiering.test.ts): perDealCapMinor = 20_000 (₹200).
 *
 *   Round 1 (Tier 1, neutral):  total ₹3,020, contributionDelta      0
 *   Round 2 (Tier 2, at cap):   total ₹2,300, contributionDelta -20_000  (shortfall ₹200, feasible)
 *   Round 3 (Tier 2, over cap): total ₹2,200, contributionDelta -30_000  (shortfall ₹300, infeasible)
 *
 * `Candidate` fixtures are built directly, already tiered — this module only
 * cares about candidate lookup, the tier1Refused lock, feasibility, and the
 * campaign-budget-reservation outcome, so everything else on the fixture is
 * filler that must simply survive the mint untouched.
 */

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";
const ROUND_INDEX = 1;
const POLICY_VERSION = 3;
const OFFER_TTL_SECONDS = 600; // PRD §10: "Mint time + 600 s"
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SECRET = "test-signing-secret";

function basket(unitPriceMinor: number): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor }],
  };
}

function buildCandidate(overrides: Partial<Candidate> & Pick<Candidate, "candidateId">): Candidate {
  return {
    sessionId: SESSION_ID,
    roundIndex: ROUND_INDEX,
    moveType: "PRICE_CONCESSION",
    basket: basket(302000),
    totalMinor: 302000,
    contributionMinor: 95000,
    contributionDeltaMinor: 0,
    tier: 1,
    requiredCampaignSpendMinor: 0,
    clearsSlowMoving: false,
    feasible: true,
    infeasibleReason: null,
    ...overrides,
  };
}

// Round 1 — Tier 1, neutral (worked example).
const tier1Neutral = buildCandidate({
  candidateId: "cand-round-1",
  basket: basket(302_000),
  totalMinor: 302_000,
  contributionMinor: 95_000,
  contributionDeltaMinor: 0,
  tier: 1,
  requiredCampaignSpendMinor: 0,
  feasible: true,
  infeasibleReason: null,
});

// Round 2 — Tier 2, exactly at the ₹200 per-deal cap (worked example).
const tier2AtCap = buildCandidate({
  candidateId: "cand-round-2",
  basket: basket(230_000),
  totalMinor: 230_000,
  contributionMinor: 75_000,
  contributionDeltaMinor: -20_000,
  tier: 2,
  requiredCampaignSpendMinor: 20_000,
  feasible: true,
  infeasibleReason: null,
});

// Round 3 — Tier 2, over the ₹200 per-deal cap (worked example: walk away).
const tier2OverCap = buildCandidate({
  candidateId: "cand-round-3",
  basket: basket(220_000),
  totalMinor: 220_000,
  contributionMinor: 65_000,
  contributionDeltaMinor: -30_000,
  tier: 2,
  requiredCampaignSpendMinor: 30_000,
  feasible: false,
  infeasibleReason: "DILUTION_EXCEEDS_PER_DEAL_CAP",
});

const CANDIDATES_IN_ROUND: readonly Candidate[] = [tier1Neutral, tier2AtCap, tier2OverCap];

const RESERVED_OFFER_ID = "33333333-3333-4333-8333-333333333333";
const RESERVED: CampaignBudgetReservationOutcome = {
  reserved: true,
  offerId: RESERVED_OFFER_ID,
  amountMinor: tier2AtCap.requiredCampaignSpendMinor,
};
const EXHAUSTED: CampaignBudgetReservationOutcome = {
  reserved: false,
  reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED",
};

function buildInput(overrides: Partial<MintOfferInput> = {}): MintOfferInput {
  return {
    sessionId: SESSION_ID,
    roundIndex: ROUND_INDEX,
    policyVersion: POLICY_VERSION,
    tier1Refused: true,
    candidatesInRound: CANDIDATES_IN_ROUND,
    candidateId: tier1Neutral.candidateId,
    now: NOW,
    offerTtlSeconds: OFFER_TTL_SECONDS,
    signingSecret: SECRET,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mint accepts no amount, no tier, no campaign spend from its caller
// ---------------------------------------------------------------------------

describe("mintOffer — accepts no amount, tier, or campaign spend from its caller", () => {
  it("MintOfferInput's own object literal carries none of those keys", () => {
    const input = buildInput();
    expect("totalMinor" in input).toBe(false);
    expect("tier" in input).toBe(false);
    expect("campaignSpendMinor" in input).toBe(false);
    expect("amount" in input).toBe(false);
  });

  it("the minted Tier 1 offer's totalMinor/tier/campaignSpendMinor come from the candidate, matching the worked example exactly", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.totalMinor).toBe(302_000); // ₹3,020 (PRD §18.2)
    expect(result.offer.tier).toBe(1);
    expect(result.offer.campaignSpendMinor).toBe(0);
    expect(result.offer.reasonCode).toBe("TIER1_OFFERED");
  });

  it("the minted Tier 2 offer's totalMinor/tier/campaignSpendMinor come from the candidate, matching the worked example exactly", () => {
    const result = mintOffer(
      buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: RESERVED }),
    );
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.totalMinor).toBe(230_000); // ₹2,300 (PRD §18.2)
    expect(result.offer.tier).toBe(2);
    expect(result.offer.campaignSpendMinor).toBe(20_000); // ₹200 shortfall, exactly at cap
    expect(result.offer.reasonCode).toBe("DILUTION_WITHIN_CAPS");
  });
});

// ---------------------------------------------------------------------------
// A candidate id not in this round's set is rejected
// ---------------------------------------------------------------------------

describe("mintOffer — a candidate id not in this round's set is rejected", () => {
  it("throws for a forged candidate id that never appeared in candidatesInRound", () => {
    expect(() => mintOffer(buildInput({ candidateId: "forged-candidate-id" }))).toThrow(
      /not in this round's engine-authored candidate set/i,
    );
  });

  it("throws for an out-of-set id even when it looks superficially plausible", () => {
    expect(() => mintOffer(buildInput({ candidateId: "cand-round-99" }))).toThrow(/forged or out-of-set/i);
  });

  it("throws when a candidate in candidatesInRound belongs to a different session (defense in depth)", () => {
    const wrongSessionCandidate = buildCandidate({
      candidateId: "cand-wrong-session",
      sessionId: "99999999-9999-4999-8999-999999999999",
    });
    expect(() =>
      mintOffer(
        buildInput({
          candidatesInRound: [wrongSessionCandidate],
          candidateId: "cand-wrong-session",
        }),
      ),
    ).toThrow(/not the requested sessionId/i);
  });

  it("throws when a candidate in candidatesInRound belongs to a different round (defense in depth)", () => {
    const wrongRoundCandidate = buildCandidate({ candidateId: "cand-wrong-round", roundIndex: 7 });
    expect(() =>
      mintOffer(
        buildInput({
          candidatesInRound: [wrongRoundCandidate],
          candidateId: "cand-wrong-round",
        }),
      ),
    ).toThrow(/not the requested sessionId.*roundIndex/i);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 mint without tier1_refused is rejected
// ---------------------------------------------------------------------------

describe("mintOffer — Tier 2 mint without tier1Refused is rejected", () => {
  it("throws when the resolved candidate is Tier 2 and tier1Refused is false", () => {
    expect(() =>
      mintOffer(
        buildInput({
          tier1Refused: false,
          candidateId: tier2AtCap.candidateId,
          campaignBudgetReservation: RESERVED,
        }),
      ),
    ).toThrow(/Tier 2 but tier1Refused is false/i);
  });

  it("mints the same Tier 2 candidate once tier1Refused is true", () => {
    const result = mintOffer(
      buildInput({
        tier1Refused: true,
        candidateId: tier2AtCap.candidateId,
        campaignBudgetReservation: RESERVED,
      }),
    );
    expect(result.minted).toBe(true);
  });

  it("never throws the tier1Refused error for a Tier 1 candidate regardless of the flag", () => {
    const result = mintOffer(buildInput({ tier1Refused: false, candidateId: tier1Neutral.candidateId }));
    expect(result.minted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Infeasible candidates are rejected with their own coded reason
// ---------------------------------------------------------------------------

describe("mintOffer — an infeasible candidate is rejected with its own reason code", () => {
  it("rejects the over-cap Tier 2 candidate with DILUTION_EXCEEDS_PER_DEAL_CAP, matching the worked example's round 3 walk-away", () => {
    const result = mintOffer(
      buildInput({
        candidateId: tier2OverCap.candidateId,
        campaignBudgetReservation: RESERVED,
      }),
    );
    expect(result).toEqual({ minted: false, reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP" });
  });
});

// ---------------------------------------------------------------------------
// Tier 2 reserves budget: the reservation OUTCOME is a required input, not
// something this pure function performs itself
// ---------------------------------------------------------------------------

describe("mintOffer — Tier 2 requires a campaign-budget reservation outcome", () => {
  it("throws when no campaignBudgetReservation is supplied for a Tier 2 candidate at all", () => {
    expect(() =>
      mintOffer(buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: undefined })),
    ).toThrow(/no campaignBudgetReservation outcome was supplied/i);
  });

  it("rejects with CAMPAIGN_BUDGET_EXHAUSTED when the supplied reservation outcome failed", () => {
    const result = mintOffer(
      buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: EXHAUSTED }),
    );
    expect(result).toEqual({ minted: false, reasonCode: "CAMPAIGN_BUDGET_EXHAUSTED" });
  });

  it("mints when the supplied reservation outcome succeeded", () => {
    const result = mintOffer(
      buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: RESERVED }),
    );
    expect(result.minted).toBe(true);
  });

  it("binds the minted offer's id to the reservation's offerId, not a freshly generated one", () => {
    const result = mintOffer(
      buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: RESERVED }),
    );
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.offerId).toBe(RESERVED_OFFER_ID);
  });

  it("throws when the reservation's amountMinor doesn't match the candidate's requiredCampaignSpendMinor", () => {
    const mismatched: CampaignBudgetReservationOutcome = {
      reserved: true,
      offerId: RESERVED_OFFER_ID,
      amountMinor: tier2AtCap.requiredCampaignSpendMinor + 1,
    };
    expect(() =>
      mintOffer(
        buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: mismatched }),
      ),
    ).toThrow(/doesn't match its hold/i);
  });

  it("ignores campaignBudgetReservation entirely for a Tier 1 candidate", () => {
    const result = mintOffer(
      buildInput({ candidateId: tier1Neutral.candidateId, campaignBudgetReservation: EXHAUSTED }),
    );
    expect(result.minted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TTL, policy version, status, single-use fields
// ---------------------------------------------------------------------------

describe("mintOffer — writes TTL and policy_version, single-use fields start unset", () => {
  it("sets expiresAt to exactly mint time + offerTtlSeconds (PRD §10: 600 s)", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.expiresAt.getTime()).toBe(NOW.getTime() + OFFER_TTL_SECONDS * 1000);
  });

  it("pins policyVersion from the caller-supplied session-level value", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId, policyVersion: 42 }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.policyVersion).toBe(42);
  });

  it("mints with status PENDING and consumedAt null", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.status).toBe("PENDING");
    expect(result.offer.consumedAt).toBeNull();
  });

  it("carries the candidateId and roundIndex through from the resolved candidate", () => {
    const result = mintOffer(buildInput({ candidateId: tier2AtCap.candidateId, campaignBudgetReservation: RESERVED }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.candidateId).toBe(tier2AtCap.candidateId);
    expect(result.offer.roundIndex).toBe(tier2AtCap.roundIndex);
  });
});

// ---------------------------------------------------------------------------
// Signing: engine-only, deterministic, tamper-evident
// ---------------------------------------------------------------------------

describe("mintOffer — signs the offer; the signature verifies and is tamper-evident", () => {
  it("produces a non-empty hex engineSignature", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    expect(result.offer.engineSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the minted signature verifies against the offer's own signable fields and secret", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    const fields: SignableOfferFields = {
      offerId: result.offer.offerId,
      sessionId: result.offer.sessionId,
      candidateId: result.offer.candidateId,
      totalMinor: result.offer.totalMinor,
      currency: result.offer.currency,
      tier: result.offer.tier,
      campaignSpendMinor: result.offer.campaignSpendMinor,
      policyVersion: result.offer.policyVersion,
      expiresAt: result.offer.expiresAt,
    };
    expect(verifyOfferSignature(fields, result.offer.engineSignature, SECRET)).toBe(true);
  });

  it("verification fails if totalMinor is tampered with after minting", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    const tampered: SignableOfferFields = {
      offerId: result.offer.offerId,
      sessionId: result.offer.sessionId,
      candidateId: result.offer.candidateId,
      totalMinor: result.offer.totalMinor + 1,
      currency: result.offer.currency,
      tier: result.offer.tier,
      campaignSpendMinor: result.offer.campaignSpendMinor,
      policyVersion: result.offer.policyVersion,
      expiresAt: result.offer.expiresAt,
    };
    expect(verifyOfferSignature(tampered, result.offer.engineSignature, SECRET)).toBe(false);
  });

  it("verification fails against the wrong secret", () => {
    const result = mintOffer(buildInput({ candidateId: tier1Neutral.candidateId }));
    if (!result.minted) throw new Error("expected a mint");
    const fields: SignableOfferFields = {
      offerId: result.offer.offerId,
      sessionId: result.offer.sessionId,
      candidateId: result.offer.candidateId,
      totalMinor: result.offer.totalMinor,
      currency: result.offer.currency,
      tier: result.offer.tier,
      campaignSpendMinor: result.offer.campaignSpendMinor,
      policyVersion: result.offer.policyVersion,
      expiresAt: result.offer.expiresAt,
    };
    expect(verifyOfferSignature(fields, result.offer.engineSignature, "wrong-secret")).toBe(false);
  });

  it("signOfferPayload is deterministic: identical fields and secret produce identical signatures", () => {
    const fields: SignableOfferFields = {
      offerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: SESSION_ID,
      candidateId: "cand-x",
      totalMinor: 100_000,
      currency: "INR",
      tier: 1,
      campaignSpendMinor: 0,
      policyVersion: 1,
      expiresAt: NOW,
    };
    expect(signOfferPayload(fields, SECRET)).toBe(signOfferPayload(fields, SECRET));
  });

  it("throws rather than silently signing an unsafe-integer totalMinor", () => {
    const fields: SignableOfferFields = {
      offerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: SESSION_ID,
      candidateId: "cand-x",
      totalMinor: Number.MAX_SAFE_INTEGER + 2,
      currency: "INR",
      tier: 1,
      campaignSpendMinor: 0,
      policyVersion: 1,
      expiresAt: NOW,
    };
    expect(() => signOfferPayload(fields, SECRET)).toThrow(/safe integer/i);
  });
});

// ---------------------------------------------------------------------------
// The signing function is not reachable from packages/agent
// ---------------------------------------------------------------------------

describe("mintOffer — the signing function is not exported from @repo/policy's public barrel", () => {
  it("packages/policy's own index.ts exports mintOffer", () => {
    expect(typeof policyBarrel.mintOffer).toBe("function");
  });

  it("packages/policy's own index.ts does NOT export the raw signing function — the only public barrel packages/agent can import", () => {
    expect("signOfferPayload" in policyBarrel).toBe(false);
    expect("verifyOfferSignature" in policyBarrel).toBe(false);
  });

  it("packages/policy/minting's own barrel (re-exported by index.ts) does NOT export the raw signing function either", async () => {
    const mintingBarrel = await import("../minting");
    expect("signOfferPayload" in mintingBarrel).toBe(false);
    expect("verifyOfferSignature" in mintingBarrel).toBe(false);
    expect(typeof mintingBarrel.mintOffer).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Fails closed on precision loss and malformed timing inputs
// ---------------------------------------------------------------------------

describe("mintOffer — fails closed on precision loss and malformed timing inputs", () => {
  it("throws for an unsafe-integer policyVersion", () => {
    expect(() =>
      mintOffer(
        buildInput({ candidateId: tier1Neutral.candidateId, policyVersion: Number.MAX_SAFE_INTEGER + 2 }),
      ),
    ).toThrow(/safe integer/i);
  });

  it("throws for a non-positive offerTtlSeconds", () => {
    expect(() => mintOffer(buildInput({ candidateId: tier1Neutral.candidateId, offerTtlSeconds: 0 }))).toThrow(
      /positive integer/i,
    );
  });

  it("throws for a non-positive roundIndex", () => {
    expect(() =>
      mintOffer(
        buildInput({
          candidateId: tier1Neutral.candidateId,
          roundIndex: 0,
          candidatesInRound: [buildCandidate({ candidateId: tier1Neutral.candidateId, roundIndex: 0 })],
        }),
      ),
    ).toThrow(/positive integer/i);
  });

  it("throws for an invalid Date passed as now", () => {
    expect(() =>
      mintOffer(buildInput({ candidateId: tier1Neutral.candidateId, now: new Date("not-a-date") })),
    ).toThrow(/valid Date/i);
  });
});
