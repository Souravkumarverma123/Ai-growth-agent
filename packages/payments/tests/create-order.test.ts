import type { SelectOffer } from "@repo/database/models/offer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrder, OrderAlreadyExistsError } from "../src/create-order";

/**
 * TICKET-301 — CONTRACTS.md §2, B3.
 * TICKET-302 — offer-to-order uniqueness (reserve-before-POST).
 *
 * These tests mock every one of `createOrder`'s dependencies (the offer
 * lookup, the local-order reservation, and the Razorpay client) so the
 * whole flow is exercised — offerId in, Razorpay request out — with no real
 * database connection and no real network call. That keeps this fast and
 * hermetic while still proving the acceptance criteria behaviourally, not
 * just against the pure helper.
 */

const getOfferById = vi.fn();
const reserveLocalOrder = vi.fn();
const attachRailOrderId = vi.fn();
const createRazorpayOrder = vi.fn();

vi.mock("../src/offer-repository", () => ({
  getOfferById: (offerId: string) => getOfferById(offerId),
}));

vi.mock("../src/order-repository", () => ({
  reserveLocalOrder: (params: unknown) => reserveLocalOrder(params),
  attachRailOrderId: (orderId: string, railOrder: unknown) => attachRailOrderId(orderId, railOrder),
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

function makeReservation(overrides: { order?: Partial<{ id: string }> } = {}) {
  return { reserved: true as const, order: { id: "local-order-1", ...overrides.order } };
}

beforeEach(() => {
  getOfferById.mockReset();
  reserveLocalOrder.mockReset();
  attachRailOrderId.mockReset();
  createRazorpayOrder.mockReset();

  reserveLocalOrder.mockResolvedValue(makeReservation());
  attachRailOrderId.mockResolvedValue(undefined);
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
    expect(reserveLocalOrder).not.toHaveBeenCalled();
  });
});

describe("createOrder(offerId) — TICKET-302 reserve-before-POST", () => {
  it("reserves the local order BEFORE calling Razorpay, never after or in parallel", async () => {
    getOfferById.mockResolvedValue(makeOffer({ id: "offer-1" }));

    const callOrder: string[] = [];
    reserveLocalOrder.mockImplementation(async () => {
      callOrder.push("reserve");
      return makeReservation();
    });
    createRazorpayOrder.mockImplementation(async () => {
      callOrder.push("post");
      return { id: "order_mock" };
    });

    await createOrder("offer-1");

    expect(callOrder).toEqual(["reserve", "post"]);
  });

  it(
    "when reservation fails because an order already exists for this offer, " +
      "createOrder surfaces a clean OrderAlreadyExistsError and never reaches Razorpay",
    async () => {
      getOfferById.mockResolvedValue(makeOffer({ id: "offer-1" }));
      reserveLocalOrder.mockResolvedValue({ reserved: false, reason: "ORDER_ALREADY_EXISTS" });

      await expect(createOrder("offer-1")).rejects.toThrow(OrderAlreadyExistsError);
      await expect(createOrder("offer-1")).rejects.toThrow(/already exists/);

      expect(createRazorpayOrder).not.toHaveBeenCalled();
      expect(attachRailOrderId).not.toHaveBeenCalled();
    },
  );

  it("a second createOrder call for an already-ordered offer never reaches Razorpay even after a first success", async () => {
    getOfferById.mockResolvedValue(makeOffer({ id: "offer-1" }));

    // First call: reservation succeeds, order proceeds normally.
    reserveLocalOrder.mockResolvedValueOnce(makeReservation());
    await createOrder("offer-1");
    expect(createRazorpayOrder).toHaveBeenCalledTimes(1);

    // Second call for the same offer: the reservation this time reflects the
    // real database state — a row already exists — so it fails, and
    // createOrder must not call Razorpay a second time.
    reserveLocalOrder.mockResolvedValueOnce({ reserved: false, reason: "ORDER_ALREADY_EXISTS" });

    await expect(createOrder("offer-1")).rejects.toThrow(OrderAlreadyExistsError);
    expect(createRazorpayOrder).toHaveBeenCalledTimes(1);
  });

  it("attaches the rail order id/payload onto the reserved row once Razorpay succeeds", async () => {
    getOfferById.mockResolvedValue(makeOffer({ id: "offer-1" }));
    reserveLocalOrder.mockResolvedValue(makeReservation({ order: { id: "local-order-xyz" } }));
    createRazorpayOrder.mockResolvedValue({ id: "order_rzp_123" });

    await createOrder("offer-1");

    expect(attachRailOrderId).toHaveBeenCalledWith("local-order-xyz", { id: "order_rzp_123" });
  });
});
