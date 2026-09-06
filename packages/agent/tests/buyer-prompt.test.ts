import { describe, expect, it } from "vitest";

import { renderBuyerSystemPrompt, type BuyerConstraints } from "../buyer";

/**
 * TICKET-206 acceptance criterion: "The prompt is displayable on screen and
 * visibly contains no script."
 *
 * These assert the rendered string's external shape: it carries the three
 * things it is allowed to (budget, goal, latitude), and none of the things a
 * script or a leak of merchant internals would contain.
 */

const CONSTRAINTS: BuyerConstraints = {
  budgetMinor: 210_000,
  goal: "Buy my usual serum and cleanser without overpaying.",
  latitude: "Push back a couple of times, then take a good offer or walk away.",
};

describe("renderBuyerSystemPrompt", () => {
  const prompt = renderBuyerSystemPrompt(CONSTRAINTS);

  it("contains exactly the three constraint values it is given", () => {
    expect(prompt).toContain(String(CONSTRAINTS.budgetMinor));
    expect(prompt).toContain(CONSTRAINTS.goal);
    expect(prompt).toContain(CONSTRAINTS.latitude);
  });

  it("tells the buyer to keep its budget private", () => {
    expect(prompt.toLowerCase()).toMatch(/never state it|keep this figure to yourself/);
  });

  it("says there is no script and no required outcome", () => {
    expect(prompt.toLowerCase()).toContain("no script");
    expect(prompt.toLowerCase()).toContain("no required outcome");
  });

  it("reveals nothing about the merchant's engine — no floors, tiers, curve, campaign budget or per-deal cap", () => {
    const lower = prompt.toLowerCase();
    for (const forbidden of [
      "floor",
      "tier",
      "concession",
      "curve",
      "campaign",
      "per-deal",
      "counterfactual",
      "candidate",
      "reservation price",
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("contains no step-by-step script (no numbered or 'first/then' plan, no target price)", () => {
    // A script would read like an ordered plan or name a concrete target.
    expect(prompt.toLowerCase()).not.toMatch(/step \d|round \d|first,|then offer|then counter|aim for|target (?:price|of)|offer exactly/);
    // Only one number may appear: the budget itself.
    const numbers = prompt.match(/\d[\d,]*/g) ?? [];
    expect(numbers).toEqual([String(CONSTRAINTS.budgetMinor)]);
  });

  it("is short enough to read on screen at a glance", () => {
    expect(prompt.split("\n").length).toBeLessThanOrEqual(16);
  });
});
