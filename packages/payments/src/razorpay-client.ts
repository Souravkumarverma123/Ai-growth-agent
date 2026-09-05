/**
 * TICKET-301 — minimal Razorpay test-mode REST client.
 *
 * Deliberately not the `razorpay` npm package: Razorpay's order-create
 * endpoint is a single authenticated POST, so a hand-rolled client avoids
 * adding an SDK dependency for one call and keeps the actual HTTP call
 * behind a thin, mockable seam (`../tests/create-order.test.ts` replaces
 * this whole module with `vi.mock`, so no test in this package makes a real
 * network call or needs real credentials).
 *
 * ORDERS ONLY. There is no capture, charge, or refund function anywhere in
 * this module, or anywhere else in this package (CONTRACTS.md §2 acceptance
 * criteria for TICKET-301) — a human buyer authorizes the payment in
 * Razorpay's own checkout (TICKET-303); nothing here can trigger a charge.
 *
 * Credentials: reads `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from
 * `process.env` at call time (never at import time, and never hardcoded).
 * Add these to your local `.env` for a real test-mode call:
 *   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
 *   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
 */

const RAZORPAY_ORDERS_ENDPOINT = "https://api.razorpay.com/v1/orders";

export type RazorpayOrderRequest = {
  /** Minor units (paise). Always `offer.totalMinor` — see `../index.ts`. */
  amount: number;
  currency: string;
  /** Carries the offer id, for human reconciliation. */
  receipt: string;
  /** Carries offer id, tier, and campaign spend, for human reconciliation. */
  notes: Record<string, string | number>;
};

export type RazorpayOrder = {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
  notes: Record<string, string | number>;
  created_at: number;
};

/**
 * Thrown when `fetch` itself fails — DNS failure, connection refused, a
 * timeout, a connection reset mid-request or mid-response. Unlike every
 * other error this module throws (missing credentials, or a definitive
 * non-2xx response FROM Razorpay), this one is genuinely ambiguous: the
 * request may never have reached Razorpay's servers, or it may have
 * reached them, been processed, and created a real order, with only the
 * response lost on the way back. A caller must never assume "no order was
 * created" for this error the way it safely can for every other failure
 * `createRazorpayOrder` throws — see `createOrder`'s own handling in
 * `create-order.ts`.
 */
export class RazorpayNetworkError extends Error {
  constructor(cause: unknown) {
    super(
      "createRazorpayOrder: network error calling Razorpay — outcome unknown, do not assume no order was created",
      { cause },
    );
    this.name = "RazorpayNetworkError";
  }
}

function getCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "createRazorpayOrder: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. " +
        "Add Razorpay test-mode credentials to your local .env before calling this for real.",
    );
  }

  return { keyId, keySecret };
}

/**
 * The only Razorpay API call this package makes. Posts an order-creation
 * request and returns Razorpay's response verbatim. No capture/charge call
 * exists anywhere in this package — see this module's doc comment above.
 */
export async function createRazorpayOrder(
  request: RazorpayOrderRequest,
): Promise<RazorpayOrder> {
  const { keyId, keySecret } = getCredentials();
  const basicAuth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(RAZORPAY_ORDERS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new RazorpayNetworkError(error);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`createRazorpayOrder: Razorpay responded ${response.status}: ${body}`);
  }

  return (await response.json()) as RazorpayOrder;
}
