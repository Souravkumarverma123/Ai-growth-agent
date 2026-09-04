import type { MinorUnits } from "../contracts/money";
import type { ReasonCode } from "../contracts/reason-codes";

/**
 * TICKET-107 — the per-deal-cap half of the two-cap check (PRD §6.4, §6.5).
 *
 * `packages/policy` is pure (CONTRACTS.md §2, §8): this module never touches
 * a database. The other half of this ticket — the atomic, row-locked
 * campaign-budget check that makes the *joint* budget safe under concurrency
 * — lives in `packages/database/repositories/campaign-holds.ts`, because a
 * row lock is I/O and cannot live here.
 *
 * TICKET-507's already-merged worked example (`packages/database/tests/seed.test.ts`,
 * describe block "worked example (PRD §18.2)") settles a reading that would
 * otherwise be ambiguous: the per-deal cap is a fixed ceiling on the
 * shortfall alone — `shortfallMinor > perDealCapMinor` — independent of how
 * much campaign budget remains. With `perDealCapMinor = 20_000`, a shortfall
 * of exactly `20_000` passes even though it is the entire cap; a shortfall of
 * `30_000` fails even though ₹49,800 of a ₹50,000 campaign budget sits
 * unused, because the per-deal cap is the constraint that binds, not the
 * campaign budget (PRD §18.2, round 3). Only the campaign-budget check
 * depends on `available = total − reserved − committed`; this one never does.
 */
export type PerDealCapDecision =
  | { allowed: true }
  | { allowed: false; reasonCode: Extract<ReasonCode, "DILUTION_EXCEEDS_PER_DEAL_CAP"> };

/**
 * Fails closed on precision loss (CONTRACTS.md §6), same discipline as
 * `contribution.ts`: the money contracts require an integer, not a *safe*
 * one, so a contract-valid caller could still pass a value where `>` no
 * longer distinguishes what it should.
 */
function requireSafeInteger(value: MinorUnits, description: string): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`evaluatePerDealCap: ${description} is not a safe integer (${value})`);
  }
  return value;
}

/**
 * Decides the per-deal-cap outcome from plain numbers only.
 *
 * A shortfall exceeding the per-deal cap walks away even with campaign
 * budget remaining (PRD §17 row 3, §18.2 round 3) — that is the whole point
 * of this being a separate check from the campaign-budget one, with its own
 * reason code.
 */
export function evaluatePerDealCap(
  shortfallMinor: MinorUnits,
  perDealCapMinor: MinorUnits,
): PerDealCapDecision {
  requireSafeInteger(shortfallMinor, "shortfallMinor");
  requireSafeInteger(perDealCapMinor, "perDealCapMinor");

  if (shortfallMinor > perDealCapMinor) {
    return { allowed: false, reasonCode: "DILUTION_EXCEEDS_PER_DEAL_CAP" };
  }

  return { allowed: true };
}
