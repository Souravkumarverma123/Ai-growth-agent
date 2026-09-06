import { TRPCError } from "@trpc/server";

import { getCampaignBudgetBreakdown } from "@repo/database/repositories/campaign-budget-snapshot";
import { getOffersForSession } from "@repo/database/repositories/offers";
import {
  approveMerchantPolicy,
  getMerchantPolicy,
  setNegotiationEnabled as setNegotiationEnabledRepo,
} from "@repo/database/repositories/merchant-policies";
import { offerStatusSchema } from "@repo/policy/contracts";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

/**
 * FROZEN CONTRACT — PRD.md §5, §6.5. Signatures were fixed in Phase 0
 * (TICKET-006). Bodies implemented in TICKET-501 (getPolicy / approvePolicy /
 * setNegotiationEnabled) and TICKET-503 (getCampaignBudget).
 *
 * The MERCHANT-side console. Unlike the buyer surface, this may expose floors,
 * budgets and caps — this is the merchant's own data.
 */

const TAGS = ["Merchant"];
const getPath = generatePath("/merchant");

const commitmentValueSchema = z.object({
  commitmentType: z.enum(["PREPAID", "NON_RETURNABLE", "EXTENDED_DELIVERY_WINDOW"]),
  valueMinor: z.number().int().nonnegative(),
});

/**
 * TICKET-504 — one minted offer, as the merchant's watch screen sees it.
 * Unlike the buyer-facing `publicOfferSchema` this may carry `tier` and
 * `campaignSpendMinor` — merchant-side figures (CONTRACTS.md §9 governs only
 * the buyer surface, and `audit.getSessionLedger` already exposes the same
 * per-deal shortfall). Money stays in minor units; the web layer formats.
 * Timestamps are ISO-8601 strings — the client parses `expiresAt` and counts
 * the TTL down from it.
 */
const sessionOfferViewSchema = z.object({
  offerId: z.string(),
  roundIndex: z.number().int().nonnegative(),
  /** Derived arithmetically by the engine, never asserted by a caller (PRD §10). */
  tier: z.number().int().min(1).max(2),
  /** Best-effort read-model column; authoritative lifecycle is expiresAt/consumedAt. */
  status: offerStatusSchema,
  totalMinor: z.number().int().nonnegative(),
  /** Exact contribution shortfall for this deal. Zero for Tier 1. */
  campaignSpendMinor: z.number().int().nonnegative(),
  currency: z.string(),
  reasonCode: z.string(),
  createdAt: z.string().nullable(),
  expiresAt: z.string(),
  consumedAt: z.string().nullable(),
});

const merchantPolicyViewSchema = z.object({
  merchantId: z.string(),
  negotiationEnabled: z.boolean(),
  campaignBudgetTotalMinor: z.number().int().nonnegative(),
  perDealCapMinor: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  concessionCurve: z.array(z.number().min(0).max(1)),
  offerTtlSeconds: z.number().int().positive(),
  slowMovingTolerance: z.number().min(0).max(1),
  allowedCommitments: z.array(commitmentValueSchema),
  autonomousPaymentExecution: z.boolean(),
  policyVersion: z.number().int().nonnegative(),
});

