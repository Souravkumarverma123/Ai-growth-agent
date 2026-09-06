import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CampaignBudgetPanel } from "~/app/merchant/budget/campaign-budget-countdown";
import {
  toCampaignBudgetView,
  type CampaignBudgetSnapshot,
} from "~/lib/campaign-budget";

/**
 * TICKET-503 — "Display matches engine state across a hold lifecycle."
 *
 * The lifecycle here is the one the acceptance criterion names: a Tier 2
 * offer is minted (reserved rises, available falls), then it expires
 * (reserved returns to zero, available is restored). The snapshots are what
 * `merchant.getCampaignBudget` returns at each step — the tRPC side is proven
 * against a real Postgres in `packages/trpc/tests/campaign-budget.test.ts`.
 */

function snapshot(overrides: Partial<CampaignBudgetSnapshot> = {}): CampaignBudgetSnapshot {
  const totalMinor = overrides.totalMinor ?? 5_000_000;
  const reservedMinor = overrides.reservedMinor ?? 0;
  const committedMinor = overrides.committedMinor ?? 0;
  return {
    totalMinor,
    reservedMinor,
    committedMinor,
    availableMinor: overrides.availableMinor ?? totalMinor - reservedMinor - committedMinor,
  };
}

const BEFORE_MINT = snapshot();
const AFTER_TIER2_MINT = snapshot({ reservedMinor: 300_000 });
const AFTER_EXPIRY = snapshot();
const AFTER_CAPTURE = snapshot({ committedMinor: 300_000 });

describe("toCampaignBudgetView", () => {
  it("derives outstanding and available = total - reserved - committed", () => {
    const view = toCampaignBudgetView(snapshot({ reservedMinor: 300_000, committedMinor: 150_000 }));
    expect(view.outstandingMinor).toBe(450_000);
    expect(view.availableMinor).toBe(5_000_000 - 450_000);
  });

  it("orders the segments committed, reserved, available with fractions of total", () => {
    const view = toCampaignBudgetView(snapshot({ reservedMinor: 1_000_000, committedMinor: 500_000 }));
    expect(view.segments.map((s) => s.key)).toEqual(["committed", "reserved", "available"]);
    expect(view.segments.map((s) => s.fraction)).toEqual([0.1, 0.2, 0.7]);
  });

  it("guards against a zero total instead of dividing by zero", () => {
    const view = toCampaignBudgetView(snapshot({ totalMinor: 0 }));
    expect(view.segments.every((s) => s.fraction === 0)).toBe(true);
  });

  it("clamps every segment fraction into [0, 1] for any input (the API schema keeps live data in range; this is pure-function defensiveness)", () => {
    const view = toCampaignBudgetView({
      totalMinor: 1_000_000,
      reservedMinor: 1_400_000,
      committedMinor: 0,
      availableMinor: -400_000,
    });
    const reserved = view.segments.find((s) => s.key === "reserved")!;
    const available = view.segments.find((s) => s.key === "available")!;
    expect(reserved.fraction).toBe(1);
    expect(available.fraction).toBe(0);
  });
});

describe("CampaignBudgetPanel", () => {
  /** The user-facing summary the merchant reads off the card. */
  function summary() {
    return screen.getByRole("img", { name: /available of/ }).getAttribute("aria-label");
  }

  /** The rupee figure shown for one breakdown segment. */
  function figure(key: "committed" | "reserved" | "available") {
    const cell = document.querySelector(`[data-figure="${key}"]`) as HTMLElement;
    return within(cell).getByText(/₹/).textContent;
  }

  it("matches engine state as a Tier 2 hold is reserved and then expires", () => {
    const { rerender } = render(<CampaignBudgetPanel view={toCampaignBudgetView(BEFORE_MINT)} />);
    expect(summary()).toBe(
      "₹50,000.00 available of ₹50,000.00 total; ₹0.00 reserved, ₹0.00 committed",
    );

    // Tier 2 offer minted: reserved rises, available falls.
    rerender(<CampaignBudgetPanel view={toCampaignBudgetView(AFTER_TIER2_MINT)} />);
    expect(summary()).toBe(
      "₹47,000.00 available of ₹50,000.00 total; ₹3,000.00 reserved, ₹0.00 committed",
    );
    expect(figure("reserved")).toBe("₹3,000.00");
    expect(figure("available")).toBe("₹47,000.00");

    // Offer expires: reserved returns to zero, available restored.
    rerender(<CampaignBudgetPanel view={toCampaignBudgetView(AFTER_EXPIRY)} />);
    expect(summary()).toBe(
      "₹50,000.00 available of ₹50,000.00 total; ₹0.00 reserved, ₹0.00 committed",
    );
  });

  it("shows a committed hold as spent, not available", () => {
    render(<CampaignBudgetPanel view={toCampaignBudgetView(AFTER_CAPTURE)} />);
    expect(figure("committed")).toBe("₹3,000.00");
    expect(figure("available")).toBe("₹47,000.00");
    expect(figure("reserved")).toBe("₹0.00");
  });

  it("sizes the stacked bar segments in proportion to total", () => {
    render(<CampaignBudgetPanel view={toCampaignBudgetView(AFTER_TIER2_MINT)} />);
    const widthPct = (key: string) =>
      parseFloat((document.querySelector(`[data-segment="${key}"]`) as HTMLElement).style.width);
    expect(widthPct("committed")).toBeCloseTo(0, 5);
    expect(widthPct("reserved")).toBeCloseTo(6, 5);
    expect(widthPct("available")).toBeCloseTo(94, 5);
  });

  it("renders loading and error states when there is no snapshot yet", () => {
    const { rerender } = render(<CampaignBudgetPanel view={null} />);
    expect(screen.getByText(/Loading campaign budget/)).toBeInTheDocument();

    rerender(<CampaignBudgetPanel view={null} isError errorMessage="boom" />);
    expect(screen.getByText(/Could not load the campaign budget: boom/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /available of/ })).not.toBeInTheDocument();
  });

  it("keeps the last good figures on screen when a background refresh fails", () => {
    render(
      <CampaignBudgetPanel
        view={toCampaignBudgetView(AFTER_TIER2_MINT)}
        isError
        errorMessage="network down"
      />,
    );

    // The figures are still shown, not replaced by a full error panel.
    expect(figure("available")).toBe("₹47,000.00");
    expect(figure("reserved")).toBe("₹3,000.00");
    // …with the refresh failure surfaced inline.
    expect(screen.getByText(/Last refresh failed: network down/)).toBeInTheDocument();
  });
});
