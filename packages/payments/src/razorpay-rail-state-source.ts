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
 *  checkout, or hasn't submitted payment details; not a failure).
 *
 *  Every item's status is validated BEFORE ranking, not just the winner's:
 *  `STATUS_RANK[status] ?? -1` ranks an unrecognized status below even
 *  `"failed"` (rank 0), so if the list also contains any recognized attempt,
 *  `reduce` would pick that one as "best" and the unrecognized attempt would
 *  never reach the `default` throw below — silently ignored instead of
 *  failing closed. Checking every item up front closes that gap: an
 *  unrecognized status anywhere in the list is a genuine "we don't know"
 *  case regardless of what else is present (CONTRACTS.md §6). */
function mostAdvanced(
  items: readonly RazorpayPaymentAttempt[],
): { attempt: RazorpayPaymentAttempt; railState: RailState } | undefined {
  if (items.length === 0) return undefined;

  for (const item of items) {
    if (!(item.status in STATUS_RANK)) {
      throw new Error(`RazorpayRailStateSource: unrecognized payment status "${item.status}"`);
    }
  }

  const best = items.reduce((a, b) => (STATUS_RANK[b.status]! > STATUS_RANK[a.status]! ? b : a));

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
      // Unreachable — every status in `items` is already validated against
      // STATUS_RANK above, and every key it defines is handled by a case
      // here. Kept as a defensive throw, not a silent fallback, in case the
      // two ever drift apart.
      throw new Error(`RazorpayRailStateSource: unhandled recognized status "${best.status}"`);
  }
}

/** Razorpay's max page size for list endpoints — requesting it up front
 *  minimizes the number of round trips for an order with many retried
 *  payment attempts. */
const PAGE_SIZE = 100;
/** A buyer genuinely retrying enough times to need more than this many
 *  pages (2000 attempts) is not a real scenario this MVP needs to serve —
 *  bounds the loop below so a misbehaving API can't hang this call forever. */
const MAX_PAGES = 20;

export class RazorpayRailStateSource implements RailStateSource {
  async getOrderState(railOrderId: string): Promise<RailOrderReport> {
    const { keyId, keySecret } = getCredentials();
    const basicAuth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const headers = { Authorization: `Basic ${basicAuth}` };

    // Razorpay's list endpoints are paginated (`count`/`skip`, max count
    // 100) — a single request only ever returns the first page, so an order
    // with more payment attempts than that (a buyer retrying a failed
    // payment repeatedly) could have its actual capture sitting on a later
    // page a one-shot fetch would never see, reporting a stale non-captured
    // state PRD §12 would then treat as authoritative. Reading every page
    // (there's no separate "total" field to check against — a page shorter
    // than requested is the only end-of-list signal Razorpay's own list
    // shape gives) closes that gap.
    const allItems: RazorpayPaymentAttempt[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await fetch(
        `${RAZORPAY_API_BASE}/orders/${railOrderId}/payments?count=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`,
        { method: "GET", headers },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`RazorpayRailStateSource: Razorpay responded ${response.status}: ${body}`);
      }

      const body = (await response.json()) as RazorpayPaymentsListResponse;
      allItems.push(...body.items);

      if (body.items.length < PAGE_SIZE) break;
    }

    const result = mostAdvanced(allItems);

    return {
      railState: result?.railState ?? "CREATED",
      capturedAmountMinor: result?.railState === "CAPTURED" ? result.attempt.amount : undefined,
      // Every attempt across every page fetched above, merged — a human
      // reconciling this order should see the whole picture, not just
      // whichever page happened to load last.
      payload: { entity: "collection", count: allItems.length, items: allItems },
    };
  }
}
