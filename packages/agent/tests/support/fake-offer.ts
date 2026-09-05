import type { Offer } from "@repo/policy";

/**
 * Builds a minimal, valid `Offer` fixture for tests in this package.
 *
 * This package never mints offers itself (that is `packages/policy`'s job —
 * TICKET-110); it only ever receives an already-minted one. Mirrors
 * `fake-candidate.ts`'s role: something shaped like a real offer to compose
 * messages from, without pulling in the real minting/signing path.
 */
export function fakeOffer(overrides: Partial<Offer> & { offerId: string }): Offer {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    candidateId: "cand_default",
    roundIndex: 1,
    basket: {
      lines: [
        {
          skuId: "22222222-2222-4222-8222-222222222222",
          quantity: 1,
          unitPriceMinor: 180000,
        },
      ],
      commitments: [],
      currency: "INR",
    },
    totalMinor: 180000,
    currency: "INR",
    tier: 1,
    campaignSpendMinor: 0,
    policyVersion: 1,
    status: "PENDING",
    reasonCode: "TIER1_OFFERED",
    expiresAt: new Date("2026-01-01T00:10:00.000Z"),
    consumedAt: null,
    engineSignature: "test-signature",
    ...overrides,
  };
}
