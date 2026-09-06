import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OfferStatusPanel } from "~/app/merchant/sessions/[sessionId]/offers/offer-status-panel";
import { toOfferStatusView, type SessionOffer } from "~/lib/offer-status";

/**
 * TICKET-504 — "TTL counts down and the offer visibly expires";
 * "Expiry reflected in the UI state."
 *
 * The clock is an explicit argument to the pure shaper, so "the offer
 * visibly expires" is a re-render with `now` advanced past `expiresAt` — no
 * timers, no waiting. The API half (`merchant.getSessionOffers` reports the
 * fields these rows are built from) is proven against a real Postgres in
 * `packages/trpc/tests/session-offers.test.ts`.
 */

const MINT_MS = Date.parse("2026-09-06T10:00:00.000Z");
const TTL_MS = 600_000; // PRD §10 — mint + 600s
const EXPIRES_MS = MINT_MS + TTL_MS;

function offer(overrides: Partial<SessionOffer> = {}): SessionOffer {
  return {
    offerId: overrides.offerId ?? "offer-1",
    roundIndex: overrides.roundIndex ?? 1,
    tier: overrides.tier ?? 2,
    status: overrides.status ?? "PENDING",
    totalMinor: overrides.totalMinor ?? 302_000,
    campaignSpendMinor: overrides.campaignSpendMinor ?? 30_000,
    currency: overrides.currency ?? "INR",
    reasonCode: overrides.reasonCode ?? "DILUTION_WITHIN_CAPS",
    createdAt: overrides.createdAt !== undefined ? overrides.createdAt : new Date(MINT_MS).toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(EXPIRES_MS).toISOString(),
    consumedAt: overrides.consumedAt !== undefined ? overrides.consumedAt : null,
  };
}

describe("toOfferStatusView", () => {
  it("reports a live offer with the TTL counting down from expiresAt", () => {
    const view = toOfferStatusView([offer()], MINT_MS + 60_000);
    const row = view.current!;
    expect(row.lifecycle).toBe("live");
    expect(row.isPerishing).toBe(true);
    expect(row.remainingMs).toBe(TTL_MS - 60_000);
    expect(row.remainingLabel).toBe("9:00");
    expect(row.remainingFraction).toBeCloseTo(0.9, 5);
    expect(view.isSettled).toBe(false);
  });

  it("flips the offer to expired once now passes expiresAt", () => {
    const before = toOfferStatusView([offer()], EXPIRES_MS - 1_000);
    expect(before.current!.lifecycle).toBe("live");

    const after = toOfferStatusView([offer()], EXPIRES_MS + 1_000);
    expect(after.current!.lifecycle).toBe("expired");
    expect(after.current!.isPerishing).toBe(false);
    expect(after.current!.remainingMs).toBe(0);
    expect(after.current!.remainingLabel).toBe("0:00");
    expect(after.current!.remainingFraction).toBe(0);
    // An expired offer alone is not "settled" — a later round may mint another.
    expect(after.isSettled).toBe(false);
  });

  it("treats a consumed offer as accepted even before its TTL elapses", () => {
    const view = toOfferStatusView(
      [offer({ consumedAt: new Date(MINT_MS + 120_000).toISOString() })],
      MINT_MS + 130_000,
    );
    expect(view.current!.lifecycle).toBe("accepted");
    expect(view.isSettled).toBe(true);
  });

  it("treats a DECLINED read-model status as declined", () => {
    const view = toOfferStatusView([offer({ status: "DECLINED" })], MINT_MS + 10_000);
    expect(view.current!.lifecycle).toBe("declined");
    expect(view.isSettled).toBe(true);
  });

  it("orders offers newest round first and leads with the newest", () => {
    const view = toOfferStatusView(
      [
        offer({ offerId: "r1", roundIndex: 1, tier: 1 }),
        offer({ offerId: "r2", roundIndex: 2, tier: 2 }),
      ],
      MINT_MS + 10_000,
    );
    expect(view.rows.map((r) => r.roundIndex)).toEqual([2, 1]);
    expect(view.current!.offerId).toBe("r2");
  });

  it("falls back to a full TTL bar when createdAt is unknown and the offer is live", () => {
    const view = toOfferStatusView([offer({ createdAt: null })], MINT_MS + 60_000);
    expect(view.current!.remainingFraction).toBe(1);
  });
});

