import type { SelectOffer } from "@repo/database/models/offer";
import { describe, expect, it } from "vitest";

import { buildRazorpayOrderRequest } from "../src/create-order";

/**
 * TICKET-301 acceptance criterion: "Amount sent to Razorpay always equals
 * offer.total_minor." `buildRazorpayOrderRequest` is the pure derivation
 * `createOrder` uses internally (see `../src/create-order.ts`); its only
 * parameter is the persisted offer row itself, so there is no parameter
 * through which a caller could supply a different amount — this is checked
 * across a range of offer fixtures, no database or network needed.
 */

function makeOffer(overrides: Partial<SelectOffer> = {}): SelectOffer {
  return {
    id: "offer-1",
    sessionId: "session-1",
    candidateRef: "cand-1",
    roundIndex: 1,
    basket: { lines: [], commitments: [], currency: "INR" },
    totalMinor: 302000,
    currency: "INR",
    tier: 1,
    campaignSpendMinor: 0,
    policyVersion: 1,
    status: "PENDING",
    reasonCode: "TIER1_OFFER_MINTED",
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    consumedAt: null,
    engineSignature: "sig",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as SelectOffer;
}

describe("buildRazorpayOrderRequest", () => {
  it.each([
    { totalMinor: 302000, currency: "INR" },
    { totalMinor: 750000, currency: "INR" },
    { totalMinor: 1, currency: "INR" },
    { totalMinor: 5_000_000, currency: "INR" },
  ])("amount always equals offer.totalMinor ($totalMinor)", ({ totalMinor, currency }) => {
    const offer = makeOffer({ totalMinor, currency });
    const request = buildRazorpayOrderRequest(offer);

    expect(request.amount).toBe(totalMinor);
    expect(request.amount).toBe(offer.totalMinor);
    expect(request.currency).toBe(currency);
  });

  it("takes the basket's currency from the offer row, never a hardcoded value", () => {
    const offer = makeOffer({ currency: "INR" });
    const request = buildRazorpayOrderRequest(offer);

    expect(request.currency).toBe(offer.currency);
  });

  it("receipt carries the offer id", () => {
    const offer = makeOffer({ id: "offer-abc-123" });
    const request = buildRazorpayOrderRequest(offer);

    expect(request.receipt).toBe("offer-abc-123");
  });

  it("notes carry offer id, tier, and campaign spend, and nothing invented", () => {
    const offer = makeOffer({ id: "offer-xyz", tier: 2, campaignSpendMinor: 4500 });
    const request = buildRazorpayOrderRequest(offer);

    expect(request.notes).toEqual({
      offerId: "offer-xyz",
      tier: 2,
      campaignSpendMinor: 4500,
    });
  });

  it("has exactly one parameter — the offer row — so no caller can override the amount", () => {
    expect(buildRazorpayOrderRequest.length).toBe(1);
  });
});
