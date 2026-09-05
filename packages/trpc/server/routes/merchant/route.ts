import { TRPCError } from "@trpc/server";

import {
  approveMerchantPolicy,
  getMerchantPolicy,
  setNegotiationEnabled as setNegotiationEnabledRepo,
} from "@repo/database/repositories/merchant-policies";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

/**
 * FROZEN CONTRACT — PRD.md §5, §6.5. Signatures only; bodies are stubs for
 * Phase 0 (TICKET-006). Implementations land in TICKET-501 and TICKET-503.
 *
 * The MERCHANT-side console. Unlike the buyer surface, this may expose floors,
 * budgets and caps — this is the merchant's own data.
 */

const TAGS = ["Merchant"];
const getPath = generatePath("/merchant");

const notImplemented = (ticket: string) => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Stubbed during Phase 0 contract freeze. Implemented by ${ticket}.`,
  });
};

const commitmentValueSchema = z.object({
  commitmentType: z.enum(["PREPAID", "NON_RETURNABLE", "EXTENDED_DELIVERY_WINDOW"]),
  valueMinor: z.number().int().nonnegative(),
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

  /**
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

  /** available = total - reserved - committed. The number that counts down. */
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
    .query(async () => notImplemented("TICKET-503")),
});
