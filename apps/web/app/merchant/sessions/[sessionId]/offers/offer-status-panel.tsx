"use client";

import { useEffect, useMemo, useState } from "react";
import { Timer } from "lucide-react";

import { trpc } from "~/trpc/client";
import { cn } from "~/lib/utils";
import { formatRupees } from "~/lib/money";
import {
  toOfferStatusView,
  type OfferStatusRow,
  type OfferStatusView,
} from "~/lib/offer-status";
import {
  MERCHANT_POLL_INTERVAL_MS,
  MERCHANT_POLL_INTERVAL_SECONDS,
  PollCard,
  PollError,
  PollLastChecked,
  pollStatus,
} from "~/components/merchant/poll-card";
import { REASON_TONE_CLASS, ReasonCodeBadge } from "~/components/merchant/reason-code-badge";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";

/**
 * TICKET-504 — Offer status and TTL display (PRD §10, Q13).
 *
 * "Show the offer perishing." Poll-based like the event stream (TICKET-502)
 * and the budget countdown (TICKET-503) — the merchant watches a session's
 * offer count its TTL down and flip to expired, with no lever to pull here
 * (RA-1). Two clocks: a slow `merchant.getSessionOffers` poll for status
 * changes, and a 1s local tick so the countdown moves smoothly between
 * polls and keeps running after polling stops.
 */

