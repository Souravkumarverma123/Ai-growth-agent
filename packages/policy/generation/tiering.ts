import type { Candidate } from "../contracts/negotiation";
import type { MinorUnits } from "../contracts/money";
import { evaluatePerDealCap } from "../economics/campaign-budget";
import type { GeneratedCandidate } from "./candidates";

/**
 * TICKET-104 — tier assignment and feasible-set marking (PRD §6.4, §7.1, §8;
 * Settled by Q19, Q20).
 *
 * Wraps TICKET-103's {@link GeneratedCandidate} arithmetic into the frozen
 * `Candidate` shape by deriving exactly the four fields `candidates.ts` left
 * out: `tier`, `requiredCampaignSpendMinor`, `feasible`, `infeasibleReason`.
 * "One search, two zones" (PRD §8): the feasible set is computed once, here,
 * and every candidate is marked Tier 1 or Tier 2 in the same pass.
 *
 * ============================================================================
 * `packages/policy` STAYS PURE (CONTRACTS.md §2, §8)
 * ============================================================================
 * The live campaign budget is database-backed and the per-deal cap and
 * `tier1Refused` both live on merchant policy / session state this module
 * cannot fetch. All three arrive as plain {@link TierAssignmentInput} fields;
 * a future orchestration ticket is responsible for reading them from the
 * database/session and passing them in.
 *
 * ============================================================================
 * TIER ARITHMETIC (PRD §6.4)
 * ============================================================================
 * Tier 1 — self-funding: `contributionDeltaMinor >= 0`. Consumes no campaign
 * budget; `requiredCampaignSpendMinor` is always 0; always feasible (a
 * self-funding candidate never needs a cap check — cross-checked against
 * `candidates.ts`'s own `selfFundingCount`, which counts exactly this set).
 *
 * Tier 2 — funded rescue: `contributionDeltaMinor < 0`. Its shortfall is
 * `-contributionDeltaMinor`. Feasible only when the shortfall clears BOTH the
 * per-deal cap (`evaluatePerDealCap`, TICKET-107) AND the live available
 * campaign budget — whichever fails first supplies `infeasibleReason`
 * (`DILUTION_EXCEEDS_PER_DEAL_CAP` or `CAMPAIGN_BUDGET_EXHAUSTED`).
 *
 * ============================================================================
 * THE LOCK: "a Tier 2 candidate cannot be selected while tier1_refused is
 * false" IS ENFORCED BY WHAT THIS FUNCTION RETURNS, NOT BY A SCHEMA FIELD
 * ============================================================================
 * The frozen `candidateSchema` documents `feasible`/`infeasibleReason` as
 * being about a cap or the floor ruling a candidate out — nothing in that
 * contract is about the tier1-refusal gate, and the reason-code enum is
 * closed at 28 members (reason-codes.ts), so this ticket does not invent a
 * "locked" code. Instead, {@link TierAssignmentResult} exposes two things:
 *
 *  - `candidates` — every generated candidate, tiered and cap/budget-checked.
 *    A Tier 2 candidate that clears both caps is `feasible: true` here EVEN
 *    BEFORE a refusal — the caps don't care about `tier1Refused`.
 *  - `selectableCandidates` — the subset an engine may actually pick from
 *    right now: feasible Tier 1 candidates, plus feasible Tier 2 candidates
 *    ONLY once `tier1Refused` is true (RA-2). A caller that picks from
 *    anything other than `selectableCandidates` is the bug, not this module;
 *    the accompanying test proves the exclusion behaviourally (a Tier 2
 *    candidate that is fully within cap and budget still does not appear in
 *    `selectableCandidates` while `tier1Refused` is false).
 *
 * The whole-result `NO_FEASIBLE_BASKET` (PRD §8) fires when, after this
 * marking, `selectableCandidates` is empty — no feasible Tier 1, and no
 * feasible-and-unlocked Tier 2.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The frozen `Candidate` shape minus the three identity fields
 * (`candidateId`, `sessionId`, `roundIndex`) that only exist once a candidate
 * is actually minted into a session — not this ticket's job, and not
 * computable from {@link GeneratedCandidate} alone. Expressed as an `Omit`
 * over the frozen type, not a hand-written duplicate, so this can never
 * silently drift from `candidateSchema`.
 */
export type TieredCandidate = Omit<Candidate, "candidateId" | "sessionId" | "roundIndex">;

