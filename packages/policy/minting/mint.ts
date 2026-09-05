import { randomUUID } from "node:crypto";

import type { Candidate, Offer } from "../contracts/negotiation";
import type { ReasonCode } from "../contracts/reason-codes";
import { signOfferPayload, type SignableOfferFields } from "./signing";

/**
 * TICKET-110 — offer minting and signature (PRD §10; CONTRACTS.md §2, §5.1,
 * §6). "Make the engine the only thing in the system that can mint an offer."
 *
 * ============================================================================
 * `packages/policy` STAYS PURE (CONTRACTS.md §2, §8) — same seam as
 * `generation/tiering.ts` (TICKET-104)
 * ============================================================================
 * Reserving Tier 2 campaign budget is a real database write — a row-locked
 * transaction against `merchant_policies` + `campaign_holds`
 * (`packages/database/repositories/campaign-holds.ts`'s `reserveCampaignBudget`,
 * TICKET-107/403). This module cannot call it without importing the database
 * into `packages/policy`, which would break the engine's purity even though
 * nothing in this package's lint config currently forbids a `@repo/database`
 * import (only a model SDK and `@repo/payments` are blocked, B1). So, exactly
 * like `tiering.ts` takes `availableCampaignBudgetMinor` as a plain input
 * instead of fetching it, `mintOffer` takes the reservation's OUTCOME
 * (`CampaignBudgetReservationOutcome`) as a plain input already obtained by a
 * database-backed caller. No orchestration layer exists yet in this codebase
 * to call `reserveCampaignBudget` and then `mintOffer` in sequence — building
 * that wiring is not this ticket's job (its `Affected` is `packages/policy`
 * only); this type is the seam a future orchestration ticket fills.
 *
 * Similarly, `now` (mint time) is a plain input rather than read via
 * `new Date()` inside this function, so `mintOffer` stays a pure,
 * deterministic function of its arguments — the same discipline
 * `ledger/hash-chain.ts` documents for why it never hashes a timestamp.
 *
 * ============================================================================
 * WHAT MINT DERIVES, AND WHAT IT NEVER ACCEPTS FROM A CALLER
 * ============================================================================
 * `MintOfferInput` has no `totalMinor`, no `tier`, and no `campaignSpendMinor`
 * field — there is no field through which a caller could assert an amount.
 * Every money/tier fact on the minted `Offer` is read off the matching
 * `Candidate` in `candidatesInRound` (already computed by TICKET-103's
 * generator and TICKET-104's tiering step), never off the caller's intent.
 * The intent's only load-bearing field this function reads is `candidateId`
 * (PRD §10.1: "no string produced by a model ever becomes a monetary
 * amount") — `messageFrame` and `terminalAction` never reach this function at
 * all, because nothing about minting depends on them.
 *
 * ============================================================================
 * TWO FAILURE CLASSES, TWO SHAPES (CONTRACTS.md §6 — fail closed)
 * ============================================================================
 * 1. INTEGRITY VIOLATIONS — throw. A `candidateId` absent from
 *    `candidatesInRound`, or belonging to a candidate whose `sessionId` /
 *    `roundIndex` don't match this call's, or a Tier 2 candidate selected
 *    while `tier1Refused` is false, or a Tier 2 candidate with no
 *    `campaignBudgetReservation` supplied at all: none of these have a
 *    reason code in the closed, frozen 28-member enum
 *    (`contracts/reason-codes.ts`), and none of them appears anywhere in the
 *    frozen state machine's `MINT_ATTEMPTED` rows
 *    (`contracts/state-machine.ts`). They are, by construction, unreachable
 *    from a caller that only ever offers a model `selectableCandidates`
 *    (`generation/tiering.ts`'s own lock) and always reserves budget before
 *    minting a Tier 2 candidate. Reaching one of these means an upstream bug
 *    let something through that should have been impossible — the same
 *    "unreachable in correct operation, must fail loudly if reached"
 *    discipline as `FLOOR_BREACH` (CONTRACTS.md §6).
 * 2. LEGITIMATE, CODED REJECTIONS — a typed `{ minted: false; reasonCode }`
 *    result. A candidate already marked `feasible: false` at tiering time
 *    (its own `infeasibleReason` is one of the two codes tiering can assign,
 *    `DILUTION_EXCEEDS_PER_DEAL_CAP` or `CAMPAIGN_BUDGET_EXHAUSTED`), or a
 *    Tier 2 candidate whose supplied `campaignBudgetReservation` came back
 *    `{ reserved: false }` (the live budget shrank between the tiering-time
 *    snapshot and this mint attempt — an ordinary, expected race the atomic
 *    reservation exists to catch, not a bug): both map onto the frozen
 *    `MINT_ATTEMPTED -> WALKED_AWAY` rows in `state-machine.ts`. Writing the
 *    actual ledger event for either is a future orchestration layer's job
 *    (`packages/policy` never touches the database, CONTRACTS.md §2, §8) —
 *    this function only returns the reason code that event must carry.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The outcome of a Tier 2 campaign-budget reservation, already performed by a
 * database-backed caller (`reserveCampaignBudget`,
 * `packages/database/repositories/campaign-holds.ts`) before calling
 * `mintOffer`. Mirrors that function's own `ReserveCampaignBudgetResult`
 * shape (minus the hold row, which this pure function has no use for) rather
 * than redefining an incompatible one.
 */
