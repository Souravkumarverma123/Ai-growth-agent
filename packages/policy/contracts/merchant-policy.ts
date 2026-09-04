import { z } from "zod";
import { fractionSchema, minorUnitsSchema } from "./money";

/**
 * FROZEN CONTRACT — PRD.md §5.
 *
 * Policy is the sole source of the agent's authority. The model has no write
 * path to any value here and cannot modify one.
 */

/** Closed set. The model cannot invent a commitment outside it (PRD §5.3). */
export const COMMITMENT_TYPES = [
  "PREPAID",
  "NON_RETURNABLE",
  "EXTENDED_DELIVERY_WINDOW",
] as const;

export type CommitmentType = (typeof COMMITMENT_TYPES)[number];
export const commitmentTypeSchema = z.enum(COMMITMENT_TYPES);

export const commitmentValueSchema = z.object({
  commitmentType: commitmentTypeSchema,
  /** What the commitment is worth to the merchant, in minor units. */
  valueMinor: minorUnitsSchema,
});

export type CommitmentValue = z.infer<typeof commitmentValueSchema>;

export const merchantPolicySchema = z.object({
  merchantId: z.string().uuid(),

  /**
   * Kill switch. Exempt from the policy freeze (RA-1): it may be flipped at any
   * time, including mid-negotiation, because it halts sessions rather than
   * re-pricing them and so cannot change an in-flight economic outcome.
   */
  negotiationEnabled: z.boolean(),

  /** Ceiling on lifetime dilutive (tier 2) spend. */
  campaignBudgetTotalMinor: minorUnitsSchema,
  /** Maximum dilution any single deal may consume. */
  perDealCapMinor: minorUnitsSchema,

  maxRounds: z.number().int().positive(),

  /**
   * Fraction of available floor-derived headroom released in round n.
   * RA-4: this IS the per-round envelope. There is no separate merchant-set
   * concession ceiling, because a second ceiling alongside floors recreates the
   * two-constraints-where-only-one-binds problem that removing
   * max_discount_percent solved.
   */
  concessionCurve: z.array(fractionSchema).min(1),

  /** Offer TTL, and therefore also the campaign hold TTL. */
  offerTtlSeconds: z.number().int().positive(),

  /**
   * A slow-moving candidate within this fraction of the best contribution is
   * preferred over it. Fixed at 0.03 and deliberately not merchant-configurable
   * — a slider here would be one more arbitrary number to defend.
   */
  slowMovingTolerance: fractionSchema,

  allowedCommitments: z.array(commitmentValueSchema),

  /**
   * NOT permission to charge a buyer. A merchant cannot authorize spending
   * someone else's money.
   *
   * This means: "this merchant's system is willing to ACCEPT an
   * autonomous-payment authorization presented by a buyer agent, in a future
   * where such authorizations exist." The grant lives buyer-side; the merchant
   * only chooses whether to honour it.
   *
   * MVP default false. The true branch exists in code and fails closed with
   * AUTONOMOUS_PAYMENT_NOT_AUTHORIZED — it must never silently no-op.
   */
  autonomousPaymentExecution: z.boolean(),

  /** Incremented on any policy change; pinned to a session at open. */
  policyVersion: z.number().int().nonnegative(),
});

export type MerchantPolicy = z.infer<typeof merchantPolicySchema>;

export const skuPolicySchema = z.object({
  skuId: z.string().uuid(),
  merchantId: z.string().uuid(),
  sku: z.string().min(1),
  name: z.string().min(1),

  listPriceMinor: minorUnitsSchema,
  /**
   * The least the merchant would ever accept. REPLACES COGS ENTIRELY — the
   * merchant never discloses cost. The engine reasons in headroom
   * (list - floor), never in margin.
   */
  floorPriceMinor: minorUnitsSchema,

  /** False: may sit in a cart, may never carry a concession. */
  negotiable: z.boolean(),
  /** Merchant-side economic context. Not proactively disclosed to the buyer. */
  slowMoving: z.boolean(),
  affinityGroup: z.string().nullable(),
});

export type SkuPolicy = z.infer<typeof skuPolicySchema>;

/**
 * DELIBERATELY ABSENT from this contract (PRD §5.4). Their absence is a
 * decision, not an omission. Do not add them back:
 *
 *  - maxDiscountPercent  — a percentage ceiling is only a speed limit on
 *                          losing money; contribution vs counterfactual is the
 *                          real constraint.
 *  - minProfitMargin     — needs COGS, and in any realistic configuration
 *                          either it or the discount ceiling is decorative.
 *  - maxTransactionValue — capping at list price forbids upsell, which
 *                          guarantees the agent can only be dilutive.
 *  - cogs                — display only at most, never binding. The product
 *                          claim is that the merchant never hands over costs.
 *  - a separate concession ceiling — see concessionCurve above (RA-4).
 */