describe("OfferStatusPanel", () => {
  function panelFor(now: number, offers: SessionOffer[] = [offer()], props = {}) {
    return <OfferStatusPanel view={toOfferStatusView(offers, now)} {...props} />;
  }

  it("shows the offer perishing and then visibly expiring", () => {
    const { rerender } = render(panelFor(MINT_MS + 60_000));

    expect(screen.getByTestId("offer-status-label")).toHaveTextContent("Live");
    expect(screen.getByTestId("offer-ttl")).toHaveTextContent("9:00");

    // A minute later — the countdown has moved.
    rerender(panelFor(MINT_MS + 120_000));
    expect(screen.getByTestId("offer-ttl")).toHaveTextContent("8:00");

    // Past the TTL — the offer visibly expires.
    rerender(panelFor(EXPIRES_MS + 5_000));
    expect(screen.getByTestId("offer-status-label")).toHaveTextContent("Expired");
    expect(screen.getByTestId("offer-ttl")).toHaveTextContent("0:00");
    expect(screen.getByTestId("offer-ttl-bar")).toHaveStyle({ width: "0.00%" });
  });

  it("shows tier and campaign spend for a Tier 2 offer", () => {
    render(panelFor(MINT_MS + 60_000, [offer({ tier: 2, campaignSpendMinor: 30_000 })]));
    expect(screen.getByText("Tier 2")).toBeInTheDocument();
    expect(screen.getByTestId("offer-campaign-spend")).toHaveTextContent("₹300.00");
  });

  it("shows no campaign spend for a Tier 1 offer", () => {
    render(
      panelFor(MINT_MS + 60_000, [
        offer({ tier: 1, campaignSpendMinor: 0, reasonCode: "TIER1_OFFERED" }),
      ]),
    );
    expect(screen.getByText("Tier 1")).toBeInTheDocument();
    expect(screen.getByTestId("offer-campaign-spend")).toHaveTextContent("—");
  });

  it("renders the reason code the offer was minted with, verbatim", () => {
    render(panelFor(MINT_MS + 60_000));
    expect(screen.getByText("DILUTION_WITHIN_CAPS")).toBeInTheDocument();
  });

  it("lists earlier offers below the current one", () => {
    render(
      panelFor(EXPIRES_MS + 5_000, [
        offer({ offerId: "r1", roundIndex: 1, tier: 1, reasonCode: "TIER1_OFFERED" }),
        offer({ offerId: "r2", roundIndex: 2, tier: 2 }),
      ]),
    );
    expect(screen.getByText("Earlier offers this session")).toBeInTheDocument();
    const earlier = document.querySelector('[data-offer-id="r1"]') as HTMLElement;
    expect(within(earlier).getByText("TIER1_OFFERED")).toBeInTheDocument();
  });

  it("renders loading and error states when there is no view yet", () => {
    const { rerender } = render(<OfferStatusPanel view={null} isLoading />);
    expect(screen.getByText(/Loading offer/)).toBeInTheDocument();

    rerender(<OfferStatusPanel view={null} isError errorMessage="boom" />);
    expect(screen.getByText(/Could not load the offer: boom/)).toBeInTheDocument();
  });

  it("shows an empty state when the session has minted no offer", () => {
    render(<OfferStatusPanel view={toOfferStatusView([], MINT_MS)} />);
    expect(screen.getByText(/No offer minted yet/)).toBeInTheDocument();
  });

  it("keeps the last known status on screen when a background refresh fails", () => {
    render(
      <OfferStatusPanel
        view={toOfferStatusView([offer()], MINT_MS + 60_000)}
        isError
        errorMessage="network down"
      />,
    );
    expect(screen.getByTestId("offer-status-label")).toHaveTextContent("Live");
    expect(screen.getByTestId("offer-ttl")).toHaveTextContent("9:00");
    expect(screen.getByText(/Last refresh failed: network down/)).toBeInTheDocument();
  });
});
