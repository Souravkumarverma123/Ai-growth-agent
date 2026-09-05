import { z } from "zod";
import type { Candidate, NegotiationIntent } from "@repo/policy";

/**
 * TICKET-201 — Seam 2 (CONTRACTS.md §8): "Tests inject a scripted
 * implementation, which is faithful by construction because the intent
 * carries no numbers."
 *
 * This file defines the abstraction only: the `NegotiationModel` interface
 * and the input it is given. It does NOT redefine the model's output type.
 *
 * `NegotiationIntent` — `{ candidateId, messageFrame, terminalAction? }` — is
 * FROZEN, defined once in `packages/policy/contracts/intent.ts`
 * (CONTRACTS.md §5.1), and is imported here unmodified. There is no numeric
 * field, and none may ever be added — see that file for the load-bearing
 * invariant. This package only ever *reads* that type; it never redeclares
 * or widens it.
 */

// ---------------------------------------------------------------------------
// Input — deliberately narrow (TICKET-201's own scope note)
// ---------------------------------------------------------------------------

/**
 * One turn of the buyer/agent transcript, chronological, oldest first.
 *
 * This is new to this package (not a frozen contract) — it exists because
 * driving an actual negotiation requires knowing what the buyer said. B4
 * (CONTRACTS.md §2) forbids conversation content from reaching
 * `packages/policy`'s candidate generator; it says nothing about this
 * package, whose entire reason to exist is reading buyer text and deciding
 * how to respond.
 */
export const CONVERSATION_ROLES = ["buyer", "agent"] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];
export const conversationRoleSchema = z.enum(CONVERSATION_ROLES);

export const conversationTurnSchema = z.object({
  role: conversationRoleSchema,
  content: z.string(),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

/**
 * Everything a `NegotiationModel` needs to decide "what shape" for one round.
 *
 * Kept to exactly what a scripted double needs to drive a full negotiation
 * end to end (this ticket's own acceptance criterion) — not speculative
 * fields for the orchestration loop TICKET-202 has not built yet.
 *
 * `candidates` is this round's engine-authored candidate set, already
 * filtered to what this round may expose (Tier 1 only until a refusal is
 * logged) — that gating is TICKET-202's job, applied before this input is
 * constructed, not this ticket's. Reusing the frozen `Candidate` type from
 * `@repo/policy` rather than inventing a parallel shape.
 */
export interface NegotiationRoundInput {
  readonly sessionId: string;
  /** 1-based model round; persisted `NegotiationSession.roundIndex` starts at 0. */
  readonly roundIndex: number;
  /** This round's engine-authored, already-unlocked candidate set. */
  readonly candidates: readonly Candidate[];
  /** Buyer + agent transcript so far. Empty on the first round. */
  readonly conversation: readonly ConversationTurn[];
}

// ---------------------------------------------------------------------------
// The abstraction itself
// ---------------------------------------------------------------------------

/**
 * The model's entire output surface to the deterministic engine.
 *
 * `nextIntent` must return (or resolve to) a `NegotiationIntent` — one of
 * `input.candidates`' ids, a `messageFrame`, and optionally
 * `terminalAction: "WALK_AWAY"`. Nothing else is producible: the return type
 * is the frozen, numberless contract, imported unmodified.
 *
 * Implementations may be synchronous (the scripted test double below) or
 * asynchronous (a real model call) — every caller must handle both.
 */
export interface NegotiationModel {
  nextIntent(input: NegotiationRoundInput): NegotiationIntent | Promise<NegotiationIntent>;
}
