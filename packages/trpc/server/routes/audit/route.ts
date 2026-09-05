import { getAuditEventsForSession } from "@repo/database/repositories/audit-events";
import { verifyChain, type ChainEvent } from "@repo/policy";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

/**
 * FROZEN CONTRACT — PRD.md §13. Signatures were fixed in Phase 0
 * (TICKET-006); bodies are implemented here (TICKET-404).
 *
 * Read-only by construction: the ledger is append-only, so no write procedure
 * exists here or may be added.
 */

const TAGS = ["Audit"];
const getPath = generatePath("/audit");

const auditEventViewSchema = z.object({
  eventId: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  eventType: z.string(),
  fromState: z.string().nullable(),
  toState: z.string(),

  /** THE JUSTIFICATION — deterministic, authoritative. */
  reasonCode: z.string(),
  payload: z.record(z.string(), z.unknown()),

  policyVersion: z.number().int().nullable(),
  offerId: z.string().nullable(),
  campaignSpendMinor: z.number().int().nullable(),

  /**
   * THE EXPLANATION — non-authoritative, and labelled as such in the response
   * so a consumer cannot mistake it for the reason the decision was made.
   */
  modelExplanation: z.string().nullable(),
  modelExplanationIsAuthoritative: z.literal(false),

  prevHash: z.string().nullable(),
  eventHash: z.string(),
});

export const auditRouter = router({
  /** A completed negotiation must be fully reconstructable from this alone. */
  getSessionLedger: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/session/{sessionId}"), tags: TAGS } })
    .input(z.object({ sessionId: z.string() }))
    .output(z.object({ events: z.array(auditEventViewSchema) }))
    .query(async ({ input, ctx }) => {
      const events = await getAuditEventsForSession(ctx.db, input.sessionId);

      return {
        events: events.map((event) => ({
          eventId: event.id,
          sequence: event.sequence,
          timestamp: event.timestamp.toISOString(),
          eventType: event.eventType,
          fromState: event.fromState,
          toState: event.toState,

          reasonCode: event.reasonCode,
          payload: event.payload,

          policyVersion: event.policyVersion,
          offerId: event.offerId,
          campaignSpendMinor: event.campaignSpendMinor,

          modelExplanation: event.modelExplanation,
          modelExplanationIsAuthoritative: false as const,

          prevHash: event.prevHash,
          eventHash: event.eventHash,
        })),
      };
    }),

  /**
   * Chain verification. Note the honest limitation: the chain is self-anchored,
   * so this proves internal consistency, not tamper-proofness against an
   * attacker with database write access (PRD §13.3).
   */
  verifyChain: publicProcedure
    .meta({ openapi: { method: "GET", path: getPath("/session/{sessionId}/verify"), tags: TAGS } })
    .input(z.object({ sessionId: z.string() }))
    .output(
      z.object({
        valid: z.boolean(),
        eventCount: z.number().int().nonnegative(),
        brokenAtSequence: z.number().int().nullable(),
        selfAnchored: z.literal(true),
      }),
    )
    .query(async ({ input, ctx }) => {
      const events = await getAuditEventsForSession(ctx.db, input.sessionId);
      const result = verifyChain(events as unknown as ChainEvent[]);

      return {
        valid: result.valid,
        eventCount: result.eventCount,
        brokenAtSequence: result.valid ? null : result.brokenAtSequence,
        selfAnchored: true as const,
      };
    }),
});
