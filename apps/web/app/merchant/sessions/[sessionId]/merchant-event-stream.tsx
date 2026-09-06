"use client";

import { AlertCircle, CircleDot, RefreshCw } from "lucide-react";

import { trpc } from "~/trpc/client";
import { cn } from "~/lib/utils";
import {
  toEventStreamRows,
  type EventStreamRow,
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
 * `audit.getSessionLedger`. New events show up within one poll interval.
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
      // The polling loop. `refetchIntervalInBackground: false` keeps a
      // backgrounded tab quiet; a watching merchant has it foregrounded.
      refetchInterval: POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  const rows = toEventStreamRows(query.data?.events ?? []);

  return (
    <EventStreamView
      rows={rows}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message ?? null}
      isFetching={query.isFetching}
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
  lastUpdatedAt = 0,
}: {
  rows: EventStreamRow[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  isFetching?: boolean;
  lastUpdatedAt?: number;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Live event stream</CardTitle>
            <CardDescription>
              Every ledger event for this session, newest last. Reason codes are shown exactly as
              the engine wrote them. Updates every {Math.round(POLL_INTERVAL_MS / 1000)}s — you are
              watching, not approving.
            </CardDescription>
          </div>
          <span
            className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs"
            aria-live="polite"
          >
            <RefreshCw className={cn("size-3", isFetching && "animate-spin")} />
            {isFetching ? "Refreshing" : "Live"}
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

function EventRow({ row }: { row: EventStreamRow }) {
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
        <span className="text-muted-foreground ml-auto text-[11px]">{row.timestampLabel}</span>
      </div>

      <div className="text-muted-foreground mt-1 font-mono text-[11px]">{row.eventType}</div>

      {(row.payloadFields.length > 0 ||
        row.campaignSpendLabel !== null ||
        row.offerId !== null ||
        row.policyVersion !== null) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {row.payloadFields.map((field) => (
            <div key={field.label} className="contents">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="font-mono">{field.value}</dd>
            </div>
          ))}
          {row.campaignSpendLabel !== null && (
            <div className="contents">
              <dt className="text-muted-foreground">Campaign spend</dt>
              <dd className="font-mono">{row.campaignSpendLabel}</dd>
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
            <span className="text-muted-foreground mr-1 uppercase tracking-wide text-[10px]">
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
