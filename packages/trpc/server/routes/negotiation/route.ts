import { TRPCError } from "@trpc/server";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

/**
 * FROZEN CONTRACT — PRD.md §18, CONTRACTS.md §9. Signatures only; bodies are
 * stubs for Phase 0 (TICKET-006). Implementations land in TICKET-204.
 *
 * This is the PUBLIC, buyer-agent-facing surface. It is a deliverable in its
 * own right: judges are invited to negotiate against it via the Scalar
 * reference after the demo.
 *
 * ===========================================================================
 * NOTHING HERE MAY EVER SERIALIZE a floor price, an available budget figure,
 * a per-deal cap, or a concession-curve value.
 *
 * An agent that negotiates a hundred times must learn nothing it could not
 * learn in one. Output schemas below are deliberately narrow; widening one is
 * a frozen-contract change (CONTRACTS.md §1).
 * ===========================================================================
 */

const TAGS = ["Negotiation"];
const getPath = generatePath("/negotiation");

const notImplemented = (ticket: string) => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Stubbed during Phase 0 contract freeze. Implemented by ${ticket}.`,
  });
};

/** What a buyer agent is allowed to see about a basket line. */
const publicBasketLineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
});

/** An offer, as the buyer sees it. Tier and campaign spend are merchant-side. */
const publicOfferSchema = z.object({
  offerId: z.string(),
  lines: z.array(publicBasketLineSchema),
  commitments: z.array(z.string()),
  totalMinor: z.number().int().nonnegative(),
  currency: z.literal("INR"),
  expiresAt: z.string(),
  message: z.string(),
});

export const negotiationRouter = router({
  getSessionContext: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/session/{sessionId}"), tags: TAGS } })
    .input(z.object({ sessionId: z.string() }))
    .output(
      z.object({
        sessionId: z.string(),
        lines: z.array(publicBasketLineSchema),
        currency: z.literal("INR"),
        /** Whether the merchant's own engine has flagged this session. */
        negotiationAvailable: z.boolean(),
      }),
    )
    .query(async () => notImplemented("TICKET-204")),

  /**
   * Eligibility is computed merchant-side. A buyer agent cannot talk its way
   * into a negotiation: an unflagged session is refused with NOT_AT_RISK.
   */
  openNegotiation: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/open"), tags: TAGS } })
    .input(
      z.object({
        sessionId: z.string(),
        buyerAgentId: z.string().min(1),
      }),
    )
    .output(
      z.object({
        negotiationId: z.string(),
        opened: z.boolean(),
        roundIndex: z.number().int(),
        /** NOT_AT_RISK, NEGOTIATION_DISABLED or SKU_NOT_NEGOTIABLE when refused. */
        reasonCode: z.string(),
        message: z.string(),
      }),
    )
    .mutation(async () => notImplemented("TICKET-204")),

  /** The buyer agent states constraints or counters; the merchant agent replies. */
  propose: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/propose"), tags: TAGS } })
    .input(
      z.object({
        negotiationId: z.string(),
        message: z.string().max(2000),
      }),
    )
    .output(
      z.object({
        roundIndex: z.number().int(),
        offer: publicOfferSchema.nullable(),
        /** True when the merchant agent has ended the negotiation. */
        terminal: z.boolean(),
        reasonCode: z.string(),
      }),
    )
    .mutation(async () => notImplemented("TICKET-204")),

  respondToOffer: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/respond"), tags: TAGS } })
    .input(
      z.object({
        negotiationId: z.string(),
        offerId: z.string(),
        response: z.enum(["DECLINE_AND_CONTINUE", "WALK_AWAY"]),
      }),
    )
    .output(
      z.object({
        roundIndex: z.number().int(),
        offer: publicOfferSchema.nullable(),
        terminal: z.boolean(),
        reasonCode: z.string(),
      }),
    )
    .mutation(async () => notImplemented("TICKET-204")),

  /**
   * Consumes the offer and returns a payment handle. It never captures: the
   * buyer authorizes their own payment (PRD §9).
   */
  acceptOffer: publicProcedure
    .meta({ openapi: { method: "POST", path: getPath("/accept"), tags: TAGS } })
    .input(
      z.object({
        negotiationId: z.string(),
        offerId: z.string(),
      }),
    )
    .output(
      z.object({
        accepted: z.boolean(),
        reasonCode: z.string(),
        /** Present only on success. The buyer authorizes payment with this. */
        paymentHandle: z
          .object({
            orderId: z.string(),
            railOrderId: z.string(),
            amountMinor: z.number().int().nonnegative(),
            currency: z.literal("INR"),
          })
          .nullable(),
      }),
    )
    .mutation(async () => notImplemented("TICKET-303")),
});
