"use client";

import { useMemo } from "react";
import { CircleDot, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

import { trpc } from "~/trpc/client";
import { cn } from "~/lib/utils";
import { formatRupees } from "~/lib/money";
import { isStreamSettled } from "~/lib/event-stream";
import {
  extractCandidateCounts,
  summarizeChain,
  toAuditTrailRows,
  type ChainStatus,
  type ChainSummary,
  type CandidateCounts,
  type EventStreamRow,
  type PayloadField,
} from "~/lib/audit-trail";
import {
  MERCHANT_POLL_INTERVAL_MS,
  MERCHANT_POLL_INTERVAL_SECONDS,
  PollCard,
  PollError,
  PollLastChecked,
  pollStatus,
} from "~/components/merchant/poll-card";
import { ReasonCodeBadge } from "~/components/merchant/reason-code-badge";

/**
 * TICKET-505 — Audit trail display (PRD §13.2, §8; Q13, Q28).
 *
 * "The screen a judge will look at." A read-only, chronological render of one
 * session's append-only ledger, with the two things a judge checks first
 * pulled out and put on top:
 *
 *   1. Chain verification — is the hash chain intact, and the honest
 *      disclosure that it is self-anchored (PRD §13.3).
 *   2. Candidate counts — evaluated / feasible / Tier 1, the bounded space
 *      the engine searched (PRD §8), so "how do you know there wasn't a
 *      better deal?" is already answered.
 *
 * Then every event, with the reason code (THE justification) most prominent
 * and the model explanation in a visually separate block, always labelled
 * non-authoritative (PRD §13.2). Poll-based like the live stream; it stops
 * once the session is terminal.
 */

const CHAIN_ICON: Record<ChainStatus, typeof ShieldCheck> = {
  verified: ShieldCheck,
  broken: ShieldAlert,
  empty: ShieldQuestion,
};

const CHAIN_TONE_CLASS: Record<ChainStatus, string> = {
  verified:
    "border-emerald-600/30 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300",
  broken: "border-destructive/40 bg-destructive/10 text-destructive",
  empty: "border-border bg-muted/40 text-muted-foreground",
};

export function MerchantAuditTrail({ sessionId }: { sessionId: string }) {
  const ledger = trpc.audit.getSessionLedger.useQuery(
    { sessionId },
    {
      refetchInterval: (q) => {
        const events = q.state.data?.events;
        return events && isStreamSettled(events) ? false : MERCHANT_POLL_INTERVAL_MS;
      },
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  const events = ledger.data?.events;
  const settled = useMemo(() => !!events && events.length > 0 && isStreamSettled(events), [events]);

  // Chain verification runs off the same append-only ledger, so it settles
  // when the ledger does — no point re-verifying a finished chain forever.
  const chainQuery = trpc.audit.verifyChain.useQuery(
    { sessionId },
    {
      refetchInterval: settled ? false : MERCHANT_POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  );

  const rows = useMemo(() => toAuditTrailRows(events ?? []), [events]);
  const chain = useMemo(
    () => (chainQuery.data ? summarizeChain(chainQuery.data) : null),
    [chainQuery.data],
  );
  const candidateCounts = useMemo(
    () => (events ? extractCandidateCounts(events) : null),
    [events],
  );

  return (
    <AuditTrailView
      rows={rows}
      chain={chain}
      candidateCounts={candidateCounts}
      isLoading={ledger.isLoading}
      isError={ledger.isError}
      errorMessage={ledger.error?.message ?? null}
      isFetching={ledger.isFetching || chainQuery.isFetching}
      isSettled={settled}
      lastUpdatedAt={ledger.dataUpdatedAt}
    />
  );
}

/**
 * The presentational half — no data fetching, so the full worked-example run
 * can be handed in directly and asserted (TICKET-505 "Renders the full
 * worked-example run").
 */
export function AuditTrailView({
  rows,
  chain,
  candidateCounts,
  isLoading = false,
  isError = false,
  errorMessage = null,
  isFetching = false,
  isSettled = false,
  lastUpdatedAt = 0,
}: {
  rows: EventStreamRow[];
  chain: ChainSummary | null;
  candidateCounts: CandidateCounts | null;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  isFetching?: boolean;
  isSettled?: boolean;
  lastUpdatedAt?: number;
}) {
  const hasContent = rows.length > 0;

  return (
    <PollCard
      title="Audit trail"
      description={
        <>
          Every ledger event for this session, in order, with its reason code, structured payload
          and — clearly marked as non-authoritative — the model&apos;s explanation. Reconstructable
          end to end from this screen alone (PRD §13.2). Refreshes every{" "}
          {MERCHANT_POLL_INTERVAL_SECONDS}s while the negotiation is live.
        </>
      }
      status={pollStatus(isFetching, isSettled)}
    >
      {isError && !hasContent ? (
        <PollError>
          Could not load the audit trail{errorMessage ? `: ${errorMessage}` : "."}
        </PollError>
      ) : isLoading && !hasContent ? (
        <p className="text-muted-foreground text-sm">Loading the audit trail…</p>
      ) : !hasContent ? (
        <p className="text-muted-foreground text-sm">
          No events yet. They will appear here as the negotiation progresses.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {chain && <ChainVerificationIndicator summary={chain} />}
          <CandidateCountsPanel counts={candidateCounts} />
          <ol className="flex flex-col gap-3">
            {rows.map((row) => (
              <AuditEventRow key={row.key} row={row} />
            ))}
          </ol>
        </div>
      )}
      {isError && hasContent && (
        <PollError size="sm">
          Last refresh failed{errorMessage ? `: ${errorMessage}` : "."} Showing the last known
          ledger.
        </PollError>
      )}
      {!isError && <PollLastChecked at={lastUpdatedAt} />}
    </PollCard>
  );
}

function ChainVerificationIndicator({ summary }: { summary: ChainSummary }) {
  const Icon = CHAIN_ICON[summary.status];
  return (
    <div
      data-testid="chain-verification"
      data-status={summary.status}
      className={cn("flex items-start gap-3 rounded-md border p-3", CHAIN_TONE_CLASS[summary.status])}
    >
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {summary.label}
          {summary.status !== "empty" && (
            <span className="ml-2 font-mono text-xs font-normal opacity-70">
              {summary.eventCount} event{summary.eventCount === 1 ? "" : "s"}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs opacity-80">{summary.detail}</p>
      </div>
    </div>
  );
}

function CandidateCountsPanel({ counts }: { counts: CandidateCounts | null }) {
  const missing =
    counts?.completeness === "partial"
      ? counts.counts.filter((c) => c.value === null).map((c) => c.label)
      : [];

  return (
    <div data-testid="candidate-counts">
      <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        Candidate space searched
      </p>
      {counts ? (
        <>
          <dl className="mt-2 grid grid-cols-3 gap-3 text-sm">
            {counts.counts.map((count) => (
              <div key={count.key} className="flex flex-col gap-0.5" data-figure={count.key}>
                <dt className="text-muted-foreground text-xs">{count.label}</dt>
                <dd className="font-mono text-lg font-semibold tabular-nums">
                  {count.value === null ? "—" : count.value}
                </dd>
              </div>
            ))}
          </dl>
          {missing.length > 0 && (
            <p className="text-muted-foreground mt-2 text-[11px]">
              {missing.join(" and ")} not recorded in this session&apos;s{" "}
              <span className="font-mono">CANDIDATES_EVALUATED</span> event.
            </p>
          )}
        </>
      ) : (
        <p className="text-muted-foreground mt-1 text-sm">
          Appears once the engine has evaluated a basket for this session.
        </p>
      )}
    </div>
  );
}

function PayloadValue({ field }: { field: PayloadField }) {
  // The one place a payload amount becomes rupees (CONTRACTS.md §3).
  return (
    <dd className="font-mono">
      {"amountMinor" in field ? formatRupees(field.amountMinor) : field.text}
    </dd>
  );
}

function AuditEventRow({ row }: { row: EventStreamRow }) {
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
        <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
          Justification
        </span>
        <ReasonCodeBadge code={row.reasonCode} tone={row.tone} />
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
        <div
          data-testid="model-explanation"
          className="border-muted-foreground/30 bg-muted/40 mt-3 rounded border border-dashed p-2"
        >
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
            Model explanation · non-authoritative · not consulted by any decision
          </p>
          <p className="mt-1 text-xs italic">{row.modelExplanation}</p>
        </div>
      )}
    </li>
  );
}
