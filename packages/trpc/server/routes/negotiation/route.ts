import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  assignTiersAndFeasibility,
  checkEligibility,
  evaluateRoundCap,
  generateCandidates,
  lookupTransition,
  resolveBudgetReservedTransition,
  resolveBuyerDeclinesTransition,
  resolveBuyerEndsSessionTransition,
  resolveCandidatesGeneratedTransition,
  resolveNegotiationRequestedTransition,
  resolveOfferAcceptTransition,
  resolveOfferMintedTransition,
  resolvePaymentInitiationTransition,
  resolveRoundIncrementedTransition,
  resolveTtlElapsedTransition,
  type CampaignBudgetReservationOutcome,
} from "@repo/policy";
import type { NegotiationState, StateTransition, TransitionSource } from "@repo/policy/contracts";

import {
  runNegotiationRound,
  applyOfferDeclined,
  selectExposedCandidates,
  type RoundState,
} from "@repo/agent";

import { createOrder } from "@repo/payments";

import { appendAuditEvent, type AppendAuditEventParams } from "@repo/database/repositories/audit-events";
import { acceptOffer as acceptOfferRepo } from "@repo/database/repositories/offers";
import {
  getNegotiationSession,
  getNegotiationSessionForUpdate,
  updateNegotiationSession,
} from "@repo/database/repositories/negotiation-sessions";
import { releaseCampaignHold, reserveCampaignBudget } from "@repo/database/repositories/campaign-holds";
import type { CampaignHoldLedgerContext } from "@repo/database/repositories/campaign-holds";
import {
  getAvailableCampaignBudgetMinor,
  getCampaignHoldByOfferId,
} from "@repo/database/repositories/campaign-budget-snapshot";
import { persistCandidatesForRound } from "@repo/database/repositories/candidates";
import { getOrderByOfferId } from "@repo/database/repositories/order-lookup";
import { offersTable, type SelectOffer } from "@repo/database/models/offer";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";
import { loadMerchantNegotiationContext } from "./merchant-context";
import { assignCandidateIdentity, DeterministicMerchantModel } from "./merchant-model";
import { toPublicBasketLines, toPublicOffer } from "./public-mappers";

/**
 * FROZEN CONTRACT — PRD.md §18, CONTRACTS.md §9. Signatures only; bodies were
 * stubs for Phase 0 (TICKET-006). Implemented here (TICKET-204).
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
 * a frozen-contract change (CONTRACTS.md §1). Every mapper this file calls
 * into (`./public-mappers.ts`) builds its return value field-by-field, never
 * by spreading an internal `Offer`/`SkuPolicy`/`MerchantPolicy` object — see
 * that file's own doc and `packages/trpc/tests/response-shape.test.ts`.
 * ===========================================================================
 *
 * ===========================================================================
 * WHAT "SESSION" MEANS HERE, GIVEN NO UPSTREAM FLAGGING SYSTEM EXISTS YET
 * ===========================================================================
 * `packages/policy/eligibility/eligibility.ts`'s own module doc states there
 * is no live signal source yet for cart inactivity/exit-intent/etc — some
 * future system is expected to flag a `negotiation_sessions` row `AT_RISK`
 * before a buyer ever calls `openNegotiation`. That system is out of scope
 * for this ticket (as it was for TICKET-101). This router treats
 * `session.state !== "IDLE"` as "the merchant's own engine has flagged this
 * session" (`getSessionContext`'s own `negotiationAvailable` field), and
 * `session.state === "AT_RISK"` as the specific `isFlaggedAtRisk` input
 * `checkEligibility` needs — both read the one column the frozen schema
 * actually offers for this, `negotiation_sessions.state`. See
 * `issue-tracker.md` for this ticket's own entry recording the gap.
 */

const TAGS = ["Negotiation"];
const getPath = generatePath("/negotiation");

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

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function notFound(what: string, id: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message: `No ${what} found for id "${id}"` });
}

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** `negotiation_sessions.state` is the only merchant-flagging signal this
 *  codebase has yet (see module doc). */
