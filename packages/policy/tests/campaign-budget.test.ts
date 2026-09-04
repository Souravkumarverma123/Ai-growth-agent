import { describe, expect, it } from "vitest";

import { evaluatePerDealCap } from "../economics";

/**
 * TICKET-107 — per-deal-cap function.
 *
 * Pure, milliseconds-fast, no database (CONTRACTS.md §8: "packages/policy is
 * pure and needs no seam — call it directly"). The real-Postgres concurrency
 * test for the atomic campaign-budget half of this ticket lives in
 * packages/database/tests/campaign-budget-reservation.test.ts.
 *
 * Numbers here reproduce TICKET-507's own worked example verbatim
 * (packages/database/tests/seed.test.ts, "worked example (PRD §18.2)"):
 * perDealCapMinor = 20_000 (₹200), a shortfall of exactly 20_000 passes, and
 * a shortfall of 30_000 fails — even though PRD §18.2 round 3 notes ₹49,800
 * of the ₹50,000 campaign budget would still be unused. That is the point:
 * the per-deal cap binds on its own, never on how much budget remains.
 */

describe("evaluatePerDealCap", () => {
  it("allows a shortfall exactly at the per-deal cap", () => {
    const decision = evaluatePerDealCap(20_000, 20_000);
    expect(decision).toEqual({ allowed: true });
  });

  it("rejects a shortfall one minor unit over the per-deal cap with DILUTION_EXCEEDS_PER_DEAL_CAP", () => {
    const decision = evaluatePerDealCap(20_001, 20_000);
    expect(decision).toEqual({
      allowed: false,
      reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
    });
  });

  it("TICKET-507 worked example: perDealCapMinor = 20_000, shortfall 20_000 is allowed", () => {
    const decision = evaluatePerDealCap(20_000, 20_000);
    expect(decision.allowed).toBe(true);
  });

  it("TICKET-507 worked example: perDealCapMinor = 20_000, shortfall 30_000 fails DILUTION_EXCEEDS_PER_DEAL_CAP even though most of the campaign budget is unused", () => {
    const decision = evaluatePerDealCap(30_000, 20_000);
    expect(decision).toEqual({
      allowed: false,
      reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP",
    });
  });

  it("allows a shortfall of zero", () => {
    expect(evaluatePerDealCap(0, 20_000)).toEqual({ allowed: true });
  });

  it("allows a shortfall well under the cap", () => {
    expect(evaluatePerDealCap(1, 20_000)).toEqual({ allowed: true });
  });

  it("throws rather than silently comparing an unsafe-integer shortfall", () => {
    expect(() => evaluatePerDealCap(Number.MAX_SAFE_INTEGER + 2, 20_000)).toThrow(/safe integer/i);
  });

  it("throws rather than silently comparing an unsafe-integer cap", () => {
    expect(() => evaluatePerDealCap(20_000, Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/i);
  });
});
