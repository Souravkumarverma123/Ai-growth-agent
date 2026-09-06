"use client";

import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

/**
 * The shared shell for the merchant's read-only "watch" screens (ISSUE-019).
 *
 * The live event stream (TICKET-502), the campaign budget countdown
 * (TICKET-503) and the audit trail (TICKET-505) were each told to mirror
 * TICKET-502 and had grown near-identical copies of the same poll chrome:
 * the `2_000` ms interval, the header status line with the spinning
 * `RefreshCw` + `aria-live` label, the inline `AlertCircle` error line, and
 * the "Last checked …" footer. This module is that chrome, written once.
 *
 * Presentational only. Each screen keeps its own tRPC query, its own
 * `refetchInterval` policy, and its own decision about what to show while an
 * error is outstanding (blank vs keep-last-good) — that part genuinely
 * differs between a per-session stream and a merchant-global figure.
 */

export const MERCHANT_POLL_INTERVAL_MS = 2_000;

/** Whole seconds, for the "Refreshes every Ns" copy each screen writes. */
export const MERCHANT_POLL_INTERVAL_SECONDS = Math.round(MERCHANT_POLL_INTERVAL_MS / 1000);

export type PollStatus = "live" | "refreshing" | "settled";

const POLL_STATUS_LABEL: Record<PollStatus, string> = {
  live: "Live",
  refreshing: "Refreshing",
  settled: "Settled",
};

/**
 * Map a query's flags to the status pill. `isSettled` wins — a finished
 * negotiation is no longer "Live" even mid-refetch; screens with no terminal
 * state (the campaign budget) just never pass it.
 */
export function pollStatus(isFetching: boolean, isSettled = false): PollStatus {
  if (isSettled) return "settled";
  return isFetching ? "refreshing" : "live";
}

export function PollCard({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: ReactNode;
  status: PollStatus;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <span
            className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs"
            aria-live="polite"
          >
            <RefreshCw className={cn("size-3", status === "refreshing" && "animate-spin")} />
            {POLL_STATUS_LABEL[status]}
          </span>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * The inline error line. Each screen supplies its own wording (it names the
 * thing that failed to load) as children; the icon and styling are shared.
 * `size` picks between the full-panel error and the smaller stale-refresh
 * note a keep-last-good screen shows under its figures.
 */
export function PollError({
  children,
  size = "md",
}: {
  children: ReactNode;
  size?: "md" | "sm";
}) {
  return (
    <p
      className={cn(
        "text-destructive flex items-center gap-2",
        size === "md" ? "text-sm" : "mt-4 text-[11px]",
      )}
    >
      <AlertCircle className={size === "md" ? "size-4" : "size-3"} />
      {children}
    </p>
  );
}

/** "Last checked HH:MM:SS" — rendered only once a poll has actually landed. */
export function PollLastChecked({ at }: { at: number }) {
  if (at <= 0) return null;
  return (
    <p className="text-muted-foreground mt-4 text-[11px]">
      Last checked {new Date(at).toLocaleTimeString()}
    </p>
  );
}