export type TierAssignmentInput = {
  /** TICKET-103's raw output — the arithmetic this ticket tiers. */
  candidates: readonly GeneratedCandidate[];
  /**
   * Set by one refusal of the engine's best Tier 1 candidate (RA-2). Plain
   * pass-through of session state — this module does not decide when it
   * flips, only reads it.
   */
  tier1Refused: boolean;
  /** Merchant policy's `perDealCapMinor`, supplied by the caller. */
  perDealCapMinor: MinorUnits;
  /**
   * `available = total - reserved - committed` (PRD §6.5) for this
   * merchant's campaign budget, as read by a database-backed caller. This
   * pure function never touches campaign-hold state itself.
   */
  availableCampaignBudgetMinor: MinorUnits;
};

export type TierAssignmentResult =
  | {
      feasible: true;
      /** Every candidate, tiered and cap/budget-checked. May contain locked
       *  Tier 2 candidates even when `feasible` is true overall — pick from
       *  `selectableCandidates`, never from this array directly. */
      candidates: readonly TieredCandidate[];
      /** Feasible Tier 1 candidates, plus feasible Tier 2 candidates but only
       *  once `tier1Refused` is true. Guaranteed non-empty here. */
      selectableCandidates: readonly TieredCandidate[];
    }
  | { feasible: false; reasonCode: "NO_FEASIBLE_BASKET" };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireSafeInteger(value: number, description: string): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`assignTiersAndFeasibility: ${description} is not a safe integer (${value})`);
  }
  return value;
}

/**
 * Tiers and cap/budget-checks a single candidate. Never reads
 * `tier1Refused` — the lock is applied afterwards, over the whole set (see
 * module doc), because whether a candidate clears its own caps is a fact
 * independent of whether Tier 2 happens to be unlocked yet.
 */
function markCandidate(
  candidate: GeneratedCandidate,
  perDealCapMinor: MinorUnits,
  availableCampaignBudgetMinor: MinorUnits,
): TieredCandidate {
  const shared = {
    moveType: candidate.moveType,
    basket: candidate.basket,
    totalMinor: candidate.totalMinor,
    contributionMinor: candidate.contributionMinor,
    contributionDeltaMinor: candidate.contributionDeltaMinor,
    clearsSlowMoving: candidate.clearsSlowMoving,
  };

  if (candidate.contributionDeltaMinor >= 0) {
    return {
      ...shared,
      tier: 1,
      requiredCampaignSpendMinor: 0,
      feasible: true,
      infeasibleReason: null,
    };
  }

  const shortfallMinor = requireSafeInteger(-candidate.contributionDeltaMinor, "shortfallMinor");

  const perDealCapDecision = evaluatePerDealCap(shortfallMinor, perDealCapMinor);
  if (!perDealCapDecision.allowed) {
    return {
      ...shared,
      tier: 2,
      requiredCampaignSpendMinor: shortfallMinor,
      feasible: false,
      infeasibleReason: perDealCapDecision.reasonCode,
    };
  }

  if (shortfallMinor > availableCampaignBudgetMinor) {
    return {
      ...shared,
      tier: 2,
      requiredCampaignSpendMinor: shortfallMinor,
      feasible: false,
      infeasibleReason: "CAMPAIGN_BUDGET_EXHAUSTED",
    };
  }

  return {
    ...shared,
    tier: 2,
    requiredCampaignSpendMinor: shortfallMinor,
    feasible: true,
    infeasibleReason: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Tiers and marks the feasible set for a generated candidate batch (PRD §8:
 * "one search, two zones"). Tier is always derived from
 * `contributionDeltaMinor`'s sign — never accepted from a caller, since
 * {@link TierAssignmentInput} has no field a caller could use to assert one.
 */
export function assignTiersAndFeasibility(input: TierAssignmentInput): TierAssignmentResult {
  const { candidates, tier1Refused, perDealCapMinor, availableCampaignBudgetMinor } = input;

  requireSafeInteger(perDealCapMinor, "perDealCapMinor");
  requireSafeInteger(availableCampaignBudgetMinor, "availableCampaignBudgetMinor");

  const tieredCandidates = candidates.map((candidate) =>
    markCandidate(candidate, perDealCapMinor, availableCampaignBudgetMinor),
  );

  const selectableCandidates = tieredCandidates.filter((candidate) => {
    if (!candidate.feasible) return false;
    if (candidate.tier === 1) return true;
    return tier1Refused;
  });

  if (selectableCandidates.length === 0) {
    return { feasible: false, reasonCode: "NO_FEASIBLE_BASKET" };
  }

  return { feasible: true, candidates: tieredCandidates, selectableCandidates };
}
