import type { Candidate } from "@repo/policy";

/**
 * Builds a minimal, valid `Candidate` fixture for tests in this package.
 *
 * This package never generates candidates itself (that is
 * `packages/policy`'s job — TICKET-103/104); it only ever receives an
 * already-generated set as `NegotiationRoundInput.candidates`. This helper
 * exists purely so `NegotiationModel` tests have something shaped like a real
 * candidate to reference by id, without pulling in the real generator.
 */
export function fakeCandidate(overrides: Partial<Candidate> & { candidateId: string }): Candidate {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    roundIndex: 1,
    moveType: "PRICE_CONCESSION",
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
    contributionMinor: 70000,
    contributionDeltaMinor: 0,
    tier: 1,
    requiredCampaignSpendMinor: 0,
    clearsSlowMoving: false,
    feasible: true,
    infeasibleReason: null,
    ...overrides,
  };
}
