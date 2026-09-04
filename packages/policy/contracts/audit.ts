import { z } from "zod";
import { reasonCodeSchema } from "./reason-codes";
import { negotiationEventSchema, negotiationStateSchema } from "./state-machine";

/**
 * FROZEN CONTRACT — PRD.md §13, CONTRACTS.md §7.
 *
 * The ledger is append-only. No update path and no delete path exists or may be
 * written. Every state transition writes exactly one event carrying exactly one
 * reason code.
 *
 * LIMITATION, STATED OPENLY: the hash chain is SELF-ANCHORED. An attacker with
 * write access to the database could rewrite the entire chain consistently and
 * it would still verify. External anchoring is an extension point, not an MVP
 * claim — do not overstate this in code comments, UI copy, or the demo.
 */
export const auditEventSchema = z.object({
  eventId: z.string().uuid(),
  /** Monotonic within a session. Ordering is part of the evidence. */
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  timestamp: z.date(),

  eventType: negotiationEventSchema,
  fromState: negotiationStateSchema.nullable(),
  toState: negotiationStateSchema,

  /**
   * THE JUSTIFICATION. Deterministic, authoritative, emitted by engine code,
   * consulted by decision paths. Required — a transition with no code cannot be
   * recorded.
   */
  reasonCode: reasonCodeSchema,

  /** Candidate counts, contribution figures, shortfall, hold movement. */
  payload: z.record(z.string(), z.unknown()),

  policyVersion: z.number().int().nonnegative().nullable(),
  offerId: z.string().uuid().nullable(),
  campaignHoldId: z.string().uuid().nullable(),
  campaignSpendMinor: z.number().int().nullable(),

  /**
   * THE EXPLANATION. Human-readable, NON-AUTHORITATIVE, never read by any
   * decision path.
   *
   * A short final rationale only — one or two sentences (RA-5). NEVER
   * chain-of-thought, intermediate deliberation, or reasoning traces.
   *
   * If the model lies here, the explanation is wrong, the decision is still
   * correct, and the reason code above is what produced it.
   */
  modelExplanation: z.string().max(500).nullable(),

  prevHash: z.string().nullable(),
  eventHash: z.string().min(1),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

/** The fields that are hashed, in this order. Changing this breaks every chain. */
export const HASHED_FIELDS = [
  "sequence",
  "sessionId",
  "eventType",
  "fromState",
  "toState",
  "reasonCode",
  "payload",
  "prevHash",
] as const;
