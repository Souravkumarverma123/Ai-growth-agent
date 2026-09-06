import { describe, expect, it } from "vitest";

import {
  CLOSING_RUN,
  WALK_AWAY_RUN,
  runDemoNegotiation,
  runDocumentedDemoNegotiations,
} from "../demo";

/**
 * TICKET-206 — required test: "Two seeded runs produce the two documented
 * outcomes."
 *
 * The two runs ({@link CLOSING_RUN}, {@link WALK_AWAY_RUN}) share a goal, a
 * latitude, a seed and the whole reference scenario — only the hidden
 * `budgetMinor` differs. That one difference must flip a closing negotiation
 * into a walk-away (PRD §18.1: "materially different endings — one closing,
 * one walking away").
 *
 * Assertions are on external outcomes — what the negotiation ended as, what
 * the buyer accepted, what was said — never on internal call structure
 * (CONTRACTS.md §8).
 */

const buyerTurns = (transcript: readonly { role: string; content: string }[]) =>
  transcript.filter((turn) => turn.role === "buyer").map((turn) => turn.content);

describe("the two documented demo runs", () => {
  it("only the hidden budget differs between the two configs", () => {
    expect(CLOSING_RUN.seed).toBe(WALK_AWAY_RUN.seed);
    expect(CLOSING_RUN.constraints.goal).toBe(WALK_AWAY_RUN.constraints.goal);
    expect(CLOSING_RUN.constraints.latitude).toBe(WALK_AWAY_RUN.constraints.latitude);
    expect(CLOSING_RUN.constraints.budgetMinor).not.toBe(WALK_AWAY_RUN.constraints.budgetMinor);
  });

  it("the higher-budget run closes — on the campaign-funded Tier 2 offer it can afford", async () => {
    const result = await runDemoNegotiation(CLOSING_RUN);

    expect(result.outcome).toBe("CLOSED");
    expect(result.settledOffer).not.toBeNull();
    expect(result.settledOffer!.totalMinor).toBeLessThanOrEqual(CLOSING_RUN.constraints.budgetMinor);
    // It refused the first (Tier 1) offer and took the second (Tier 2) one.
    expect(result.rounds).toBe(2);
    expect(result.settledOffer!.tier).toBe(2);
    expect(result.settledOffer!.campaignSpendMinor).toBeGreaterThan(0);
  });

  it("the lower-budget run walks away when the per-deal cap blocks a deeper discount", async () => {
    const result = await runDemoNegotiation(WALK_AWAY_RUN);

    expect(result.outcome).toBe("WALKED_AWAY");
    expect(result.settledOffer).toBeNull();
    // Every offer was over this buyer's budget.
    for (const offer of result.merchantOffers) {
      expect(offer.totalMinor).toBeGreaterThan(WALK_AWAY_RUN.constraints.budgetMinor);
    }
    // A Tier 2 offer WAS reached (the buyer could have afforded a different
    // limit), and the final round fell back to Tier 1 — the cap bound.
    expect(result.merchantOffers.some((offer) => offer.tier === 2)).toBe(true);
    expect(result.merchantOffers.at(-1)!.tier).toBe(1);
  });

  it("the two runs end differently", async () => {
    const { closing, walkAway } = await runDocumentedDemoNegotiations();
    expect(closing.outcome).toBe("CLOSED");
    expect(walkAway.outcome).toBe("WALKED_AWAY");
    expect(closing.outcome).not.toBe(walkAway.outcome);
  });
});

describe("the merchant agent never receives the reservation price", () => {
  it("no buyer message in either transcript contains a digit or the budget figure", async () => {
    const { closing, walkAway } = await runDocumentedDemoNegotiations();

    for (const [run, budget] of [
      [closing, CLOSING_RUN.constraints.budgetMinor],
      [walkAway, WALK_AWAY_RUN.constraints.budgetMinor],
    ] as const) {
      for (const message of buyerTurns(run.transcript)) {
        expect(message).not.toMatch(/\d/);
        expect(message).not.toContain(String(budget));
      }
    }
  });
});

describe("a demo run is fully reproducible", () => {
  it("the same config produces the identical transcript every time", async () => {
    const a = await runDemoNegotiation(CLOSING_RUN);
    const b = await runDemoNegotiation(CLOSING_RUN);
    expect(a.transcript).toEqual(b.transcript);
    expect(a.settledOffer?.totalMinor).toBe(b.settledOffer?.totalMinor);
  });

  it("exposes the buyer's script-free system prompt on the result", async () => {
    const result = await runDemoNegotiation(CLOSING_RUN);
    expect(result.buyerSystemPrompt).toContain("no script");
    expect(result.buyerSystemPrompt.toLowerCase()).not.toContain("floor");
    expect(result.buyerSystemPrompt.toLowerCase()).not.toContain("tier");
  });
});