export type CampaignBudgetReservationOutcome =
  | { reserved: true }
  | { reserved: false; reasonCode: Extract<ReasonCode, "CAMPAIGN_BUDGET_EXHAUSTED"> };

export type MintOfferInput = {
  /** The negotiation session this mint is for. Every candidate in
   *  `candidatesInRound` is asserted to belong to this session (defense in
   *  depth, same style as `generateCandidates`' `assertSkuCatalogueIsSane`). */
  sessionId: string;
  /** The round `candidatesInRound` was generated for — asserted against
   *  every candidate in it, so "this round's set" is a checked fact, not an
   *  assumption. */
  roundIndex: number;
  /** Pinned at session open (`NegotiationSession.policyVersion`); not on
   *  `Candidate`, so it travels as its own field. */
  policyVersion: number;
  /** Session state (`NegotiationSession.tier1Refused`) — plain pass-through,
   *  read but never decided here (RA-2, same as `tiering.ts`). */
  tier1Refused: boolean;
  /** Every engine-authored candidate for this round — the WHOLE set from
   *  `assignTiersAndFeasibility`'s `candidates`, not just
   *  `selectableCandidates`, so a caller error that offers a locked or
   *  infeasible candidate id is still rejected with the right shape rather
   *  than silently "not found". */
  candidatesInRound: readonly Candidate[];
  /** The model's entire numeric-free selection (PRD §10.1) — the only
   *  intent field this function reads. Must exist in `candidatesInRound`. */
  candidateId: string;
  /** Required whenever the resolved candidate is Tier 2; ignored for
   *  Tier 1, which never touches campaign budget. */
  campaignBudgetReservation?: CampaignBudgetReservationOutcome;
  /** Mint time, supplied by the caller — see module doc on why this is not
   *  `new Date()` inside this function. */
  now: Date;
  /** `MerchantPolicy.offerTtlSeconds` — `expiresAt = now + offerTtlSeconds`
   *  (PRD §10: "Mint time + 600 s"). */
  offerTtlSeconds: number;
  /** Passed straight through to the signer; omit to use the module's
   *  env-sourced default (see `./signing`). */
  signingSecret?: string;
};

export type MintOfferResult =
  | { minted: true; offer: Offer }
  | { minted: false; reasonCode: ReasonCode };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireSafeInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`mintOffer: ${description} is not a safe integer (${value})`);
  }
  return value;
}

function requirePositiveInteger(value: number, description: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`mintOffer: ${description} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * "This round's set" is a checked fact: every candidate handed to
 * `mintOffer` must actually belong to the stated session and round, not just
 * whichever array a caller happened to pass. Mirrors
 * `generateCandidates`' `assertSkuCatalogueIsSane` cross-check discipline.
 */
function assertCandidatesBelongToRound(
  candidates: readonly Candidate[],
  sessionId: string,
  roundIndex: number,
): void {
  for (const candidate of candidates) {
    if (candidate.sessionId !== sessionId || candidate.roundIndex !== roundIndex) {
      throw new Error(
        `mintOffer: candidatesInRound contains candidateId "${candidate.candidateId}" belonging to ` +
          `sessionId "${candidate.sessionId}" roundIndex ${candidate.roundIndex}, not the requested ` +
          `sessionId "${sessionId}" roundIndex ${roundIndex} — refusing to mint`,
      );
    }
  }
}

/**
 * The only place a caller-supplied string is compared against the engine's
 * own candidate set. A `candidateId` that doesn't resolve here is, by
 * definition, forged or stale — there is no reason code for "unknown
 * candidate" in the closed 28-member enum (see module doc), so this fails
 * closed with a thrown error rather than a coded rejection.
 */
function findCandidateById(candidates: readonly Candidate[], candidateId: string): Candidate {
  const candidate = candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    throw new Error(
      `mintOffer: candidateId "${candidateId}" is not in this round's engine-authored candidate set — ` +
        "refusing to mint a forged or out-of-set candidate id",
    );
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Mints and signs an offer for exactly one engine-authored candidate. The
 * only thing in the system that can produce a signed `Offer` — see module
 * doc for the purity seam, the derivation discipline, and the two failure
 * shapes.
 */
