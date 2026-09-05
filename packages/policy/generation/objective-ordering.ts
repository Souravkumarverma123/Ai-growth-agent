import type { MinorUnits } from "../contracts/money";
import type { TieredCandidate } from "./tiering";

/**
 * TICKET-109 — objective ordering and slow-moving tolerance (PRD §6.6;
 * Settled by Q10, Q11, Q13, Q21, Q22, Q29).
 *
 * ============================================================================
 * WHAT THIS PICKS FROM, AND WHAT IT DOESN'T RE-CHECK
 * ============================================================================
 * PRD §6.6's rule 1 — "never dilutive unless funded" — is a hard constraint,
 * not a preference, and it is already enforced by TICKET-104's
 * `assignTiersAndFeasibility`: every candidate in its `selectableCandidates`
 * is either Tier 1 (never dilutive) or a feasible, unlocked Tier 2 (funded
 * within cap and budget). This module's only job is rule 2 and rule 3 — the
 * ordering *within* that already-constrained set. It takes
 * `readonly TieredCandidate[]` rather than re-deriving feasibility itself,
 * so a caller is expected to pass `selectableCandidates`, not the whole
 * tiered array (passing the whole array would let an infeasible or
 * still-locked Tier 2 candidate win a comparison it was never eligible for
 * in the first place — this function has no way to detect that misuse, the
 * same seam `mintOffer` documents for its own `candidatesInRound` parameter).
 *
 * ============================================================================
 * A STATED LEXICOGRAPHIC RULE, NEVER A WEIGHTED SCORE (acceptance criterion)
 * ============================================================================
 * PRD §6.6:
 *   2. Highest contribution wins — unless a slow-moving candidate is within
 *      3% of the best contribution, in which case it is preferred.
 *   3. Tiebreak on lowest campaign spend.
 *
 * A weighted score (e.g. `contribution - penalty * distanceFromBest`) would
 * let enough slow-moving inventory silently outweigh an arbitrarily large
 * contribution gap, and it would not be auditable as a stated rule — a
 * merchant reading the policy screen could not predict the outcome without
 * knowing the weights. This module instead compares candidates key by key,
 * each key fully deciding the comparison before the next is ever consulted:
 *
 *   1. In-tolerance-band slow-moving candidates outrank every candidate
 *      outside the band, full stop — never partially, never traded off
 *      against how far outside the band the other candidate's contribution
 *      is. ("In-tolerance-band" and "slow-moving" are ANDed: a slow-moving
 *      candidate outside the 3% band, or an in-band candidate that isn't
 *      slow-moving, both fall through to key 2 like anything else.)
 *   2. Within either bucket, highest `contributionMinor` wins.
 *   3. Then lowest `requiredCampaignSpendMinor` wins (PRD §6.5: this field
 *      already equals the exact contribution loss a Tier 2 candidate would
 *      cost the campaign budget; always 0 for Tier 1, so this key can only
 *      ever discriminate between Tier 2 candidates, or leave Tier 1
 *      candidates tied at 0 for the next key).
 *   4. A final tiebreak on the candidate's own `moveType` then a canonical
 *      JSON encoding of its `basket` — not because PRD §6.6 specifies a
 *      fourth key, but because §6.6 stops at "lowest campaign spend" and two
 *      genuinely distinct candidates can still tie on both contribution and
 *      spend (e.g. two different ADD_SKU candidates priced identically).
 *      Without a further key, which of them wins would depend on the input
 *      array's own order — this key makes the total order depend only on
 *      candidate content, so `selectCandidate` returns the identical
 *      candidate regardless of what order the caller's array happens to be
 *      in (this ticket's "ordering determinism" requirement). Two candidates
 *      that tie all the way through key 4 are byte-for-byte identical in
 *      every field this module reads, so it does not matter which is
 *      returned.
 *
 * ============================================================================
 * THE 3% TOLERANCE BAND — WHY IT'S FIXED, AND WHY THE CHECK IS INTEGER-EXACT
 * ============================================================================
 * "The 3% slow-moving tolerance is fixed and disclosed in the merchant
 * policy screen as a stated rule" (PRD §6.6) — merchants see the number 3,
 * they cannot configure it, so it is a literal constant here, not a
 * `MerchantPolicy` field. `contributionMinor` is always a nonnegative
 * integer (`minorUnitsSchema`, contracts/money.ts), so "gap is at most 3% of
 * best" is checked as `gapMinor <= floor(bestContributionMinor * 3 / 100)`.
 * That threshold is computed via `floorPercentOfMinorUnits`, never as the
 * direct product `bestContributionMinor * 3`: `bestContributionMinor` is
 * only guaranteed to be a *safe* integer (up to ~9.007e15), and multiplying
 * a value past ~3.0e15 by 3 overflows that guarantee, silently landing on
 * the nearest representable double instead of the exact product — which can
 * flip a boundary-exact comparison the wrong way. `floorPercentOfMinorUnits`
 * instead splits the value into an exact `quotient*100 + remainder` first
 * (via `%`, exact for safe integers), so only `quotient * 3` and
 * `remainder * 3` — both far smaller than the original value — are ever
 * multiplied.
 */

