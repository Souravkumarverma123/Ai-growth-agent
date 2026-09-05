import type { SelectOffer } from "@repo/database/models/offer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrder } from "../src/create-order";

/**
 * TICKET-301 — CONTRACTS.md §2, B3.
 *
 * These tests mock both of `createOrder`'s dependencies (the offer lookup
 * and the Razorpay client) so the whole flow is exercised — offerId in,
 * Razorpay request out — with no real database connection and no real
 * network call. That keeps this fast and hermetic while still proving the
 * acceptance criteria behaviourally, not just against the pure helper.
 */

const getOfferById = vi.fn();
const createRazorpayOrder = vi.fn();

vi.mock("../src/offer-repository", () => ({
  getOfferById: (offerId: string) => getOfferById(offerId),
}));

vi.mock("../src/razorpay-client", () => ({
  createRazorpayOrder: (request: unknown) => createRazorpayOrder(request),
}));

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

beforeEach(() => {
  getOfferById.mockReset();
  createRazorpayOrder.mockReset();
  createRazorpayOrder.mockResolvedValue({ id: "order_mock" });
});

describe("createOrder(offerId)", () => {
  it("has exactly one parameter (B3 — CONTRACTS.md §2)", () => {
    expect(createOrder.length).toBe(1);
  });

  it("looks the offer up by the id it was given, and nothing else", async () => {
    getOfferById.mockResolvedValue(makeOffer());

    await createOrder("offer-1");

    expect(getOfferById).toHaveBeenCalledWith("offer-1");
    expect(getOfferById).toHaveBeenCalledTimes(1);
  });

  it("always sends offer.totalMinor as the amount, never a different value", async () => {
    getOfferById.mockResolvedValue(makeOffer({ id: "offer-1", totalMinor: 302000, currency: "INR" }));

    await createOrder("offer-1");

    expect(createRazorpayOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 302000, currency: "INR" }),
    );
  });

  it("amount tracks whatever is on the offer row, never a fixed or caller value", async () => {
    getOfferById.mockResolvedValue(
      makeOffer({ id: "offer-2", totalMinor: 750000, tier: 2, campaignSpendMinor: 12000 }),
    );

    await createOrder("offer-2");

    expect(createRazorpayOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 750000 }));
  });

  it("populates receipt with the offer id", async () => {
    getOfferById.mockResolvedValue(makeOffer({ id: "offer-99" }));

    await createOrder("offer-99");

    expect(createRazorpayOrder).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: "offer-99" }),
    );
  });

  it("populates notes with offer id, tier, and campaign spend", async () => {
    getOfferById.mockResolvedValue(
      makeOffer({ id: "offer-42", tier: 2, campaignSpendMinor: 5000 }),
    );

    await createOrder("offer-42");

    expect(createRazorpayOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: {
          offerId: "offer-42",
          tier: 2,
          campaignSpendMinor: 5000,
        },
      }),
    );
  });

  it("throws when no offer exists for the given id, never silently defaults", async () => {
    getOfferById.mockRejectedValue(new Error('createOrder: no offer found for offerId "missing"'));

    await expect(createOrder("missing")).rejects.toThrow(/no offer found/);
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });
});
