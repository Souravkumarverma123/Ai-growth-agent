"use client";

import { useMemo } from "react";
import { TrendingDown } from "lucide-react";

import { trpc } from "~/trpc/client";
import { formatRupees } from "~/lib/money";
import {
  buildWalkAwayInsight,
  type WalkAwayInsight,
} from "~/lib/walk-away-insight";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { ReasonCodeBadge } from "~/components/merchant/reason-code-badge";
import { reasonTone } from "~/lib/event-stream";

/**
 * TICKET-508 — Walk-away policy-change card (PRD §19, §20).
 *
 * Shown only when a session walked away. It is the MVP stand-in for a live
 * feedback loop (an explicit PRD §19 cut): a single card, every number read
 * straight from this session's append-only ledger, saying how many offers the
 * buyer refused and — where the ledger recorded it — what per-deal cap would
 * have let the agent close the deal.
 *
 * Reuses the same `audit.getSessionLedger` query key the audit trail uses, so
 * it adds no extra fetch.
 */
export function WalkAwayInsightCard({ sessionId }: { sessionId: string }) {
  const ledger = trpc.audit.getSessionLedger.useQuery({ sessionId }, { staleTime: 0 });
  const insight = useMemo(
    () => (ledger.data ? buildWalkAwayInsight(ledger.data.events) : null),
    [ledger.data],
  );

  if (!insight) return null;
  return <WalkAwayInsightCardView insight={insight} />;
}

/**
 * The presentational half — hand it a {@link WalkAwayInsight} and it renders,
 * so "card figures match ledger contents" is a pure assertion
 * (`apps/web/tests/walk-away-insight.test.tsx`).
 */
export function WalkAwayInsightCardView({ insight }: { insight: WalkAwayInsight }) {
  const { terminalReasonCode, roundsNegotiated, offersRefused, campaignFundedUpToMinor, capOutcome } =
    insight;

  return (
    <Card data-testid="walk-away-card" data-reason-code={terminalReasonCode}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <TrendingDown className="text-muted-foreground mt-0.5 size-5 shrink-0" />
          <div>
            <CardTitle className="text-base">This negotiation walked away</CardTitle>
            <CardDescription>
              Computed from this session&apos;s ledger — not a forecast. The live feedback loop is
              out of scope for the MVP (PRD §19); this is the one card that replaces it.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
            Walk-away reason
          </span>
          <ReasonCodeBadge code={terminalReasonCode} tone={reasonTone(terminalReasonCode)} />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Figure label="Rounds negotiated" value={String(roundsNegotiated)} />
          <Figure label="Offers the buyer refused" value={String(offersRefused)} figureKey="offersRefused" />
          <Figure
            label="Campaign funded up to"
            value={campaignFundedUpToMinor === null ? "—" : formatRupees(campaignFundedUpToMinor)}
            figureKey="campaignFundedUpTo"
          />
        </dl>

        <CapOutcomeLine outcome={capOutcome} />
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  figureKey,
}: {
  label: string;
  value: string;
  figureKey?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-figure={figureKey}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function CapOutcomeLine({ outcome }: { outcome: WalkAwayInsight["capOutcome"] }) {
  switch (outcome.kind) {
    case "cap-would-have-closed":
      return (
        <p
          data-testid="cap-outcome"
          data-kind={outcome.kind}
          className="rounded-md border border-amber-600/30 bg-amber-600/10 p-3 text-sm text-amber-900 dark:text-amber-200"
        >
          A per-deal cap of <strong>{formatRupees(outcome.requiredCapMinor)}</strong> would have let
          the agent fund this deal — your cap for this run was{" "}
          <strong>{formatRupees(outcome.perDealCapMinor)}</strong>. The campaign budget had room; the
          per-deal cap was the binding limit.
        </p>
      );
    case "budget-bound":
      return (
        <p
          data-testid="cap-outcome"
          data-kind={outcome.kind}
          className="text-muted-foreground rounded-md border p-3 text-sm"
        >
          The deal needed <strong>{formatRupees(outcome.shortfallMinor)}</strong> of campaign
          funding, but only <strong>{formatRupees(outcome.availableCampaignBudgetMinor)}</strong> was
          left in the campaign budget. Raising the per-deal cap alone would not have closed it.
        </p>
      );
    case "shortfall-unrecorded":
      return (
        <p
          data-testid="cap-outcome"
          data-kind={outcome.kind}
          className="text-muted-foreground rounded-md border p-3 text-sm"
        >
          This walk-away was about a binding cap or budget, but this run&apos;s ledger did not record
          the exact shortfall, so no &ldquo;what cap&rdquo; figure can be shown for it.
        </p>
      );
    case "not-cap-related":
      return (
        <p
          data-testid="cap-outcome"
          data-kind={outcome.kind}
          className="text-muted-foreground rounded-md border p-3 text-sm"
        >
          This walk-away was not caused by a cap — no change to the per-deal cap or campaign budget
          would have changed the outcome.
        </p>
      );
  }
}
