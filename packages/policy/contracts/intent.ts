import { z } from "zod";

/**
 * FROZEN CONTRACT — PRD.md §10.1, CONTRACTS.md §5.1.
 *
 * ============================================================================
 * THE LOAD-BEARING INVARIANT OF THIS SYSTEM
 * ============================================================================
 *
 * This is the model's ENTIRE output surface to the deterministic engine.
 *
 * It contains NO NUMERIC FIELD, and none may ever be added.
 *
 * When asked "what if the model hallucinates a price?", the answer is not
 * "we validate it" — it is: there is no field for a price to go in. A
 * validation can be argued with; a missing field cannot.
 *
 * If a ticket appears to need a number here, it does not. The number it wants
 * already exists on the engine-authored candidate the model selected. Record
 * the confusion in issue-tracker.md rather than widening this type.
 * ============================================================================
 */

/** Which aspect of the trade the outbound message leads with. */
export const MESSAGE_FRAMES = [
  "BUNDLE_VALUE",
  "SLOW_MOVING_CLEARANCE",
  "COMMITMENT_TRADE",
  "QUANTITY_VALUE",
  "FINAL_POSITION",
] as const;

export type MessageFrame = (typeof MESSAGE_FRAMES)[number];
export const messageFrameSchema = z.enum(MESSAGE_FRAMES);

/**
 * Strict: unknown keys are rejected at runtime, so a numeric field cannot be
 * smuggled in through a model response even if the type were bypassed.
 */
export const negotiationIntentSchema = z.strictObject({
  /** Must exist in this round's engine-authored candidate set. */
  candidateId: z.string().min(1),
  messageFrame: messageFrameSchema,
  /** WALK_AWAY is the only terminal action the model may select. */
  terminalAction: z.literal("WALK_AWAY").optional(),
});

export type NegotiationIntent = z.infer<typeof negotiationIntentSchema>;

/**
 * Compile-time proof that NegotiationIntent has no numeric field.
 *
 * If someone adds `discountMinor: number` to the schema above, NumericKeys
 * stops resolving to `never` and this assignment fails to typecheck. The build
 * breaks at the moment the invariant is broken, not in review.
 */
type NumericKeys<T> = {
  [K in keyof T]-?: number extends T[K] ? K : never;
}[keyof T];

type AssertNoNumericFields = [NumericKeys<NegotiationIntent>] extends [never] ? true : never;

const _intentHasNoNumericField: AssertNoNumericFields = true;
void _intentHasNoNumericField;
