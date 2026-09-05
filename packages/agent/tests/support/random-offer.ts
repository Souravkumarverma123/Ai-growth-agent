import { COMMITMENT_TYPES, type CommitmentType, type Offer } from "@repo/policy";
import { createSeededRandom, randomChoice, randomInt, randomUuid, type SeededRandom } from "./seeded-random";

/**
 * Generates a random, schema-shaped `Offer` fixture for the property-style
 * tests in `message-composer.test.ts` (CONTRACTS.md §8: "generate offers,
 * generate messages, extract numerals, assert subset"). Every numeric field
 * gets its own independently random value so the property test cannot pass
 * merely because two fields happen to share a value by fixture coincidence.
 */
export function randomOffer(rng: SeededRandom): Offer {
  const lineCount = randomInt(rng, 1, 4);
  const lines = Array.from({ length: lineCount }, () => ({
    skuId: randomUuid(rng),
    quantity: randomInt(rng, 1, 50),
    unitPriceMinor: randomInt(rng, 1, 10_000_00),
  }));

  const commitmentCount = randomInt(rng, 0, COMMITMENT_TYPES.length);
  const commitments: CommitmentType[] = [];
  const remainingChoices = [...COMMITMENT_TYPES];
  for (let i = 0; i < commitmentCount; i += 1) {
    const index = randomInt(rng, 0, remainingChoices.length - 1);
    commitments.push(remainingChoices[index]!);
    remainingChoices.splice(index, 1);
  }

  const tier = randomChoice(rng, [1, 2] as const);
  const isConsumed = rng() < 0.5;
  const expiresAtMs = Date.UTC(2026, 0, 1) + randomInt(rng, 0, 1_000_000_000);

  return {
    offerId: randomUuid(rng),
    sessionId: randomUuid(rng),
    candidateId: `cand_${randomInt(rng, 0, 999_999)}`,
    roundIndex: randomInt(rng, 1, 20),
    basket: {
      lines,
      commitments,
      currency: "INR",
    },
    totalMinor: randomInt(rng, 1, 100_000_00),
    currency: "INR",
    tier,
    campaignSpendMinor: tier === 2 ? randomInt(rng, 0, 50_000_00) : 0,
    policyVersion: randomInt(rng, 0, 100),
    status: randomChoice(rng, ["PENDING", "ACCEPTED", "EXPIRED", "DECLINED", "CONSUMED"] as const),
    reasonCode: tier === 2 ? "DILUTION_WITHIN_CAPS" : "TIER1_OFFERED",
    expiresAt: new Date(expiresAtMs),
    consumedAt: isConsumed ? new Date(expiresAtMs - randomInt(rng, 0, 1000)) : null,
    engineSignature: randomUuid(rng),
  };
}

export { createSeededRandom };
