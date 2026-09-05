import { describe, expect, it } from "vitest";

import type { Basket, Offer } from "../contracts";
import { evaluateOfferAcceptance } from "../acceptance";

/**
 * TICKET-111 — offer TTL, single-use, and basket binding (PRD §10.2).
 *
 * "Three refusals that make an offer unreplayable, unreassignable, and
 * perishable" — `OFFER_EXPIRED`, `OFFER_ALREADY_CONSUMED`, `BASKET_MISMATCH`.
 * Pure-function tests only; the transactional single-use guarantee itself is
 * `packages/database/tests/offer-acceptance.test.ts`'s job (needs a real
 * Postgres for the concurrency assertion).
 */

const SERUM_SKU_ID = "11111111-1111-4111-8111-111111111111";
const BUNDLE_SKU_ID = "22222222-2222-4222-8222-222222222222";
const MINT_TIME = new Date("2026-01-01T00:00:00.000Z");
const OFFER_TTL_SECONDS = 600; // PRD §10
const EXPIRES_AT = new Date(MINT_TIME.getTime() + OFFER_TTL_SECONDS * 1000);

function basket(overrides?: Partial<Basket>): Basket {
  return {
    currency: "INR",
    commitments: [],
    lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
    ...overrides,
  };
}

function mintedOffer(overrides?: Partial<Pick<Offer, "expiresAt" | "consumedAt" | "basket">>): Pick<
  Offer,
  "expiresAt" | "consumedAt" | "basket"
> {
  return {
    expiresAt: EXPIRES_AT,
    consumedAt: null,
    basket: basket(),
    ...overrides,
  };
}

describe("evaluateOfferAcceptance", () => {
  it("accepts a valid, unexpired, unconsumed offer whose basket matches exactly", () => {
    const result = evaluateOfferAcceptance({
      offer: mintedOffer(),
      acceptedBasket: basket(),
      now: new Date(EXPIRES_AT.getTime() - 1),
    });
    expect(result).toEqual({ accepted: true });
  });

  describe("OFFER_EXPIRED — past 600s", () => {
    // Matches the frozen state-machine's own TTL_ELAPSED guard
    // (contracts/state-machine.ts: "now > expiresAt") — expired only
    // strictly after the instant, never at it. This function's CAS
    // counterpart (packages/database/repositories/offers.ts's acceptOffer)
    // uses the same inclusive-at-the-boundary rule so the two can never
    // disagree about whether the exact expiry instant itself is still valid.
    it("accepts at exactly the expiry instant — the boundary is inclusive", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket(),
        now: EXPIRES_AT,
      });
      expect(result).toEqual({ accepted: true });
    });

    it("refuses one millisecond past the expiry instant", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket(),
        now: new Date(EXPIRES_AT.getTime() + 1),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    });

    it("refuses well past expiry", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket(),
        now: new Date(EXPIRES_AT.getTime() + 60_000),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    });

    it("accepts one millisecond before expiry", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket(),
        now: new Date(EXPIRES_AT.getTime() - 1),
      });
      expect(result).toEqual({ accepted: true });
    });

    it("expiry takes precedence over both an already-consumed offer and a basket mismatch", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer({ consumedAt: new Date(MINT_TIME.getTime() + 1000) }),
        acceptedBasket: basket({
          lines: [{ skuId: BUNDLE_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
        }),
        now: new Date(EXPIRES_AT.getTime() + 1),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_EXPIRED" });
    });
  });

  describe("OFFER_ALREADY_CONSUMED — replay of a consumed offer", () => {
    it("refuses when consumedAt is already set", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer({ consumedAt: new Date(MINT_TIME.getTime() + 1000) }),
        acceptedBasket: basket(),
        now: new Date(MINT_TIME.getTime() + 2000),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
    });

    it("takes precedence over a basket mismatch", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer({ consumedAt: new Date(MINT_TIME.getTime() + 1000) }),
        acceptedBasket: basket({
          lines: [{ skuId: BUNDLE_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
        }),
        now: new Date(MINT_TIME.getTime() + 2000),
      });
      expect(result).toEqual({ accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" });
    });
  });

  describe("BASKET_MISMATCH — any basket difference at all", () => {
    it("refuses on a different SKU", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket({
          lines: [{ skuId: BUNDLE_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
        }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses on a different quantity", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket({
          lines: [{ skuId: SERUM_SKU_ID, quantity: 2, unitPriceMinor: 302_000 }],
        }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses on a different unit price", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket({
          lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 301_999 }],
        }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses on a different commitment set", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer({ basket: basket({ commitments: ["PREPAID"] }) }),
        acceptedBasket: basket({ commitments: [] }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("refuses when an extra line is added", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: basket({
          lines: [
            { skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 302_000 },
            { skuId: BUNDLE_SKU_ID, quantity: 1, unitPriceMinor: 10_000 },
          ],
        }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: false, reasonCode: "BASKET_MISMATCH" });
    });

    it("is order-insensitive for the commitment set (not a basket difference)", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer({
          basket: basket({ commitments: ["PREPAID", "NON_RETURNABLE"] }),
        }),
        acceptedBasket: basket({ commitments: ["NON_RETURNABLE", "PREPAID"] }),
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: true });
    });

    it("accepts an identical basket reconstructed independently", () => {
      const result = evaluateOfferAcceptance({
        offer: mintedOffer(),
        acceptedBasket: {
          currency: "INR",
          commitments: [],
          lines: [{ skuId: SERUM_SKU_ID, quantity: 1, unitPriceMinor: 302_000 }],
        },
        now: MINT_TIME,
      });
      expect(result).toEqual({ accepted: true });
    });
  });
});
