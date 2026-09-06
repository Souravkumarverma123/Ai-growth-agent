"use client";

import { useMemo } from "react";
import { AlertCircle, CircleDot, RefreshCw } from "lucide-react";

import { trpc } from "~/trpc/client";
import { cn } from "~/lib/utils";
import { formatRupees } from "~/lib/money";
import {
  isStreamSettled,
  toEventStreamRows,
  type EventStreamRow,
  type PayloadField,
  type ReasonTone,
} from "~/lib/event-stream";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";

/**
 * TICKET-502 — Live negotiation event stream (PRD §13, Q13).
 *
 * Poll-based, not SSE (the ticket is explicit: "Do not build SSE"). The
 * merchant watches a session's ledger without any ability to approve or
 * intervene — every row is already-committed history read back from
 * `audit.getSessionLedger`. New events show up within one poll interval;
 * polling stops once the session reaches a terminal state.
 */

const POLL_INTERVAL_MS = 2_000;

const TONE_CLASS: Record<ReasonTone, string> = {
  positive: "border-transparent bg-emerald-600 text-white dark:bg-emerald-500/80",
  negative: "border-transparent bg-destructive text-white dark:bg-destructive/70",
  warning: "border-transparent bg-amber-500 text-white dark:bg-amber-500/80",
  neutral: "border-transparent bg-secondary text-secondary-foreground",
};

export function MerchantEventStream({ sessionId }: { sessionId: string }) {
  const query = trpc.audit.getSessionLedger.useQuery(
    { sessionId },
    {
      // The polling loop. Stops itself once the session is terminal — a
      // finished negotiation is no longer an "active session" to watch.
      // `refetchIntervalInBackground: false` also parks it for a hidden tab.
      refetchInterval: (q) => {
        const events = q.state.data?.events;
        return events && isStreamSettled(events) ? false : POLL_INTERVAL_MS;
      },
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  // react-query's structural sharing keeps `events` referentially stable
  // across polls that returned nothing new, so an unchanged ledger costs one
  // identity check, not a re-sort / re-map / re-mount. (A negotiation is
  // round-capped, so the list is small and bounded regardless.)
  const events = query.data?.events;
  const rows = useMemo(() => toEventStreamRows(events ?? []), [events]);
  const settled = useMemo(() => rows.length > 0 && isStreamSettled(events ?? []), [rows, events]);

  return (
    <EventStreamView
      rows={rows}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message ?? null}
      isFetching={query.isFetching}
      isSettled={settled}
      lastUpdatedAt={query.dataUpdatedAt}
    />
  );
}

/**
 * The presentational half — no data fetching, so a full event sequence can
 * be handed in directly and asserted (TICKET-502 "Component renders a full
 * event sequence").
 */
export function EventStreamView({
  rows,
  isLoading = false,
  isError = false,
  errorMessage = null,
  isFetching = false,
  isSettled = false,
  lastUpdatedAt = 0,
}: {
  rows: EventStreamRow[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  isFetching?: boolean;
  isSettled?: boolean;
  lastUpdatedAt?: number;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Live event stream</CardTitle>
            <CardDescription>
              Every ledger event for this session, in order. Reason codes are shown exactly as the
              engine wrote them. Refreshes every {Math.round(POLL_INTERVAL_MS / 1000)}s while the
              negotiation is live — you are watching, not approving.
            </CardDescription>
          </div>
          <span
            className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs"
            aria-live="polite"
          >
            <RefreshCw className={cn("size-3", isFetching && "animate-spin")} />
            {isSettled ? "Settled" : isFetching ? "Refreshing" : "Live"}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="size-4" />
            Could not load the event stream{errorMessage ? `: ${errorMessage}` : "."}
          </p>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading events…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No events yet. They will appear here as the negotiation progresses.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {rows.map((row) => (
              <EventRow key={row.key} row={row} />
            ))}
          </ol>
        )}
        {!isError && lastUpdatedAt > 0 && (
          <p className="text-muted-foreground mt-4 text-[11px]">
            Last checked {new Date(lastUpdatedAt).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PayloadValue({ field }: { field: PayloadField }) {
  // The one place a payload amount becomes rupees (CONTRACTS.md §3).
  return <dd className="font-mono">{"amountMinor" in field ? formatRupees(field.amountMinor) : field.text}</dd>;
}

function EventRow({ row }: { row: EventStreamRow }) {
  const hasMeta =
    row.payloadFields.length > 0 ||
    row.campaignSpendMinor !== null ||
    row.offerId !== null ||
    row.policyVersion !== null;

  return (
    <li className="rounded-md border p-3" data-reason-code={row.reasonCode}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-xs">
          <CircleDot className="size-3" />#{row.sequence}
        </span>
        {/* THE JUSTIFICATION — raw reason code, most prominent thing in the row. */}
        <Badge className={cn("font-mono text-[11px] tracking-tight", TONE_CLASS[row.tone])}>
          {row.reasonCode}
        </Badge>
        <span className="text-muted-foreground font-mono text-[11px]">{row.transition}</span>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {new Date(row.timestampIso).toLocaleTimeString()}
        </span>
      </div>

      <div className="text-muted-foreground mt-1 font-mono text-[11px]">{row.eventType}</div>

      {hasMeta && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {row.payloadFields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-muted-foreground">{field.label}</dt>
              <PayloadValue field={field} />
            </div>
          ))}
          {row.campaignSpendMinor !== null && (
            <div className="contents">
              <dt className="text-muted-foreground">Campaign spend</dt>
              <dd className="font-mono">{formatRupees(row.campaignSpendMinor)}</dd>
            </div>
          )}
          {row.offerId !== null && (
            <div className="contents">
              <dt className="text-muted-foreground">Offer</dt>
              <dd className="font-mono">{row.offerId}</dd>
            </div>
          )}
          {row.policyVersion !== null && (
            <div className="contents">
              <dt className="text-muted-foreground">Policy version</dt>
              <dd className="font-mono">v{row.policyVersion}</dd>
            </div>
          )}
        </dl>
      )}

      {row.modelExplanation && (
        <>
          <Separator className="my-2" />
          <p className="text-xs">
            <span className="text-muted-foreground mr-1 text-[10px] uppercase tracking-wide">
              Model explanation · non-authoritative
            </span>
            <br />
            {row.modelExplanation}
          </p>
        </>
      )}
    </li>
  );
}
