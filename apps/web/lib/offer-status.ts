/**
 * TICKET-504 — Offer status and TTL display (PRD §10, Q13).
 *
 * The pure shaping layer between `merchant.getSessionOffers` and the
 * merchant's watch-only offer card. "Show the offer perishing": each offer
 * carries a `expiresAt` instant, and this turns `(offers, now)` into rows
 * whose remaining TTL and lifecycle are a plain function of the clock — so
 * the React component is a render of `OfferStatusView` and "expiry is
 * reflected in the UI state" is a runner-light assertion (advance `now` past
 * `expiresAt`, re-derive, the row flips to expired).
 *
 * Money stays in minor units here (CONTRACTS.md §3 — rupees are formatted
 * only at the React render boundary); rows carry `…Minor` and the component
 * calls `formatRupees`.
 *
 * `status` from the API is the frozen best-effort read-model column
 * (`offers.status`); authoritative lifecycle is `consumedAt` (single-use is
 * enforced there) and `expiresAt` (the TTL). The precedence below reads
 * those two first and only falls back to `status` for the ACCEPTED /
 * DECLINED distinction they cannot make on their own.
 */

import type { RouterOutputs } from "@repo/trpc/client";

import { reasonTone, type ReasonTone } from "./event-stream";

export type SessionOffer = RouterOutputs["merchant"]["getSessionOffers"]["offers"][number];

/**
 * `live` — still perishing, TTL counting down. `expired` — TTL elapsed,
 * never consumed. `accepted` — consumed into an order. `declined` — the
 * buyer walked away or declined this offer.
 */
export type OfferLifecycle = "live" | "expired" | "accepted" | "declined";

const LIFECYCLE_LABEL: Record<OfferLifecycle, string> = {
  live: "Live",
  expired: "Expired",
  accepted: "Accepted",
  declined: "Declined",
};

const LIFECYCLE_TONE: Record<OfferLifecycle, ReasonTone> = {
  live: "neutral",
  expired: "warning",
  accepted: "positive",
  declined: "negative",
};

export type OfferStatusRow = {
  key: string;
  offerId: string;
  roundIndex: number;
  tier: 1 | 2;
  totalMinor: number;
  /** Exact contribution shortfall for this deal. Zero for Tier 1. */
  campaignSpendMinor: number;
  /** Raw reason code the offer was minted with — shown as-is (PRD §13.2). */
  reasonCode: string;
  reasonTone: ReasonTone;
  lifecycle: OfferLifecycle;
  /** The loudest word in the row: Live / Expired / Accepted / Declined. */
  statusLabel: string;
  statusTone: ReasonTone;
  /** Whether the TTL is still running — the only state that keeps ticking. */
  isPerishing: boolean;
  /** ms until `expiresAt`, clamped at 0. Always 0 once not `live`. */
  remainingMs: number;
  /** Whole seconds until expiry. */
  remainingSeconds: number;
  /** `m:ss`, e.g. `9:58`. `0:00` once expired. */
  remainingLabel: string;
  /**
   * Share of the original TTL window still remaining, in `[0, 1]` — for a
   * progress bar. `1` when `createdAt` is unknown and the offer is still
   * live, `0` once it is not.
   */
  remainingFraction: number;
  expiresAtIso: string;
};

export type OfferStatusView = {
  /** Newest round first — the same order the API returns. */
  rows: OfferStatusRow[];
  /** The most recent offer, the one the card leads with. `null` when none. */
  current: OfferStatusRow | null;
  /**
   * Whether the negotiation's offer story is over — the newest offer was
   * accepted or declined. An expired offer alone is not settled: a later
   * round may still mint another.
   */
  isSettled: boolean;
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${pad2(seconds)}`;
}

function lifecycleOf(offer: SessionOffer, nowMs: number, expiresMs: number): OfferLifecycle {
  if (offer.consumedAt !== null || offer.status === "ACCEPTED" || offer.status === "CONSUMED") {
    return "accepted";
  }
  if (offer.status === "DECLINED") return "declined";
  if (offer.status === "EXPIRED" || nowMs >= expiresMs) return "expired";
  return "live";
}

function toRow(offer: SessionOffer, nowMs: number): OfferStatusRow {
  const expiresMs = Date.parse(offer.expiresAt);
  const createdMs = offer.createdAt !== null ? Date.parse(offer.createdAt) : NaN;
  const lifecycle = lifecycleOf(offer, nowMs, expiresMs);
  const isPerishing = lifecycle === "live";

  const remainingMs = isPerishing ? Math.max(0, expiresMs - nowMs) : 0;

  let remainingFraction: number;
  if (!isPerishing) {
    remainingFraction = 0;
  } else if (Number.isNaN(createdMs) || expiresMs <= createdMs) {
    remainingFraction = 1;
  } else {
    remainingFraction = Math.min(1, Math.max(0, remainingMs / (expiresMs - createdMs)));
  }

  return {
    key: offer.offerId,
    offerId: offer.offerId,
    roundIndex: offer.roundIndex,
    // `merchant.getSessionOffers`'s output schema is `.int().min(1).max(2)`,
    // so anything off-range is rejected server-side before it reaches here.
    tier: offer.tier as 1 | 2,
    totalMinor: offer.totalMinor,
    campaignSpendMinor: offer.campaignSpendMinor,
    reasonCode: offer.reasonCode,
    reasonTone: reasonTone(offer.reasonCode),
    lifecycle,
    statusLabel: LIFECYCLE_LABEL[lifecycle],
    statusTone: LIFECYCLE_TONE[lifecycle],
    isPerishing,
    remainingMs,
    remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
    remainingLabel: formatRemaining(remainingMs),
    remainingFraction,
    expiresAtIso: offer.expiresAt,
  };
}

/**
 * Shape a `getSessionOffers` read into rows for the offer card, evaluated
 * against `nowMs` (the client's ticking clock). Defensively sorted newest
 * round first — the API already returns that order, but the view must not
 * depend on transport order.
 */
export function toOfferStatusView(
  offers: readonly SessionOffer[],
  nowMs: number,
): OfferStatusView {
  const rows = [...offers]
    .sort((a, b) => b.roundIndex - a.roundIndex)
    .map((offer) => toRow(offer, nowMs));

  const current = rows[0] ?? null;

  return {
    rows,
    current,
    isSettled: current !== null && (current.lifecycle === "accepted" || current.lifecycle === "declined"),
  };
}