export function mintOffer(input: MintOfferInput): MintOfferResult {
  const {
    sessionId,
    roundIndex,
    policyVersion,
    tier1Refused,
    candidatesInRound,
    candidateId,
    campaignBudgetReservation,
    now,
    offerTtlSeconds,
    signingSecret,
  } = input;

  requireSafeInteger(policyVersion, "policyVersion");
  requirePositiveInteger(roundIndex, "roundIndex");
  requirePositiveInteger(offerTtlSeconds, "offerTtlSeconds");
  if (Number.isNaN(now.getTime())) {
    throw new Error("mintOffer: now must be a valid Date");
  }

  assertCandidatesBelongToRound(candidatesInRound, sessionId, roundIndex);
  const candidate = findCandidateById(candidatesInRound, candidateId);

  // Integrity violation: the tier1_refused lock (RA-2) is enforced by what
  // `assignTiersAndFeasibility` returns as `selectableCandidates` — a
  // well-behaved caller never offers a locked Tier 2 candidate id at all.
  // Reaching this means that discipline was bypassed upstream.
  if (candidate.tier === 2 && !tier1Refused) {
    throw new Error(
      `mintOffer: candidateId "${candidate.candidateId}" is Tier 2 but tier1Refused is false — a Tier 2 ` +
        "candidate must never be selectable before a Tier 1 refusal (RA-2); refusing to mint",
    );
  }

  // Legitimate, coded rejection: this candidate was already marked
  // infeasible at tiering time (cap or campaign-budget snapshot check).
  if (!candidate.feasible) {
    const reasonCode = candidate.infeasibleReason;
    if (!reasonCode) {
      throw new Error(
        `mintOffer: candidateId "${candidate.candidateId}" is infeasible but carries no infeasibleReason — ` +
          "unreachable, contradicts the tiering contract",
      );
    }
    return { minted: false, reasonCode };
  }

  if (candidate.tier === 2) {
    // Integrity violation: a Tier 2 mint attempt with no reservation outcome
    // at all means the caller skipped reserving budget before calling
    // mintOffer, contradicting this module's documented contract.
    if (!campaignBudgetReservation) {
      throw new Error(
        `mintOffer: candidateId "${candidate.candidateId}" is Tier 2 but no campaignBudgetReservation ` +
          "outcome was supplied — the caller must reserve campaign budget before calling mintOffer",
      );
    }
    // Legitimate, coded rejection: the live budget shrank between the
    // tiering-time snapshot and this mint attempt (an ordinary race the
    // atomic reservation exists to catch).
    if (!campaignBudgetReservation.reserved) {
      return { minted: false, reasonCode: campaignBudgetReservation.reasonCode };
    }
  }

  const totalMinor = requireSafeInteger(candidate.totalMinor, "candidate.totalMinor");
  const campaignSpendMinor = requireSafeInteger(
    candidate.requiredCampaignSpendMinor,
    "candidate.requiredCampaignSpendMinor",
  );

  const offerId = randomUUID();
  const expiresAt = new Date(now.getTime() + offerTtlSeconds * 1000);
  const reasonCode: ReasonCode = candidate.tier === 1 ? "TIER1_OFFERED" : "DILUTION_WITHIN_CAPS";

  const signableFields: SignableOfferFields = {
    offerId,
    sessionId,
    candidateId: candidate.candidateId,
    totalMinor,
    currency: candidate.basket.currency,
    tier: candidate.tier,
    campaignSpendMinor,
    policyVersion,
    expiresAt,
  };

  const engineSignature = signOfferPayload(signableFields, signingSecret);

  const offer: Offer = {
    offerId,
    sessionId,
    candidateId: candidate.candidateId,
    roundIndex: candidate.roundIndex,
    basket: candidate.basket,
    totalMinor,
    currency: candidate.basket.currency,
    tier: candidate.tier,
    campaignSpendMinor,
    policyVersion,
    status: "PENDING",
    reasonCode,
    expiresAt,
    consumedAt: null,
    engineSignature,
  };

  return { minted: true, offer };
}
