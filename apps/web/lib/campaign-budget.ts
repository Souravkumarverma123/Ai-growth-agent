/**
 * TICKET-503 — Campaign budget countdown.
 *
 * The pure shaping layer between `merchant.getCampaignBudget` and the
 * merchant's read-only countdown card. Splitting it out keeps the React
 * component a plain render of `CampaignBudgetView` and lets "the display
 * matches engine state across a hold lifecycle" be a runner-light assertion
 * (see `tests/campaign-budget.test.tsx`).
 *
 * Money stays in minor units here (CONTRACTS.md §3 — rupees are formatted
 * only at the React render boundary); every field carries `…Minor` and the
 * component calls `formatRupees`.
 *
 * `available = total − reserved − committed` (PRD §6.5). The engine
 * (`reserveCampaignBudget`, TICKET-107) never lets outstanding exceed total,
 * and `merchant.getCampaignBudget`'s output schema rejects a negative figure
 * before it reaches the client — so on live data every fraction is already in
 * `[0, 1]`. `toCampaignBudgetView` is a plain pure function, though: the bar
 * math clamps so any caller (a test, a future consumer) gets a drawable
 * segment set rather than a width outside the track.
 */

import type { RouterOutputs } from "@repo/trpc/client";

export type CampaignBudgetSnapshot = RouterOutputs["merchant"]["getCampaignBudget"];

export type CampaignBudgetSegmentKey = "committed" | "reserved" | "available";

export type CampaignBudgetSegment = {
  key: CampaignBudgetSegmentKey;
  label: string;
  amountMinor: number;
  /** Share of `total`, clamped to `[0, 1]`. Zero total → zero. */
  fraction: number;
};

export type CampaignBudgetView = {
  totalMinor: number;
  reservedMinor: number;
  committedMinor: number;
  availableMinor: number;
  /** reserved + committed — the part of the budget already spoken for. */
  outstandingMinor: number;
  /**
   * The stacked-bar segments, always in this order: committed (permanent
   * spend), reserved (provisional Tier 2 holds), available (what is left).
   */
  segments: CampaignBudgetSegment[];
};

const SEGMENT_LABELS: Record<CampaignBudgetSegmentKey, string> = {
  committed: "Committed",
  reserved: "Reserved",
  available: "Available",
};

function fractionOf(amountMinor: number, totalMinor: number): number {
  if (totalMinor <= 0) return 0;
  const raw = amountMinor / totalMinor;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

export function toCampaignBudgetView(snapshot: CampaignBudgetSnapshot): CampaignBudgetView {
  const { totalMinor, reservedMinor, committedMinor, availableMinor } = snapshot;

  const segments: CampaignBudgetSegment[] = (
    [
      { key: "committed", amountMinor: committedMinor },
      { key: "reserved", amountMinor: reservedMinor },
      { key: "available", amountMinor: availableMinor },
    ] as const
  ).map(({ key, amountMinor }) => ({
    key,
    label: SEGMENT_LABELS[key],
    amountMinor,
    fraction: fractionOf(amountMinor, totalMinor),
  }));

  return {
    totalMinor,
    reservedMinor,
    committedMinor,
    availableMinor,
    outstandingMinor: reservedMinor + committedMinor,
    segments,
  };
}