/** Fixed, not configurable (PRD §6.6) — disclosed to merchants as a stated
 *  rule, never surfaced as a policy field a merchant could edit. */
export const SLOW_MOVING_TOLERANCE_PERCENT = 3;

function requireSafeInteger(value: number, description: string): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`selectCandidate: ${description} is not a safe integer (${value})`);
  }
  return value;
}

/**
 * `floor(valueMinor * percent / 100)`, computed without ever multiplying
 * `valueMinor` directly by `percent`. `valueMinor` is only guaranteed to be a
 * *safe* integer (`Number.isSafeInteger`, up to ~9.007e15) — multiplying a
 * value past ~3.0e15 by 3 can exceed that bound, silently landing on the
 * nearest representable double instead of the exact product. Splitting
 * `valueMinor` into an exact `quotient*100 + remainder` first (`%` is exact
 * for safe integers) keeps every multiplication far smaller than the
 * original value: `quotient * percent` (quotient is `valueMinor / 100`, so
 * at most ~9.007e13) and `remainder * percent` (remainder is under 100).
 *
 * For integer `gapMinor`, `gapMinor <= valueMinor*percent/100` is always
 * equivalent to `gapMinor <= floor(valueMinor*percent/100)` — an integer can
 * never be `<=` a real number without also being `<=` that real number's
 * floor. So comparing against this exact threshold preserves the original
 * `gapMinor * 100 <= valueMinor * percent` check for every input the old
 * formula got right, while also being correct where it silently wasn't.
 */
function floorPercentOfMinorUnits(valueMinor: MinorUnits, percent: number): number {
  const remainder = valueMinor % 100;
  const quotient = (valueMinor - remainder) / 100;
  return quotient * percent + Math.floor((remainder * percent) / 100);
}

/**
 * True when `candidate.contributionMinor` is within
 * {@link SLOW_MOVING_TOLERANCE_PERCENT}% behind `bestContributionMinor` —
 * inclusive, so a candidate exactly 3% behind counts as "within the band".
 */
function isWithinSlowMovingBand(candidate: TieredCandidate, bestContributionMinor: MinorUnits): boolean {
  const gapMinor = requireSafeInteger(
    bestContributionMinor - candidate.contributionMinor,
    "gap to best contribution",
  );
  return gapMinor <= floorPercentOfMinorUnits(bestContributionMinor, SLOW_MOVING_TOLERANCE_PERCENT);
}

/**
 * A stable, content-derived string with no bearing in PRD §6.6 itself —
 * purely the final tiebreak key described in this module's doc, so that two
 * candidates identical in every economically meaningful field still compare
 * deterministically instead of depending on array position.
 */
function contentTiebreakKey(candidate: TieredCandidate): string {
  return JSON.stringify({ moveType: candidate.moveType, basket: candidate.basket });
}

/**
 * Compares two candidates under PRD §6.6's ordering. Negative means `a`
 * outranks `b`; positive means `b` outranks `a`; each key below fully
 * decides the comparison before the next is ever read (see module doc —
 * this is a lexicographic comparator, not a weighted score).
 */
function compareByObjectiveOrdering(
  a: TieredCandidate,
  b: TieredCandidate,
  bestContributionMinor: MinorUnits,
): number {
  const aPreferred = a.clearsSlowMoving && isWithinSlowMovingBand(a, bestContributionMinor);
  const bPreferred = b.clearsSlowMoving && isWithinSlowMovingBand(b, bestContributionMinor);
  if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;

  if (a.contributionMinor !== b.contributionMinor) return b.contributionMinor - a.contributionMinor;

  if (a.requiredCampaignSpendMinor !== b.requiredCampaignSpendMinor) {
    return a.requiredCampaignSpendMinor - b.requiredCampaignSpendMinor;
  }

  return contentTiebreakKey(a).localeCompare(contentTiebreakKey(b));
}

/**
 * Selects the one candidate PRD §6.6's stated ordering picks out of
 * `candidates` — intended to be the feasible/selectable set an upstream
 * caller already computed (TICKET-104's `selectableCandidates`), never the
 * whole tiered array (see module doc). Throws on an empty array: an empty
 * feasible set is `NO_FEASIBLE_BASKET` (TICKET-104's own concern), not a
 * question this ordering function can answer — it has nothing to select
 * from and no reason code of its own to return.
 *
 * Deterministic: the same set of candidates always yields the same
 * selection regardless of the input array's own order (see module doc's
 * key 4).
 */
export function selectCandidate(candidates: readonly TieredCandidate[]): TieredCandidate {
  if (candidates.length === 0) {
    throw new Error(
      "selectCandidate: candidates must be non-empty — pass the feasible/selectable set, never an empty array",
    );
  }

  let bestContributionMinor = candidates[0]!.contributionMinor;
  for (const candidate of candidates) {
    requireSafeInteger(candidate.contributionMinor, "contributionMinor");
    requireSafeInteger(candidate.requiredCampaignSpendMinor, "requiredCampaignSpendMinor");
    if (candidate.contributionMinor > bestContributionMinor) {
      bestContributionMinor = candidate.contributionMinor;
    }
  }

  let winner = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (compareByObjectiveOrdering(candidate, winner, bestContributionMinor) < 0) {
      winner = candidate;
    }
  }
  return winner;
}
