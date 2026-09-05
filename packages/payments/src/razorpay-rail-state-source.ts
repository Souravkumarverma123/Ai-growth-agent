import type { RailOrderReport, RailState, RailStateSource } from "./rail-state-source";

/**
 * TICKET-304 — the `RailStateSource` interface's one production
 * implementation (PRD §12). Polls Razorpay's own record of an order's
 * payment attempts; never Razorpay's webhook push, which PRD §12 explicitly
 * keeps off the critical path ("Webhooks require a publicly reachable
 * URL... Polling produces the identical narrative with no network
 * dependency").
 *
 * Same conventions as `./razorpay-client.ts` (this package's only other
 * Razorpay caller): a hand-rolled `fetch`, not the `razorpay` SDK; Basic Auth
 * from `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` read at call time; no
 * capture/charge/refund call anywhere (this endpoint is a plain `GET`).
 */

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

/** The subset of Razorpay's payment-entity shape this module actually reads.
 *  Razorpay's real payload carries many more fields; everything else is
 *  passed through verbatim in `payload` for human reconciliation without
 *  this module needing to model it. */
type RazorpayPaymentAttempt = {
  id: string;
  status: string;
  /** Minor units — same unit `orders.amountMinor` is stored in. */
  amount: number;
  [key: string]: unknown;
};

type RazorpayPaymentsListResponse = {
  entity: string;
  count: number;
  items: RazorpayPaymentAttempt[];
};

function getCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "RazorpayRailStateSource: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. " +
        "Add Razorpay test-mode credentials to your local .env before polling for real.",
    );
  }

  return { keyId, keySecret };
}

/**
 * Razorpay's own payment-status vocabulary ("created", "authorized",
 * "captured", "failed", "refunded") mapped onto this module's frozen
 * `RailState`. A buyer can retry a failed payment attempt, so an order can
 * carry several payment attempts over its lifetime — this module reports
 * the single most advanced outcome among them (captured beats authorized
 * beats failed beats created), because "was money ever actually captured
 * for this order" is the one fact §12's reconciliation cares about, not
 * which specific attempt produced it.
 *
 * "refunded" is treated as CAPTURED: a refund is a separate, later event
 * this MVP's reconciliation does not model (PRD's payment reconciliation
 * scope stops at "did the buyer's payment succeed") — the capture itself
 * genuinely happened, which is the fact this function reports.
 */
const STATUS_RANK: Record<string, number> = {
  captured: 3,
  refunded: 3,
  authorized: 2,
  created: 1,
  failed: 0,
};

/** The most advanced payment attempt for this order, and the `RailState` it
 *  maps onto — `undefined` when no attempt exists yet (buyer hasn't reached
 *  checkout, or hasn't submitted payment details; not a failure). */
function mostAdvanced(
  items: readonly RazorpayPaymentAttempt[],
): { attempt: RazorpayPaymentAttempt; railState: RailState } | undefined {
  if (items.length === 0) return undefined;

  const best = items.reduce((a, b) => ((STATUS_RANK[b.status] ?? -1) > (STATUS_RANK[a.status] ?? -1) ? b : a));

  switch (best.status) {
    case "captured":
    case "refunded":
      return { attempt: best, railState: "CAPTURED" };
    case "authorized":
      return { attempt: best, railState: "AUTHORIZED" };
    case "failed":
      return { attempt: best, railState: "FAILED" };
    case "created":
      return { attempt: best, railState: "CREATED" };
    default:
      // An unrecognized Razorpay status is a genuine "we don't know" case —
      // fail closed by throwing rather than guessing a RailState, per
      // CONTRACTS.md §6 (never silently misclassify at a money boundary).
      throw new Error(`RazorpayRailStateSource: unrecognized payment status "${best.status}"`);
  }
}

export class RazorpayRailStateSource implements RailStateSource {
  async getOrderState(railOrderId: string): Promise<RailOrderReport> {
    const { keyId, keySecret } = getCredentials();
    const basicAuth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

    const response = await fetch(`${RAZORPAY_API_BASE}/orders/${railOrderId}/payments`, {
      method: "GET",
      headers: { Authorization: `Basic ${basicAuth}` },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RazorpayRailStateSource: Razorpay responded ${response.status}: ${body}`);
    }

    const body = (await response.json()) as RazorpayPaymentsListResponse;
    const result = mostAdvanced(body.items);

    return {
      railState: result?.railState ?? "CREATED",
      capturedAmountMinor: result?.railState === "CAPTURED" ? result.attempt.amount : undefined,
      payload: body,
    };
  }
}
