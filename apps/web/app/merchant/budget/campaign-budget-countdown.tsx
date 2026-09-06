"use client";

import { useMemo } from "react";

import { trpc } from "~/trpc/client";
import { cn } from "~/lib/utils";
import { formatRupees } from "~/lib/money";
import {
  toCampaignBudgetView,
  type CampaignBudgetSegmentKey,
  type CampaignBudgetView,
} from "~/lib/campaign-budget";
import {
  MERCHANT_POLL_INTERVAL_MS,
  MERCHANT_POLL_INTERVAL_SECONDS,
  PollCard,
  PollError,
  PollLastChecked,
  pollStatus,
} from "~/components/merchant/poll-card";

/**
 * TICKET-503 — Campaign budget countdown (PRD §6.5).
 *
 * "The visible number that makes 'bounded' concrete." Poll-based, like the
 * event stream (TICKET-502) — not SSE. The merchant watches `available` fall
 * as Tier 2 holds are reserved and climb back as they expire or release.
 * Read-only: there is no control here, the budget is set on the policy page.
 */

const SEGMENT_CLASS: Record<CampaignBudgetSegmentKey, string> = {
  committed: "bg-emerald-600 dark:bg-emerald-500/80",
  reserved: "bg-amber-500 dark:bg-amber-500/80",
  available: "bg-secondary",
};

const SEGMENT_DOT_CLASS: Record<CampaignBudgetSegmentKey, string> = {
  committed: "bg-emerald-600 dark:bg-emerald-500/80",
  reserved: "bg-amber-500 dark:bg-amber-500/80",
  available: "bg-muted-foreground/40",
};

export function MerchantCampaignBudget({ merchantId }: { merchantId: string }) {
  const query = trpc.merchant.getCampaignBudget.useQuery(
    { merchantId },
    {
      // The campaign budget is merchant-global and always live — there is no
      // terminal state to stop on, unlike a single session's event stream.
      refetchInterval: MERCHANT_POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  const snapshot = query.data;
  const view = useMemo(() => (snapshot ? toCampaignBudgetView(snapshot) : null), [snapshot]);

  return (
    <CampaignBudgetPanel
      view={view}
      isError={query.isError}
      errorMessage={query.error?.message ?? null}
      isFetching={query.isFetching}
      lastUpdatedAt={query.dataUpdatedAt}
    />
  );
}

/**
 * The presentational half — no data fetching, so a sequence of snapshots can
 * be handed in directly and asserted (TICKET-503 "Display matches engine
 * state across a hold lifecycle").
 */
export function CampaignBudgetPanel({
  view,
  isError = false,
  errorMessage = null,
  isFetching = false,
  lastUpdatedAt = 0,
}: {
  view: CampaignBudgetView | null;
  isError?: boolean;
  errorMessage?: string | null;
  isFetching?: boolean;
  lastUpdatedAt?: number;
}) {
  return (
    <PollCard
      title="Campaign budget"
      description={
        <>
          The ceiling on lifetime dilutive (Tier 2) spend. Reserved rises and available falls as an
          offer is minted; both return when it expires or is declined. Refreshes every{" "}
          {MERCHANT_POLL_INTERVAL_SECONDS}s.
        </>
      }
      status={pollStatus(isFetching)}
    >
      {view ? (
        // A snapshot we already have always stays on screen — a transient
        // failure on one 2s poll must not blank out the merchant's last
        // good figures. The failure is surfaced inline instead.
        <BudgetBreakdown view={view} />
      ) : isError ? (
        <PollError>
          Could not load the campaign budget{errorMessage ? `: ${errorMessage}` : "."}
        </PollError>
      ) : (
        <p className="text-muted-foreground text-sm">Loading campaign budget…</p>
      )}
      {view && isError && (
        <PollError size="sm">
          Last refresh failed{errorMessage ? `: ${errorMessage}` : "."} Showing the last known
          figures.
        </PollError>
      )}
      {view && !isError && <PollLastChecked at={lastUpdatedAt} />}
    </PollCard>
  );
}

function BudgetBreakdown({ view }: { view: CampaignBudgetView }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-muted-foreground text-xs">Available</div>
        {/* The one place minor units become rupees (CONTRACTS.md §3). */}
        <div className="font-mono text-2xl font-semibold tabular-nums">
          {formatRupees(view.availableMinor)}
        </div>
        <div className="text-muted-foreground text-xs">
          of {formatRupees(view.totalMinor)} total
        </div>
      </div>

      {/* Stacked bar: committed | reserved | available, left to right. */}
      <div
        className="bg-muted flex h-3 w-full overflow-hidden rounded-full"
        role="img"
        aria-label={`${formatRupees(view.availableMinor)} available of ${formatRupees(view.totalMinor)} total; ${formatRupees(view.reservedMinor)} reserved, ${formatRupees(view.committedMinor)} committed`}
      >
        {view.segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("h-full", SEGMENT_CLASS[segment.key])}
            style={{ width: `${(segment.fraction * 100).toFixed(3)}%` }}
            data-segment={segment.key}
          />
        ))}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        {view.segments.map((segment) => (
          <div key={segment.key} className="flex flex-col gap-0.5" data-figure={segment.key}>
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span className={cn("size-2 rounded-full", SEGMENT_DOT_CLASS[segment.key])} />
              {segment.label}
            </dt>
            <dd className="font-mono tabular-nums">{formatRupees(segment.amountMinor)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