function isFlaggedAtRisk(state: NegotiationState): boolean {
  return state === "AT_RISK";
}

/** A short, safe, invariant-free message per refusal/open code — never a
 *  number, never a policy detail. */
function messageForReasonCode(reasonCode: string): string {
  switch (reasonCode) {
    case "NOT_AT_RISK":
      return "This session is not eligible for negotiation.";
    case "NEGOTIATION_DISABLED":
      return "Negotiation is currently unavailable for this merchant.";
    case "SKU_NOT_NEGOTIABLE":
      return "Nothing in this basket is eligible for negotiation.";
    case "NEGOTIATION_OPENED":
      return "Negotiation opened.";
    default:
      return "This negotiation has ended.";
  }
}

/** Best-effort read-model update of `offers.status` — NOT the enforcement
 *  mechanism (that is `offers.consumed_at`, TICKET-111's atomic CAS via
 *  `acceptOfferRepo`). No repository exported this before TICKET-204: every
 *  prior ticket only ever read `status`'s frozen default. */
async function setOfferStatus(
  database: NodePgDatabase,
  offerId: string,
  status: SelectOffer["status"],
): Promise<void> {
  await database.update(offersTable).set({ status }).where(eq(offersTable.id, offerId));
}

async function getOfferOrThrow(database: NodePgDatabase, offerId: string): Promise<SelectOffer> {
  const [offer] = await database.select().from(offersTable).where(eq(offersTable.id, offerId));
  if (!offer) notFound("offer", offerId);
  return offer;
}

/** `StateTransition.from` is `NegotiationState | "*"` — `"*"` only for the
 *  defensive `FLOOR_BREACH` assertion, never for any transition this router
 *  actually fires. `audit_events.from_state` is nullable specifically for
 *  that unreachable case, so this is the one place the two shapes meet. */
function fromStateOf(source: TransitionSource): NegotiationState | null {
  return source === "*" ? null : source;
}

/** Builds an `appendAuditEvent` call's transition-derived fields
 *  (`eventType`/`fromState`/`toState`/`reasonCode`) from a `StateTransition`
 *  the way every `resolve*Transition` function in `@repo/policy`'s ledger
 *  module returns it — so a call site only has to supply what the resolver
 *  can't derive (`sessionId`, `payload`, and optionally `offerId`/
 *  `policyVersion`). Centralized here because `StateTransition`'s own field
 *  names (`event`/`from`/`to`) intentionally do not match
 *  `AppendAuditEventParams`'s (`eventType`/`fromState`/`toState`) — see
 *  `packages/policy/contracts/state-machine.ts` vs.
 *  `packages/database/repositories/audit-events.ts`. */
function auditParamsFromTransition(
  transition: StateTransition,
  rest: Omit<AppendAuditEventParams, "eventType" | "fromState" | "toState" | "reasonCode">,
): AppendAuditEventParams {
  return {
    ...rest,
    eventType: transition.event,
    fromState: fromStateOf(transition.from),
    toState: transition.to,
    reasonCode: transition.reasonCode,
  };
}

/** Same field-name mismatch as {@link auditParamsFromTransition}, for
 *  `campaign-holds.ts`'s `CampaignHoldLedgerContext` (`eventType`/
 *  `fromState`/`toState`/`reasonCode`) instead of `StateTransition`'s own
 *  `event`/`from`/`to`/`reasonCode`. */
function ledgerContextFromTransition(
  transition: StateTransition,
  rest: Omit<CampaignHoldLedgerContext, "eventType" | "fromState" | "toState" | "reasonCode">,
): CampaignHoldLedgerContext {
  return {
    ...rest,
    eventType: transition.event,
    fromState: fromStateOf(transition.from),
    toState: transition.to,
    reasonCode: transition.reasonCode,
  };
}