export function MerchantOfferStatus({ sessionId }: { sessionId: string }) {
  const query = trpc.merchant.getSessionOffers.useQuery(
    { sessionId },
    {
      // Stop polling once the newest offer is accepted or declined — the
      // negotiation's offer story is over. An expired offer keeps polling:
      // a later round may still mint another.
      refetchInterval: (q) => {
        const offers = q.state.data?.offers;
        if (!offers) return MERCHANT_POLL_INTERVAL_MS;
        return toOfferStatusView(offers, Date.now()).isSettled ? false : MERCHANT_POLL_INTERVAL_MS;
      },
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  // The local countdown clock. Ticks once a second regardless of the poll —
  // the TTL must visibly move even while the slow poll is idle.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const offers = query.data?.offers;
  const view = useMemo(
    () => (offers ? toOfferStatusView(offers, nowMs) : null),
    [offers, nowMs],
  );

  return (
    <OfferStatusPanel
      view={view}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message ?? null}
      isFetching={query.isFetching}
      lastUpdatedAt={query.dataUpdatedAt}
    />
  );
}

/**
 * The presentational half — no data fetching, no clock. A `view` derived at
 * a chosen `now` is handed straight in, so "expiry is reflected in the UI
 * state" is a re-render with `now` advanced past `expiresAt`
 * (`tests/offer-status.test.tsx`).
 */
export function OfferStatusPanel({
  view,
  isLoading = false,
  isError = false,
  errorMessage = null,
  isFetching = false,
  lastUpdatedAt = 0,
}: {
  view: OfferStatusView | null;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  isFetching?: boolean;
  lastUpdatedAt?: number;
}) {
  const hasOffers = view !== null && view.rows.length > 0;

  return (
    <PollCard
      title="Offer status"
      description={
        <>
          The current offer, its remaining time to live, tier, and campaign spend. An offer
          perishes on its TTL (PRD §10) — watch the countdown, you are not approving. Refreshes
          every {MERCHANT_POLL_INTERVAL_SECONDS}s.
        </>
      }
      status={pollStatus(isFetching, view?.isSettled ?? false)}
    >
      {isError && !hasOffers ? (
        <PollError>
          Could not load the offer{errorMessage ? `: ${errorMessage}` : "."}
        </PollError>
      ) : isLoading || view === null ? (
        <p className="text-muted-foreground text-sm">Loading offer…</p>
      ) : !hasOffers ? (
        <p className="text-muted-foreground text-sm">
          No offer minted yet. One will appear here as soon as the engine mints it.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <CurrentOffer row={view.current!} />
          {view.rows.length > 1 && (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <div className="text-muted-foreground text-xs">Earlier offers this session</div>
                {view.rows.slice(1).map((row) => (
                  <EarlierOffer key={row.key} row={row} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {hasOffers && isError && (
        <PollError size="sm">
          Last refresh failed{errorMessage ? `: ${errorMessage}` : "."} Showing the last known
          status.
        </PollError>
      )}
      {view !== null && !isError && <PollLastChecked at={lastUpdatedAt} />}
    </PollCard>
  );
}

function CurrentOffer({ row }: { row: OfferStatusRow }) {
  return (
    <div className="rounded-md border p-4" data-offer-id={row.offerId} data-lifecycle={row.lifecycle}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className={cn("text-[11px]", REASON_TONE_CLASS[row.statusTone])}
          data-testid="offer-status-label"
        >
          {row.statusLabel}
        </Badge>
        <Badge variant="outline" className="text-[11px]">
          Tier {row.tier}
        </Badge>
        <span className="text-muted-foreground font-mono text-[11px]">Round {row.roundIndex}</span>
        <ReasonCodeBadge code={row.reasonCode} tone={row.reasonTone} className="ml-auto" />
      </div>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <div className="text-muted-foreground text-xs">Offer total</div>
          {/* The one place minor units become rupees (CONTRACTS.md §3). */}
          <div className="font-mono text-2xl font-semibold tabular-nums">
            {formatRupees(row.totalMinor)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-muted-foreground flex items-center justify-end gap-1 text-xs">
            <Timer className="size-3" />
            Time to live
          </div>
          <div
            className={cn(
              "font-mono text-2xl font-semibold tabular-nums",
              row.isPerishing ? "text-foreground" : "text-muted-foreground",
            )}
            data-testid="offer-ttl"
          >
            {row.remainingLabel}
          </div>
        </div>
      </div>

      {/* TTL bar — full at mint, empties as the offer perishes. */}
      <div
        className="bg-muted mt-3 h-2 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={
          row.isPerishing
            ? `${row.remainingLabel} of the offer's time to live remaining`
            : `Offer ${row.statusLabel.toLowerCase()}`
        }
      >
        <div
          className={cn(
            "h-full",
            row.lifecycle === "expired"
              ? "bg-amber-500 dark:bg-amber-500/80"
              : row.lifecycle === "declined"
                ? "bg-destructive"
                : row.lifecycle === "accepted"
                  ? "bg-emerald-600 dark:bg-emerald-500/80"
                  : "bg-secondary-foreground/60",
          )}
          style={{ width: `${(row.remainingFraction * 100).toFixed(2)}%` }}
          data-testid="offer-ttl-bar"
        />
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Campaign spend</dt>
        <dd className="font-mono tabular-nums" data-testid="offer-campaign-spend">
          {row.tier === 2 ? formatRupees(row.campaignSpendMinor) : "—"}
        </dd>
        <dt className="text-muted-foreground">Expires at</dt>
        <dd className="font-mono">{new Date(row.expiresAtIso).toLocaleTimeString()}</dd>
        <dt className="text-muted-foreground">Offer</dt>
        <dd className="font-mono">{row.offerId}</dd>
      </dl>
    </div>
  );
}

function EarlierOffer({ row }: { row: OfferStatusRow }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
      data-offer-id={row.offerId}
      data-lifecycle={row.lifecycle}
    >
      <Badge className={cn("text-[10px]", REASON_TONE_CLASS[row.statusTone])}>
        {row.statusLabel}
      </Badge>
      <span className="text-muted-foreground font-mono">Round {row.roundIndex}</span>
      <span className="text-muted-foreground">Tier {row.tier}</span>
      <span className="font-mono tabular-nums">{formatRupees(row.totalMinor)}</span>
      <ReasonCodeBadge code={row.reasonCode} tone={row.reasonTone} className="ml-auto" />
    </div>
  );
}