export const merchantRouter = router({
  getPolicy: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/policy"), tags: TAGS } })
    .input(z.object({ merchantId: z.string() }))
    .output(merchantPolicyViewSchema)
    .query(async ({ input, ctx }) => {
      const policy = await getMerchantPolicy(ctx.db, input.merchantId);
      if (!policy) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No policy found for merchant ${input.merchantId}`,
        });
      }

      return {
        merchantId: policy.merchantId,
        negotiationEnabled: policy.negotiationEnabled,
        campaignBudgetTotalMinor: policy.campaignBudgetTotalMinor,
        perDealCapMinor: policy.perDealCapMinor,
        maxRounds: policy.maxRounds,
        concessionCurve: policy.concessionCurve,
        offerTtlSeconds: policy.offerTtlSeconds,
        slowMovingTolerance: policy.slowMovingTolerance,
        allowedCommitments: policy.allowedCommitments,
        autonomousPaymentExecution: policy.autonomousPaymentExecution,
        policyVersion: policy.policyVersion,
      };
    }),

  /*
   * Approving policy is the delegation moment — the only point at which a human
   * grants the agent authority. It increments policyVersion, which is then
   * pinned to every session opened afterwards.
   */
  approvePolicy: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/policy/approve"), tags: TAGS } })
    .input(
      z.object({
        merchantId: z.string(),
        campaignBudgetTotalMinor: z.number().int().nonnegative(),
        perDealCapMinor: z.number().int().nonnegative(),
        maxRounds: z.number().int().positive(),
        offerTtlSeconds: z.number().int().positive(),
        allowedCommitments: z.array(commitmentValueSchema),
      }),
    )
    .output(z.object({ policyVersion: z.number().int().nonnegative() }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await approveMerchantPolicy(ctx.db, input);
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No policy found for merchant ${input.merchantId}`,
        });
      }
    }),

  /**
   * The kill switch is EXEMPT from the policy freeze (RA-1): it may be flipped
   * at any time, including mid-negotiation, because it halts sessions rather
   * than re-pricing them.
   */
  setNegotiationEnabled: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/kill-switch"), tags: TAGS } })
    .input(z.object({ merchantId: z.string(), enabled: z.boolean() }))
    .output(z.object({ negotiationEnabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const result = await setNegotiationEnabledRepo(ctx.db, input.merchantId, input.enabled);
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No policy found for merchant ${input.merchantId}`,
        });
      }
      return result;
    }),

  /**
   * available = total - reserved - committed. The number that counts down as
   * Tier 2 holds are reserved, and climbs back as they expire or release
   * (TICKET-503). All four figures are derived from `campaign_holds` — see
   * `getCampaignBudgetBreakdown`. This is the merchant's own data, so unlike
   * the buyer surface it may expose the budget (CONTRACTS.md §9).
   */
  getCampaignBudget: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/campaign-budget"), tags: TAGS } })
    .input(z.object({ merchantId: z.string() }))
    .output(
      z.object({
        totalMinor: z.number().int().nonnegative(),
        reservedMinor: z.number().int().nonnegative(),
        committedMinor: z.number().int().nonnegative(),
        availableMinor: z.number().int().nonnegative(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const breakdown = await getCampaignBudgetBreakdown(ctx.db, input.merchantId);
      if (!breakdown) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No policy found for merchant ${input.merchantId}`,
        });
      }
      return breakdown;
    }),

  /**
   * TICKET-504 — "Show the offer perishing." Every offer minted for a
   * session, newest round first, with the fields the merchant's watch card
   * needs: status, TTL (`expiresAt`), tier, and campaign spend. Read-only —
   * this is the merchant's own session data, the same seam the audit trail
   * (`audit.getSessionLedger`) reads. An unknown session returns an empty
   * list, matching the audit route rather than throwing.
   */
  getSessionOffers: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/session/{sessionId}/offers"), tags: TAGS } })
    .input(z.object({ sessionId: z.string() }))
    .output(z.object({ offers: z.array(sessionOfferViewSchema) }))
    .query(async ({ input, ctx }) => {
      const offers = await getOffersForSession(ctx.db, input.sessionId);
      return {
        offers: offers.map((offer) => ({
          offerId: offer.id,
          roundIndex: offer.roundIndex,
          tier: offer.tier,
          status: offer.status,
          totalMinor: offer.totalMinor,
          campaignSpendMinor: offer.campaignSpendMinor,
          currency: offer.currency,
          reasonCode: offer.reasonCode,
          createdAt: offer.createdAt ? offer.createdAt.toISOString() : null,
          expiresAt: offer.expiresAt.toISOString(),
          consumedAt: offer.consumedAt ? offer.consumedAt.toISOString() : null,
        })),
      };
    }),
});