/**
 * `acceptOffer`'s transaction returns one of these instead of throwing for
 * the autonomous-payment-blocked case — see that procedure's own comment on
 * why the TRPCError has to be thrown AFTER the transaction commits, not
 * from inside it.
 */
type AcceptOfferTxResult =
  | { blocked: true; reasonCode: string }
  | {
      blocked: false;
      value: {
        accepted: boolean;
        reasonCode: string;
        paymentHandle: {
          orderId: string;
          railOrderId: string;
          amountMinor: number;
          currency: "INR";
        } | null;
      };
    };

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
    .query(async ({ input, ctx }) => {
      const session = await getNegotiationSession(ctx.db, input.sessionId);
      if (!session) notFound("session", input.sessionId);

      const { skuCatalogue } = await loadMerchantNegotiationContext(ctx.db, session.merchantId);

      return {
        sessionId: session.id,
        lines: toPublicBasketLines(session.originalBasket, skuCatalogue),
        currency: "INR" as const,
        negotiationAvailable: session.state !== "IDLE",
      };
    }),

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
    .mutation(async ({ input, ctx }) => {
      const session = await getNegotiationSession(ctx.db, input.sessionId);
      if (!session) notFound("session", input.sessionId);

      if (session.state !== "IDLE" && session.state !== "AT_RISK") {
        badRequest(`session "${session.id}" has already left the pre-negotiation state (${session.state})`);
      }

      const { policy, skuCatalogue } = await loadMerchantNegotiationContext(ctx.db, session.merchantId);

      const eligibility = checkEligibility({
        session: { originalBasket: session.originalBasket, isFlaggedAtRisk: isFlaggedAtRisk(session.state) },
        policy,
        skuCatalogue,
      });

      const transition = resolveNegotiationRequestedTransition(eligibility);

      await appendAuditEvent(
        ctx.db,
        auditParamsFromTransition(transition, {
          sessionId: session.id,
          payload: { buyerAgentId: input.buyerAgentId },
          policyVersion: session.policyVersion,
        }),
      );

      await updateNegotiationSession(ctx.db, session.id, { state: transition.to });

      return {
        negotiationId: session.id,
        opened: eligibility.eligible,
        roundIndex: session.roundIndex,
        reasonCode: eligibility.reasonCode,
        message: messageForReasonCode(eligibility.reasonCode),
      };
    }),

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
    .mutation(async ({ input, ctx }) => {
      return ctx.db.transaction(async (tx) => {
        // FOR UPDATE: serializes concurrent propose calls on this session — a
        // second call blocks here until the first's transaction commits, then
        // sees the real post-write state instead of a stale "still OPEN"
        // snapshot (see this function's own doc in negotiation-sessions.ts).
        const session = await getNegotiationSessionForUpdate(tx, input.negotiationId);
        if (!session) notFound("negotiation", input.negotiationId);
        if (session.state !== "OPEN") {
          badRequest(`negotiation "${session.id}" is not open for a proposal (state ${session.state})`);
        }

        const { policy, skuCatalogue } = await loadMerchantNegotiationContext(tx, session.merchantId);
        const agentRoundIndex = session.roundIndex + 1;
        const now = new Date();

        // Round cap (PRD §14/§15's ROUND_INCREMENTED guard) — checked BEFORE
        // generating a fresh candidate set at all.
        const roundCap = evaluateRoundCap(agentRoundIndex, policy.maxRounds);
        if (!roundCap.allowed) {
          const transition = resolveRoundIncrementedTransition(agentRoundIndex, policy.maxRounds);
          await appendAuditEvent(
            tx,
            auditParamsFromTransition(transition, {
              sessionId: session.id,
              payload: { roundIndex: agentRoundIndex, maxRounds: policy.maxRounds },
              policyVersion: session.policyVersion,
            }),
          );
          await updateNegotiationSession(tx, session.id, { state: transition.to });
          return { roundIndex: session.roundIndex, offer: null, terminal: true, reasonCode: roundCap.reasonCode };
        }

        const generation = generateCandidates({
          session: {
            originalBasket: session.originalBasket,
            counterfactualContributionMinor: session.counterfactualContributionMinor,
            roundIndex: agentRoundIndex,
          },
          policy,
          skuCatalogue,
        });

        const availableCampaignBudgetMinor = await getAvailableCampaignBudgetMinor(tx, session.merchantId);

        const tierResult = assignTiersAndFeasibility({
          candidates: generation.candidates,
          tier1Refused: session.tier1Refused,
          perDealCapMinor: policy.perDealCapMinor,
          availableCampaignBudgetMinor,
        });

        const generatedTransition = resolveCandidatesGeneratedTransition(tierResult);
        await appendAuditEvent(
          tx,
          auditParamsFromTransition(generatedTransition, {
            sessionId: session.id,
            payload: { ...generation.counts },
            policyVersion: session.policyVersion,
          }),
        );

        if (!tierResult.feasible) {
          await updateNegotiationSession(tx, session.id, { state: generatedTransition.to });
          return { roundIndex: session.roundIndex, offer: null, terminal: true, reasonCode: tierResult.reasonCode };
        }

        const candidatesInRound = assignCandidateIdentity(tierResult.candidates, session.id, agentRoundIndex);
        await persistCandidatesForRound(tx, candidatesInRound);

        // Which candidate the merchant model will choose, decided up front so
        // Tier 2 campaign budget can be reserved BEFORE `mintOffer` — `mintOffer`
        // requires the reservation's outcome (and, for Tier 2, its `offerId`) as
        // a plain input (see `packages/policy/minting/mint.ts`'s own module
        // doc); `DeterministicMerchantModel.nextIntent` (below, via
        // `runNegotiationRound`) independently re-derives the identical choice
        // from the identical exposed set, so the two never disagree.
        const model = new DeterministicMerchantModel();
        const exposedCandidates = selectExposedCandidates(candidatesInRound, session.tier1Refused);
        const previewIntent = model.nextIntent({
          sessionId: session.id,
          roundIndex: agentRoundIndex,
          candidates: exposedCandidates,
          conversation: [],
        });
        const chosen = candidatesInRound.find((c) => c.candidateId === previewIntent.candidateId)!;

        let campaignBudgetReservation: CampaignBudgetReservationOutcome | undefined;

        if (chosen.tier === 2) {
          // RA-3: eligibility is re-checked once, here, before a Tier 2 mint —
          // never per round, and never before Tier 1. Catches, in particular,
          // the kill switch being flipped mid-negotiation (RA-1).
          //
          // isFlaggedAtRisk is hardcoded true, NOT re-derived from
          // session.state: this line only runs once the earlier `session.state
          // !== "OPEN"` guard has passed, and `openNegotiation` (this file)
          // only ever transitions a session to OPEN after `checkEligibility`
          // already required `isFlaggedAtRisk(session.state) === true` (i.e.
          // state was AT_RISK) at that time. A session that is currently OPEN
          // was therefore, necessarily, flagged at risk when it opened — the
          // frozen schema just has no separate column still recording that
          // once state has moved on. Re-deriving it from the CURRENT state
          // via `isFlaggedAtRisk(session.state)` evaluates false for every
          // OPEN session unconditionally, which made every Tier 2 proposal
          // fail this re-check with NOT_AT_RISK regardless of any real kill
          // switch or SKU-negotiability change — the actual things RA-3
          // exists to catch.
          const reCheck = checkEligibility({
            session: { originalBasket: session.originalBasket, isFlaggedAtRisk: true },
            policy,
            skuCatalogue,
          });
          if (!reCheck.eligible) {
            // No row in the frozen state machine models "RA-3 re-check failed
            // mid-negotiation" specifically (every NEGOTIATION_REQUESTED row is
            // keyed from IDLE/AT_RISK, not OPEN) — recorded as ISSUE-012
            // (issue-tracker.md) rather than fabricating a transition row.
            // Fails closed regardless: halts rather than mints.
            await appendAuditEvent(tx, {
              sessionId: session.id,
              eventType: "NEGOTIATION_REQUESTED",
              fromState: "OPEN",
              toState: "HALTED",
              reasonCode: reCheck.reasonCode,
              payload: { note: "RA-3 re-check before Tier 2 mint failed" },
              policyVersion: session.policyVersion,
            });
            await updateNegotiationSession(tx, session.id, { state: "HALTED" });
            return { roundIndex: session.roundIndex, offer: null, terminal: true, reasonCode: reCheck.reasonCode };
          }

          const reservationOfferId = randomUUID();
          const reserveResult = await reserveCampaignBudget(tx, {
            merchantId: session.merchantId,
            offerId: reservationOfferId,
            amountMinor: chosen.requiredCampaignSpendMinor,
            expiresAt: new Date(now.getTime() + policy.offerTtlSeconds * 1000),
            ledger: ledgerContextFromTransition(resolveBudgetReservedTransition(2), {
              sessionId: session.id,
              policyVersion: session.policyVersion,
            }),
          });

          campaignBudgetReservation = reserveResult.reserved
            ? { reserved: true, offerId: reservationOfferId, amountMinor: chosen.requiredCampaignSpendMinor }
            : { reserved: false, reasonCode: reserveResult.reasonCode };
        }

        const roundResult = await runNegotiationRound({
          sessionId: session.id,
          state: { roundIndex: agentRoundIndex, tier1Refused: session.tier1Refused } satisfies RoundState,
          policyVersion: session.policyVersion,
          candidatesInRound,
          conversation: [{ role: "buyer", content: input.message }],
          model,
          now,
          offerTtlSeconds: policy.offerTtlSeconds,
          campaignBudgetReservation,
        });

        if (roundResult.status === "WALKED_AWAY") {
          // Unreachable through `DeterministicMerchantModel` (see its own
          // module doc — it never emits WALK_AWAY), handled anyway for
          // exhaustiveness and in case a future model implementation does.
          await appendAuditEvent(tx, {
            sessionId: session.id,
            eventType: "AGENT_TERMINAL_INTENT",
            fromState: "OPEN",
            toState: "WALKED_AWAY",
            reasonCode: roundResult.reasonCode,
            payload: {},
            policyVersion: session.policyVersion,
          });
          await updateNegotiationSession(tx, session.id, { state: "WALKED_AWAY", roundIndex: agentRoundIndex });
          return { roundIndex: agentRoundIndex, offer: null, terminal: true, reasonCode: roundResult.reasonCode };
        }

        if (roundResult.status === "MINT_REJECTED") {
          // Only reachable via the Tier 2 reservation race documented on
          // `CampaignBudgetReservationOutcome` (the tiering-time snapshot said
          // feasible; the atomic reservation just above said otherwise) —
          // `chosen` was already proven feasible at tiering time, so
          // `resolveMintAttemptedTransition` (which requires `feasible: false`
          // on its input) does not apply here; this is the exact edge case
          // `lookupTransition` is exported for.
          const transition = lookupTransition("OPEN", "MINT_ATTEMPTED", roundResult.reasonCode);
          await appendAuditEvent(
            tx,
            auditParamsFromTransition(transition, {
              sessionId: session.id,
              payload: { candidateId: chosen.candidateId },
              policyVersion: session.policyVersion,
            }),
          );
          await updateNegotiationSession(tx, session.id, { state: transition.to, roundIndex: agentRoundIndex });
          return { roundIndex: agentRoundIndex, offer: null, terminal: true, reasonCode: roundResult.reasonCode };
        }

        // OFFER_MINTED
        const { offer, intent } = roundResult;

        // Persists the engine-signed `Offer` `mintOffer` returned — this is the
        // only place a row is ever written to `offers` for a fresh mint (the
        // frozen schema's own doc: "the payment path reads it from here, never
        // from a caller"). `acceptOffer`/`respondToOffer` and TICKET-111's own
        // `acceptOfferRepo` all read this table, so a mint that never reaches
        // it would be invisible to every later step in the protocol.
        await tx.insert(offersTable).values({
          id: offer.offerId,
          sessionId: offer.sessionId,
          candidateRef: offer.candidateId,
          roundIndex: offer.roundIndex,
          basket: offer.basket,
          totalMinor: offer.totalMinor,
          currency: offer.currency,
          tier: offer.tier,
          campaignSpendMinor: offer.campaignSpendMinor,
          policyVersion: offer.policyVersion,
          status: offer.status,
          reasonCode: offer.reasonCode,
          expiresAt: offer.expiresAt,
          engineSignature: offer.engineSignature,
        });

        const mintedTransition = resolveOfferMintedTransition(chosen, session.tier1Refused, true);
        await appendAuditEvent(
          tx,
          auditParamsFromTransition(mintedTransition, {
            sessionId: session.id,
            payload: { candidateId: chosen.candidateId, moveType: chosen.moveType },
            policyVersion: session.policyVersion,
            offerId: offer.offerId,
            campaignSpendMinor: offer.campaignSpendMinor,
          }),
        );

        await updateNegotiationSession(tx, session.id, {
          state: mintedTransition.to,
          roundIndex: agentRoundIndex,
        });

        return {
          roundIndex: agentRoundIndex,
          offer: toPublicOffer(offer, skuCatalogue, intent.messageFrame),
          terminal: false,
          reasonCode: mintedTransition.reasonCode,
        };
      });
    }),

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
    .mutation(async ({ input, ctx }) => {
      return ctx.db.transaction(async (tx) => {
        // FOR UPDATE: serializes against a concurrent acceptOffer/respondToOffer
        // on the same session — otherwise both can read OFFER_PENDING before
        // either writes, and a decline's unconditional setOfferStatus can
        // overwrite an already-accepted offer's status (see this function's
        // own doc in negotiation-sessions.ts).
        const session = await getNegotiationSessionForUpdate(tx, input.negotiationId);
        if (!session) notFound("negotiation", input.negotiationId);
        if (session.state !== "OFFER_PENDING") {
          badRequest(`negotiation "${session.id}" has no pending offer to respond to (state ${session.state})`);
        }

        const offer = await getOfferOrThrow(tx, input.offerId);
        if (offer.sessionId !== session.id) {
          badRequest(`offer "${offer.id}" does not belong to negotiation "${session.id}"`);
        }

        if (input.response === "WALK_AWAY") {
          const transition = resolveBuyerEndsSessionTransition();
          await appendAuditEvent(
            tx,
            auditParamsFromTransition(transition, {
              sessionId: session.id,
              payload: { offerId: offer.id },
              policyVersion: session.policyVersion,
              offerId: offer.id,
            }),
          );
          await setOfferStatus(tx, offer.id, "DECLINED");
          await updateNegotiationSession(tx, session.id, { state: transition.to });
          return { roundIndex: session.roundIndex, offer: null, terminal: true, reasonCode: transition.reasonCode };
        }

        // DECLINE_AND_CONTINUE
        const transition = resolveBuyerDeclinesTransition(offer.tier as 1 | 2);

        if (offer.tier === 2) {
          const hold = await getCampaignHoldByOfferId(tx, offer.id);
          if (hold) {
            // Appends its own HOLD_RELEASED ledger entry, atomically with the
            // hold write (`campaign-holds.ts`'s own TICKET-403 discipline) — no
            // separate `appendAuditEvent` call needed for this transition.
            await releaseCampaignHold(
              tx,
              hold.id,
              ledgerContextFromTransition(transition, {
                sessionId: session.id,
                policyVersion: session.policyVersion,
              }),
            );
          }
        } else {
          await appendAuditEvent(
            tx,
            auditParamsFromTransition(transition, {
              sessionId: session.id,
              payload: { offerId: offer.id },
              policyVersion: session.policyVersion,
              offerId: offer.id,
            }),
          );
        }

        const nextRoundState = applyOfferDeclined(
          { roundIndex: session.roundIndex, tier1Refused: session.tier1Refused },
          { tier: offer.tier as 1 | 2 },
        );

        await setOfferStatus(tx, offer.id, "DECLINED");
        await updateNegotiationSession(tx, session.id, {
          state: transition.to,
          tier1Refused: nextRoundState.tier1Refused,
        });

        return { roundIndex: session.roundIndex, offer: null, terminal: false, reasonCode: transition.reasonCode };
      });
    }),

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
    .mutation(async ({ input, ctx }) => {
      // The autonomous-payment gate below must APPEND its refusal to the
      // ledger and have that write actually survive — but this whole
      // handler runs inside one transaction (for the FOR UPDATE race fix),
      // and throwing from INSIDE a transaction rolls back everything in it,
      // including that same audit write. So the transaction below never
      // throws for this case; it returns a "blocked" result instead, and the
      // TRPCError is thrown out here, only once the transaction (audit event
      // included) has actually committed.
      const txResult = await ctx.db.transaction(async (tx): Promise<AcceptOfferTxResult> => {
        // FOR UPDATE: serializes against a concurrent respondToOffer/acceptOffer
        // on the same session — see negotiation-sessions.ts's own doc. Without
        // this, an accept and a decline could both read OFFER_PENDING and race
        // (respondToOffer's setOfferStatus has no CAS guard of its own).
        const session = await getNegotiationSessionForUpdate(tx, input.negotiationId);
        if (!session) notFound("negotiation", input.negotiationId);
        if (session.state !== "OFFER_PENDING") {
          badRequest(`negotiation "${session.id}" has no pending offer to accept (state ${session.state})`);
        }

        const offerBeforeAccept = await getOfferOrThrow(tx, input.offerId);
        if (offerBeforeAccept.sessionId !== session.id) {
          badRequest(`offer "${offerBeforeAccept.id}" does not belong to negotiation "${session.id}"`);
        }

        // Checked BEFORE ever consuming the offer below: offers are single-use
        // (TICKET-111), so consuming one and only then discovering autonomous
        // payment is enabled would strand the buyer with a permanently-consumed
        // offer and no path forward — a later retry would just report
        // OFFER_ALREADY_CONSUMED, even though nothing about the negotiation
        // itself failed. TICKET-306 owns the real enforced boundary; this
        // fails closed here, before any write, rather than after.
        const { policy } = await loadMerchantNegotiationContext(tx, session.merchantId);
        if (policy.autonomousPaymentExecution) {
          const paymentTransition = resolvePaymentInitiationTransition(true);
          await appendAuditEvent(
            tx,
            auditParamsFromTransition(paymentTransition, {
              sessionId: session.id,
              payload: { offerId: offerBeforeAccept.id },
              policyVersion: session.policyVersion,
              offerId: offerBeforeAccept.id,
            }),
          );
          return { blocked: true, reasonCode: paymentTransition.reasonCode };
        }

        const now = new Date();
        // The frozen input schema above carries no separate "basket the buyer
        // is trying to accept" field (see this ticket's issue-tracker entry) —
        // the only basket this endpoint can compare against is the offer's own,
        // so BASKET_MISMATCH is structurally unreachable through this specific
        // transport today. Still routed through the real repository function
        // (not skipped) so TTL and single-use are enforced exactly as TICKET-111
        // built them.
        const result = await acceptOfferRepo(tx, {
          offerId: offerBeforeAccept.id,
          acceptedBasket: offerBeforeAccept.basket,
          now,
        });

        if (!result.accepted) {
          const transition =
            result.reasonCode === "OFFER_EXPIRED"
              ? resolveTtlElapsedTransition(now, offerBeforeAccept.expiresAt)
              : resolveOfferAcceptTransition({
                  alreadyConsumed: result.reasonCode === "OFFER_ALREADY_CONSUMED",
                  basketMatches: result.reasonCode !== "BASKET_MISMATCH",
                });

          // An expired Tier 2 offer's campaign hold must be released here too
          // — otherwise its RESERVED row and ledger never reflect that this
          // offer is now dead, the same gap TICKET-403's release discipline
          // already closes for an explicit buyer decline (respondToOffer,
          // above). releaseCampaignHold appends its own ledger entry for this
          // exact transition, so it replaces (not adds to) the generic write.
          let holdReleased = false;
          if (result.reasonCode === "OFFER_EXPIRED" && offerBeforeAccept.tier === 2) {
            const hold = await getCampaignHoldByOfferId(tx, offerBeforeAccept.id);
            if (hold) {
              await releaseCampaignHold(
                tx,
                hold.id,
                ledgerContextFromTransition(transition, {
                  sessionId: session.id,
                  policyVersion: session.policyVersion,
                }),
              );
              holdReleased = true;
            }
          }

          if (!holdReleased) {
            await appendAuditEvent(
              tx,
              auditParamsFromTransition(transition, {
                sessionId: session.id,
                payload: { offerId: offerBeforeAccept.id },
                policyVersion: session.policyVersion,
                offerId: offerBeforeAccept.id,
              }),
            );
          }

          if (result.reasonCode === "OFFER_EXPIRED") {
            await updateNegotiationSession(tx, session.id, { state: transition.to });
          }

          return { blocked: false, value: { accepted: false, reasonCode: result.reasonCode, paymentHandle: null } };
        }

        const offer = result.offer;
        const acceptTransition = resolveOfferAcceptTransition({ alreadyConsumed: false, basketMatches: true });
        await appendAuditEvent(
          tx,
          auditParamsFromTransition(acceptTransition, {
            sessionId: session.id,
            payload: { offerId: offer.id },
            policyVersion: session.policyVersion,
            offerId: offer.id,
          }),
        );
        await setOfferStatus(tx, offer.id, "ACCEPTED");
        await updateNegotiationSession(tx, session.id, { state: acceptTransition.to });

        // policy.autonomousPaymentExecution is guaranteed false here (the
        // early check above already returned/threw otherwise).
        const paymentTransition = resolvePaymentInitiationTransition(policy.autonomousPaymentExecution);

        const railOrder = await createOrder(offer.id);

        await appendAuditEvent(
          tx,
          auditParamsFromTransition(paymentTransition, {
            sessionId: session.id,
            payload: { offerId: offer.id, railOrderId: railOrder.id },
            policyVersion: session.policyVersion,
            offerId: offer.id,
          }),
        );
        await updateNegotiationSession(tx, session.id, { state: paymentTransition.to });

        const localOrder = await getOrderByOfferId(tx, offer.id);
        if (!localOrder) {
          throw new Error(`acceptOffer: createOrder succeeded but no local order row exists for offer "${offer.id}"`);
        }

        return {
          blocked: false,
          value: {
            accepted: true,
            reasonCode: acceptTransition.reasonCode,
            paymentHandle: {
              orderId: localOrder.id,
              railOrderId: railOrder.id,
              amountMinor: offer.totalMinor,
              currency: "INR" as const,
            },
          },
        };
      });

      if (txResult.blocked) {
        // Thrown only now — the transaction above has already committed, so
        // the AUTONOMOUS_PAYMENT_NOT_AUTHORIZED audit event this throw is
        // reporting genuinely persisted, instead of being rolled back by it.
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `Autonomous payment execution is not implemented (TICKET-306). Reason: ${txResult.reasonCode}.`,
        });
      }

      return txResult.value;
    }),
});
