import { z } from "zod";
import { currencySchema, minorUnitsSchema, signedMinorUnitsSchema } from "./money";
import { commitmentTypeSchema } from "./merchant-policy";
import { negotiationStateSchema } from "./state-machine";
import { reasonCodeSchema } from "./reason-codes";

/**
 * FROZEN CONTRACT — PRD.md §6, §8, §10.
 *
 * The four objects that carry a negotiation and its money: session, candidate,
 * offer, campaign hold.
 */

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

export const basketLineSchema = z.object({
  skuId: z.string().uuid(),
  quantity: z.number().int().positive(),
  /** Unit price in this basket, in minor units. Never below the SKU floor. */
  unitPriceMinor: minorUnitsSchema,
});

export type BasketLine = z.infer<typeof basketLineSchema>;

export const basketSchema = z.object({
  lines: z.array(basketLineSchema).min(1),
  commitments: z.array(commitmentTypeSchema),
  currency: currencySchema,
});

export type Basket = z.infer<typeof basketSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const negotiationSessionSchema = z.object({
  sessionId: z.string().uuid(),
  merchantId: z.string().uuid(),
  buyerAgentId: z.string().min(1),

  state: negotiationStateSchema,
  /** 1-based. Compared against policy.maxRounds. */
  roundIndex: z.number().int().nonnegative(),
  /**
   * Set by ONE refusal of the engine's best tier 1 candidate (RA-2). Tier 2
   * candidates stay locked until this is true.
   */
  tier1Refused: z.boolean(),
  /** Pinned at open. Every other policy field is frozen for this session. */
  policyVersion: z.number().int().nonnegative(),

  /** The cart as it stood when the session was flagged. The counterfactual. */
  originalBasket: basketSchema,
  /** Contribution of originalBasket at list. What every candidate is judged against. */
  counterfactualContributionMinor: minorUnitsSchema,
});

export type NegotiationSession = z.infer<typeof negotiationSessionSchema>;

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/** The five move types the bounded generator may apply (PRD §8). */
export const CANDIDATE_MOVE_TYPES = [
  "PRICE_CONCESSION",
  "ADD_SKU",
  "ADD_SLOW_MOVING_SKU",
  "INCREASE_QUANTITY",
  "COMMITMENT_SWAP",
] as const;

export type CandidateMoveType = (typeof CANDIDATE_MOVE_TYPES)[number];
export const candidateMoveTypeSchema = z.enum(CANDIDATE_MOVE_TYPES);

/** Hard cap on the candidate set. The space is never enumerated (PRD §8). */
export const MAX_CANDIDATES = 12;

export const OFFER_TIERS = [1, 2] as const;
export const offerTierSchema = z.union([z.literal(1), z.literal(2)]);
export type OfferTier = z.infer<typeof offerTierSchema>;

export const candidateSchema = z.object({
  candidateId: z.string().min(1),
  sessionId: z.string().uuid(),
  roundIndex: z.number().int().positive(),

  moveType: candidateMoveTypeSchema,
  basket: basketSchema,
  totalMinor: minorUnitsSchema,

  /** Headroom above floor for this basket. Not margin — floors replace COGS. */
  contributionMinor: minorUnitsSchema,
  /** contribution(proposed) - contribution(original). Negative means dilutive. */
  contributionDeltaMinor: signedMinorUnitsSchema,

  /** Derived arithmetically from contributionDelta. Never asserted by a caller. */
  tier: offerTierSchema,
  /** Campaign budget this candidate would consume. Always 0 for tier 1. */
  requiredCampaignSpendMinor: minorUnitsSchema,

  /** True only when it clears a slow-moving SKU. Feeds the 3% tolerance band. */
  clearsSlowMoving: z.boolean(),
  /** False when a cap or the floor rules it out; carries its own reason code. */
  feasible: z.boolean(),
  infeasibleReason: reasonCodeSchema.nullable(),
});

export type Candidate = z.infer<typeof candidateSchema>;

// ---------------------------------------------------------------------------
// Offer — the only object in the system that can become money
// ---------------------------------------------------------------------------

export const OFFER_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "EXPIRED",
  "DECLINED",
  "CONSUMED",
] as const;

export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const offerStatusSchema = z.enum(OFFER_STATUSES);

export const offerSchema = z.object({
  offerId: z.string().uuid(),
  sessionId: z.string().uuid(),
  candidateId: z.string().min(1),
  roundIndex: z.number().int().positive(),

  /** Exact basket. Any deviation at accept time is a BASKET_MISMATCH. */
  basket: basketSchema,
  /** THE authorized amount. The payment path reads it from here, never from a caller. */
  totalMinor: minorUnitsSchema,
  currency: currencySchema,

  tier: offerTierSchema,
  /** Exact contribution shortfall. Zero for tier 1. */
  campaignSpendMinor: minorUnitsSchema,

  policyVersion: z.number().int().nonnegative(),
  status: offerStatusSchema,
  /** The code emitted when this offer was minted. */
  reasonCode: reasonCodeSchema,

  expiresAt: z.date(),
  /** Set exactly once. Single-use is enforced here. */
  consumedAt: z.date().nullable(),

  /** Signed by the engine. The signing path is unreachable from the agent package. */
  engineSignature: z.string().min(1),
});

export type Offer = z.infer<typeof offerSchema>;

// ---------------------------------------------------------------------------
// Campaign hold — budget is never decremented, it moves through three states
// ---------------------------------------------------------------------------

export const CAMPAIGN_HOLD_STATES = ["RESERVED", "RELEASED", "COMMITTED"] as const;

export type CampaignHoldState = (typeof CAMPAIGN_HOLD_STATES)[number];
export const campaignHoldStateSchema = z.enum(CAMPAIGN_HOLD_STATES);

export const campaignHoldSchema = z.object({
  holdId: z.string().uuid(),
  merchantId: z.string().uuid(),
  offerId: z.string().uuid(),

  amountMinor: minorUnitsSchema,
  state: campaignHoldStateSchema,
  /** Equals the offer TTL. An abandoned offer cannot drain the budget. */
  expiresAt: z.date(),
  resolvedAt: z.date().nullable(),
});

export type CampaignHold = z.infer<typeof campaignHoldSchema>;

/** available = total - reserved - committed. Caps are checked against this. */
export const campaignBudgetStateSchema = z.object({
  totalMinor: minorUnitsSchema,
  reservedMinor: minorUnitsSchema,
  committedMinor: minorUnitsSchema,
  availableMinor: minorUnitsSchema,
});

export type CampaignBudgetState = z.infer<typeof campaignBudgetStateSchema>;
