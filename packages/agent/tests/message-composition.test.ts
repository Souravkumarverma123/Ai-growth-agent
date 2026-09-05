import { describe, expect, it } from "vitest";
import { MESSAGE_FRAMES, type MessageFrame, type Offer } from "@repo/policy";
import {
  SCARCITY_URGENCY_PATTERN,
  answerBuyerQuestion,
  assertNoScarcityOrUrgencyLanguage,
  composeOfferMessage,
  describeOfferExpiry,
  describeSlowMovingStatus,
} from "../message";
import { fakeOffer } from "./support/fake-offer";
import { createSeededRandom, randomOffer } from "./support/random-offer";

/**
 * TICKET-203 — constrained message composition (PRD §7.2; CONTRACTS.md §8).
 *
 * Two required, behavioural tests:
 *  - "No outbound message contains a numeral absent from the offer object" —
 *    property-style: generate offers, generate messages, extract numerals,
 *    assert subset.
 *  - "Scarcity phrases cannot be produced by the generator regardless of
 *    input" — fuzz every frame against many random offers.
 *
 * Plus the truthful, on-demand answers (expiry, slow-moving) the acceptance
 * criteria require, and a check that neither is ever volunteered by the
 * primary composed message.
 */

/** Every contiguous digit run in `text` — the numerals it contains. */
function extractNumerals(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/** Every numeral that appears anywhere on the offer row itself (including
 *  nested basket lines and the expiry/consumed timestamps, which
 *  `JSON.stringify` serializes via `Date#toJSON` to the same ISO string
 *  `describeOfferExpiry` reads from `toISOString()`). */
function offerNumerals(offer: Offer): Set<string> {
  return new Set(extractNumerals(JSON.stringify(offer)));
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const baseOffer = fakeOffer({
  offerId: "33333333-3333-4333-8333-333333333333",
  sessionId: SESSION_ID,
  basket: {
    lines: [
      { skuId: "22222222-2222-4222-8222-222222222222", quantity: 3, unitPriceMinor: 50000 },
      { skuId: "44444444-4444-4444-8444-444444444444", quantity: 1, unitPriceMinor: 30000 },
    ],
    commitments: ["PREPAID"],
    currency: "INR",
  },
  totalMinor: 180000,
  tier: 1,
  campaignSpendMinor: 0,
  expiresAt: new Date("2026-01-01T00:10:00.000Z"),
});

// ---------------------------------------------------------------------------
// Every number in an outbound message comes from the offer row
// ---------------------------------------------------------------------------

describe("composeOfferMessage — every numeral traces back to the offer row", () => {
  it("a single fixed offer: every numeral in every frame's message is present on the offer", () => {
    for (const messageFrame of MESSAGE_FRAMES) {
      const message = composeOfferMessage({ offer: baseOffer, messageFrame });
      const allowed = offerNumerals(baseOffer);
      for (const numeral of extractNumerals(message)) {
        expect(allowed.has(numeral), `numeral "${numeral}" in "${message}" is not on the offer row`).toBe(true);
      }
    }
  });

  it("property test: 200 random offers x every frame, no invented numeral ever appears", () => {
    const rng = createSeededRandom(20250203);

    for (let i = 0; i < 200; i += 1) {
      const offer = randomOffer(rng);
      const allowed = offerNumerals(offer);

      for (const messageFrame of MESSAGE_FRAMES) {
        const message = composeOfferMessage({ offer, messageFrame });
        for (const numeral of extractNumerals(message)) {
          expect(
            allowed.has(numeral),
            `numeral "${numeral}" in "${message}" (frame ${messageFrame}) is not on offer ${offer.offerId}`,
          ).toBe(true);
        }
      }
    }
  });

  it("the message actually contains a number (the property above isn't vacuously true)", () => {
    const message = composeOfferMessage({ offer: baseOffer, messageFrame: "BUNDLE_VALUE" });
    expect(extractNumerals(message).length).toBeGreaterThan(0);
    expect(message).toContain("180000");
  });

  it("never mentions campaignSpendMinor — CONTRACTS.md §9 bars internal budget/economics figures from the buyer surface", () => {
    const tier2Offer = fakeOffer({
      offerId: "55555555-5555-4555-8555-555555555555",
      tier: 2,
      campaignSpendMinor: 999999,
      reasonCode: "DILUTION_WITHIN_CAPS",
    });
    for (const messageFrame of MESSAGE_FRAMES) {
      const message = composeOfferMessage({ offer: tier2Offer, messageFrame });
      expect(message).not.toContain("999999");
    }
  });
});

// ---------------------------------------------------------------------------
// The agent cannot emit manufactured urgency or scarcity
// ---------------------------------------------------------------------------

describe("composeOfferMessage — scarcity/urgency phrases cannot be produced, regardless of input", () => {
  it("no frame, against a fixed offer, ever matches the forbidden pattern", () => {
    for (const messageFrame of MESSAGE_FRAMES) {
      const message = composeOfferMessage({ offer: baseOffer, messageFrame });
      expect(SCARCITY_URGENCY_PATTERN.test(message)).toBe(false);
    }
  });

  it("property test: 200 random offers x every frame, never once matches the forbidden pattern", () => {
    const rng = createSeededRandom(918273645);

    for (let i = 0; i < 200; i += 1) {
      const offer = randomOffer(rng);
      for (const messageFrame of MESSAGE_FRAMES) {
        const message = composeOfferMessage({ offer, messageFrame });
        expect(SCARCITY_URGENCY_PATTERN.test(message)).toBe(false);
      }
    }
  });

  it("the guard itself actually catches known scarcity/urgency phrasing (proves the pattern isn't vacuous)", () => {
    const forbidden = [
      "Only 2 left in stock!",
      "Hurry, this won't last!",
      "Price is going up soon.",
      "While stocks last.",
      "Act now before it's too late.",
      "Limited time offer.",
    ];
    for (const phrase of forbidden) {
      expect(() => assertNoScarcityOrUrgencyLanguage(phrase)).toThrow(/scarcity\/urgency/);
    }
  });

  it("ordinary composed copy passes the guard without throwing", () => {
    expect(() => assertNoScarcityOrUrgencyLanguage("Here's what we can offer: 3 units at 50000 minor units each. That's 180000 INR in total.")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Slow-moving status: not volunteered unprompted, truthful if asked
// ---------------------------------------------------------------------------

describe("slow-moving status is never volunteered by composeOfferMessage, but answered truthfully on request", () => {
  it("composeOfferMessage's input has no field to carry clearsSlowMoving, for any frame", () => {
    // Structural proof, not merely an empirical one: ComposeOfferMessageInput
    // is `{ offer: Offer; messageFrame: MessageFrame }` and `Offer` itself
    // carries no `clearsSlowMoving` field (only `Candidate` does) — there is
    // no slot this value could occupy even by accident.
    for (const messageFrame of MESSAGE_FRAMES) {
      const message = composeOfferMessage({ offer: baseOffer, messageFrame });
      expect(message.toLowerCase()).not.toMatch(/slow[\s-]?moving/);
    }
  });

  it("answerBuyerQuestion truthfully confirms when asked directly, and the basket does contain a slow-moving item", () => {
    const answer = answerBuyerQuestion({
      topic: "SLOW_MOVING_STATUS",
      offer: baseOffer,
      now: NOW,
      basketContainsSlowMovingItem: true,
    });
    expect(answer).toMatch(/slow-moving/i);
    expect(answer.toLowerCase()).toContain("yes");
  });

  it("answerBuyerQuestion truthfully denies when asked directly, and the basket contains none", () => {
    const answer = answerBuyerQuestion({
      topic: "SLOW_MOVING_STATUS",
      offer: baseOffer,
      now: NOW,
      basketContainsSlowMovingItem: false,
    });
    expect(answer.toLowerCase()).toContain("no");
  });

  it("describeSlowMovingStatus never matches the scarcity/urgency pattern either", () => {
    expect(SCARCITY_URGENCY_PATTERN.test(describeSlowMovingStatus(true))).toBe(false);
    expect(SCARCITY_URGENCY_PATTERN.test(describeSlowMovingStatus(false))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expiry: not volunteered unprompted, truthful and numerically grounded if asked
// ---------------------------------------------------------------------------

describe("expiry is never volunteered by composeOfferMessage, but answered truthfully and grounded in the offer if asked", () => {
  it("composeOfferMessage never mentions the offer's expiry timestamp", () => {
    for (const messageFrame of MESSAGE_FRAMES) {
      const message = composeOfferMessage({ offer: baseOffer, messageFrame });
      expect(message).not.toContain(baseOffer.expiresAt.toISOString());
      expect(message.toLowerCase()).not.toMatch(/expir/);
    }
  });

  it("describeOfferExpiry states the offer is still valid, using its exact expiresAt", () => {
    const beforeExpiry = new Date(baseOffer.expiresAt.getTime() - 1000);
    const answer = describeOfferExpiry(baseOffer, beforeExpiry);
    expect(answer).toContain(baseOffer.expiresAt.toISOString());
    expect(answer.toLowerCase()).toContain("valid");
  });

  it("describeOfferExpiry truthfully reports expiry once past expiresAt, using its exact expiresAt", () => {
    const afterExpiry = new Date(baseOffer.expiresAt.getTime() + 1000);
    const answer = describeOfferExpiry(baseOffer, afterExpiry);
    expect(answer).toContain(baseOffer.expiresAt.toISOString());
    expect(answer.toLowerCase()).toContain("expired");
  });

  it("at the exact expiry instant, reports the offer as still valid — matching the state machine's strict TTL_ELAPSED guard (now > expiresAt, never >=)", () => {
    const exactlyAtExpiry = new Date(baseOffer.expiresAt.getTime());
    const answer = describeOfferExpiry(baseOffer, exactlyAtExpiry);
    expect(answer.toLowerCase()).toContain("valid");
    expect(answer.toLowerCase()).not.toContain("expired");
  });

  it("answerBuyerQuestion('EXPIRY') delegates to describeOfferExpiry and stays numerically grounded", () => {
    const answer = answerBuyerQuestion({ topic: "EXPIRY", offer: baseOffer, now: NOW });
    expect(answer).toContain(baseOffer.expiresAt.toISOString());
    // Every numeral in the answer must trace back to the offer row, same as
    // the primary composed message's own property.
    const allowed = offerNumerals(baseOffer);
    for (const numeral of extractNumerals(answer)) {
      expect(allowed.has(numeral)).toBe(true);
    }
  });

  it("never matches the scarcity/urgency pattern either", () => {
    expect(SCARCITY_URGENCY_PATTERN.test(describeOfferExpiry(baseOffer, NOW))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// answerBuyerQuestion — closed topic set
// ---------------------------------------------------------------------------

describe("answerBuyerQuestion — a closed set of truthful, on-demand answers", () => {
  it("throws asking about SLOW_MOVING_STATUS without supplying the real basket flag", () => {
    expect(() =>
      answerBuyerQuestion({ topic: "SLOW_MOVING_STATUS", offer: baseOffer, now: NOW }),
    ).toThrow(/basketContainsSlowMovingItem is required/);
  });

  it("every MessageFrame produces some composable message (no frame is unhandled)", () => {
    const frames: readonly MessageFrame[] = MESSAGE_FRAMES;
    expect(frames).toHaveLength(5);
    for (const messageFrame of frames) {
      expect(() => composeOfferMessage({ offer: baseOffer, messageFrame })).not.toThrow();
    }
  });
});
