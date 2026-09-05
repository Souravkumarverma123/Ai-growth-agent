import type { ReasonCode } from "../contracts/reason-codes";

/**
 * TICKET-105 — concession curve and round envelope (PRD §7, §16 RA-4;
 * CONTRACTS.md B4).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, GIVEN CANDIDATES.TS ALREADY HAD THE ARITHMETIC
 * ============================================================================
 * TICKET-103's generator (`./candidates.ts`) computed the round envelope
 * inline in a function of this same name, because TICKET-105 wasn't done yet
 * and TICKET-103's own dependency list didn't require it to wait. Its module
 * doc said so explicitly: "If TICKET-105 later lands, extracting this into a
 * shared function is a normal refactor, not rework of this ticket." This file
 * is that refactor — `resolveConcessionFraction` below is the same arithmetic,
 * unchanged, now with its own home and its own tests. `candidates.ts` has been
 * updated to import it rather than define it.
 *
 * ============================================================================
 * TWO FUNCTIONS, NOT ONE — "round envelope" and "round cap" are different
 * questions with different callers
 * ============================================================================
 * PRD §7 / RA-4: "the round envelope IS the concession curve" — a pure
 * fraction-of-headroom calculation with no notion of "too many rounds."
 * PRD §14 / §15 (state-machine.ts's frozen TRANSITIONS table): a SEPARATE
 * guard, `roundIndex > maxRounds`, on the `ROUND_INCREMENTED` event, walks the
 * session away with `ROUND_LIMIT_REACHED`. These are not the same check:
 *
 *  - `resolveConcessionFraction` answers "how much headroom does round n
 *    release", and — deliberately, unchanged from TICKET-103 — CLAMPS to the
 *    curve's own final (and, by PRD §5.1 construction, maximum) fraction for
 *    any round beyond the curve's length, rather than throwing. It has to:
 *    `packages/policy` is pure and has no session to halt, and a caller may
 *    reasonably ask "what would round 7 release" for logging or a what-if
 *    calculation without that question itself being an error.
 *  - `evaluateRoundCap` answers the different question "is this round
 *    reachable at all", and is the pure decision half of the state machine's
 *    `ROUND_LIMIT_REACHED` guard — the same shape as
 *    `economics/campaign-budget.ts`'s `evaluatePerDealCap`: a small, separate,
 *    pure yes/no function a database-backed caller runs BEFORE it ever asks
 *    for a concession fraction or calls `generateCandidates`, so that "round 4
 *    is impossible" is enforced by the orchestration layer refusing to take
 *    the next round at all, not by this module refusing to compute one.
 *
 * Note the curve length (3 entries, `[0.4, 0.7, 1.0]`, PRD §5.1) and
 * `maxRounds` (a merchant-set field, `contracts/merchant-policy.ts`) are two
 * independently-sourced numbers that happen to agree in the PRD's standard
 * config. `evaluateRoundCap` is deliberately written against `maxRounds` —
 * the authoritative cap per state-machine.ts — never against the curve's own
 * `.length`, so a merchant policy with a different `maxRounds` is still
 * enforced correctly even though `resolveConcessionFraction` would keep
 * clamping to the curve's last entry past that point.
 *
 * ============================================================================
 * INJECTION RESISTANCE (PRD §7's "the curve is identical regardless of any
 * message content")
 * ============================================================================
 * Neither function below takes a conversation-shaped parameter, or any
 * parameter at all beyond plain numbers already sourced from merchant policy
 * and session state. There is no field through which buyer text could even be
 * threaded — see the accompanying test file for the behavioural proof this
 * requires (CONTRACTS.md §8: assert external behaviour, not structure).
 */

/**
 * The round's economic envelope (RA-4): the fraction of floor-derived
 * headroom the concession curve permits releasing this round. Clamped —
 * never thrown — for a round beyond the curve's own length: round-cap
 * enforcement (`ROUND_LIMIT_REACHED`) is `evaluateRoundCap`'s job, not this
 * one's, so this function stays usable for whatever round it's asked about.
 * Clamping to the curve's *final* (and by construction maximum, PRD §5.1)
 * fraction never releases more than the merchant ever authorized for any
 * round — it only ever reuses an already-approved ceiling.
 */
export function resolveConcessionFraction(concessionCurve: readonly number[], roundIndex: number): number {
  if (!Number.isInteger(roundIndex) || roundIndex < 1) {
    throw new Error(`resolveConcessionFraction: roundIndex must be a positive integer, got ${roundIndex}`);
  }
  if (concessionCurve.length === 0) {
    throw new Error("resolveConcessionFraction: policy.concessionCurve must not be empty");
  }
  const index = Math.min(roundIndex, concessionCurve.length) - 1;
  const fraction = concessionCurve[index];
  if (fraction === undefined) {
    throw new Error("resolveConcessionFraction: unreachable — resolved concession index out of bounds");
  }
  return fraction;
}

/**
 * The pure round-cap decision (PRD §14, §15's `ROUND_INCREMENTED` /
 * `ROUND_LIMIT_REACHED` row): mirrors `evaluatePerDealCap`
 * (`economics/campaign-budget.ts`) — a small pure yes/no function, separate
 * from the fraction/candidate-building logic, that a database-backed caller
 * runs before taking the next round. Compared against `maxRounds` (a
 * merchant-set field on `MerchantPolicy`, not the curve's own length) per
 * state-machine.ts's frozen guard `roundIndex > maxRounds`.
 */
export type RoundCapDecision =
  | { allowed: true }
  | { allowed: false; reasonCode: Extract<ReasonCode, "ROUND_LIMIT_REACHED"> };

export function evaluateRoundCap(roundIndex: number, maxRounds: number): RoundCapDecision {
  if (!Number.isInteger(roundIndex) || roundIndex < 1) {
    throw new Error(`evaluateRoundCap: roundIndex must be a positive integer, got ${roundIndex}`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`evaluateRoundCap: maxRounds must be a positive integer, got ${maxRounds}`);
  }

  if (roundIndex > maxRounds) {
    return { allowed: false, reasonCode: "ROUND_LIMIT_REACHED" };
  }

  return { allowed: true };
}
