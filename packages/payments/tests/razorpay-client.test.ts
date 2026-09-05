import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRazorpayOrder, RazorpayNetworkError } from "../src/razorpay-client";

/**
 * Distinguishes the one genuinely ambiguous failure mode `createRazorpayOrder`
 * can produce (the network call itself failing — outcome unknown, an order
 * may or may not have been created) from every definitive failure (missing
 * credentials, or a non-2xx response Razorpay itself returned) — see
 * `create-order.ts`'s handling, which relies on this distinction to decide
 * whether freeing a reservation for retry is safe.
 */

const originalFetch = globalThis.fetch;
const originalKeyId = process.env.RAZORPAY_KEY_ID;
const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;

const request = {
  amount: 100000,
  currency: "INR",
  receipt: "offer-1",
  notes: { offerId: "offer-1", tier: 1, campaignSpendMinor: 0 },
};

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_fake";
  process.env.RAZORPAY_KEY_SECRET = "fake_secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.RAZORPAY_KEY_ID = originalKeyId;
  process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  vi.restoreAllMocks();
});

describe("createRazorpayOrder — failure classification", () => {
  it("wraps a fetch-level failure in RazorpayNetworkError, never a plain Error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(createRazorpayOrder(request)).rejects.toThrow(RazorpayNetworkError);
  });

  it("does NOT wrap a definitive non-2xx response in RazorpayNetworkError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );

    const error = await createRazorpayOrder(request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RazorpayNetworkError);
    expect(error).toBeInstanceOf(Error);
  });

  it("does NOT wrap a missing-credentials failure in RazorpayNetworkError", async () => {
    delete process.env.RAZORPAY_KEY_ID;

    const error = await createRazorpayOrder(request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RazorpayNetworkError);
  });

  it("returns the parsed order on a successful response, unaffected by the new error wrapping", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "order_ok", entity: "order" }), { status: 200 }),
    );

    const result = await createRazorpayOrder(request);
    expect(result.id).toBe("order_ok");
  });
});
