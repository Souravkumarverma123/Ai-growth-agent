import { TRPCError } from "@trpc/server";

import { z } from "../../schema";
import { publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

/**
 * FROZEN CONTRACT — PRD.md §13. Signatures only; bodies are stubs for Phase 0
 * (TICKET-006). Implementations land in TICKET-404.
 *
 * Read-only by construction: the ledger is append-only, so no write procedure
 * exists here or may be added.
 */

const TAGS = ["Audit"];
const getPath = generatePath("/audit");

const notImplemented = (ticket: string) => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `Stubbed during Phase 0 contract freeze. Implemented by ${ticket}.`,
  });
};

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
    .query(async () => notImplemented("TICKET-404")),

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
    .query(async () => notImplemented("TICKET-404")),
});
