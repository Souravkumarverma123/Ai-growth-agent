import { buyerConstraintsSchema, type BuyerConstraints } from "./buyer-constraints";
import { renderBuyerSystemPrompt } from "./buyer-prompt";
import { createSeededRandom, randomChoice, type SeededRandom } from "./seeded-random";

/**
 * TICKET-206 — the buyer agent itself.
 *
 * ============================================================================
 * WHY THIS IS A DETERMINISTIC STAND-IN, NOT A LIVE MODEL CALL
 * ============================================================================
 * The ticket calls for a "stock model" buyer with hidden constraints. This
 * repo has no model SDK in its lockfile and no API credentials in CI, and
 * the acceptance criterion "two seeded runs produce the two documented
 * outcomes" requires the buyer to be reproducible. So `BuyerAgent` is a
 * faithful stand-in: it plays the buyer side using only the same information
 * a real model would be given (its {@link BuyerConstraints} and what the
 * seller has offered), and it makes the same class of decision a real buyer
 * makes — take it, push back, or walk — driven by a seeded generator so a
 * `(constraints, seed)` pair fully determines the run.
 *
 * ============================================================================
 * THE RESERVATION PRICE NEVER LEAVES THIS OBJECT
 * ============================================================================
 * `reactToOffer` is handed only `{ totalMinor, currency }` — the buyer-facing
 * shape of an offer — and returns only ACCEPT / DECLINE / WALK_AWAY plus a
 * free-text message. Every message this class can emit is drawn from a fixed
 * phrase pool, and no phrase contains a digit. There is therefore no field
 * and no string through which `budgetMinor` could reach the merchant agent
 * (acceptance criterion: "The merchant agent never receives the reservation
 * price"). This mirrors the discipline `NegotiationIntent` uses on the
 * merchant side (CONTRACTS.md §5.1): the invariant is kept by there being no
 * place to put the number, not by remembering not to.
 */

/** The slice of a minted offer the buyer is allowed to see. */
export interface MerchantOfferView {
  readonly totalMinor: number;
  readonly currency: "INR";
}

export type BuyerAction =
  | { readonly kind: "ACCEPT"; readonly message: string }
  | { readonly kind: "DECLINE"; readonly message: string }
  | { readonly kind: "WALK_AWAY"; readonly message: string };

export interface BuyerAgentOptions {
  /** Fully determines the run together with the constraints. Default 1. */
  readonly seed?: number;
  /**
   * How many times the buyer will push back on an offer that is still over
   * budget before walking away. Default 2 — decline twice, walk on the third
   * offer that is still unacceptable.
   */
  readonly patience?: number;
}

const OPENING_MESSAGES: readonly string[] = [
  "Hi — I'm interested in this cart but the price is more than I want to spend. What can you do?",
  "I'd like to buy this, but not at the current total. Is there a better deal available?",
  "Keen on these items. The total's a bit high for me though — can we work something out?",
];

const DECLINE_MESSAGES: readonly string[] = [
  "That's still above what I'm looking to spend. Can you get closer?",
  "Appreciate it, but that doesn't quite work for me yet. Anything more you can do?",
  "Still a little high for me. I was hoping for better.",
  "Not there yet, I'm afraid. Can you sharpen the pencil a bit more?",
];

const WALK_AWAY_MESSAGES: readonly string[] = [
  "I don't think we're going to meet in the middle on this one. I'll leave it for now — thanks.",
  "That's as far as I can go, and it's still not workable. I'll pass. Thanks anyway.",
  "We're too far apart. I'm going to walk away here.",
];

const ACCEPT_MESSAGES: readonly string[] = [
  "That works for me — let's do it.",
  "Deal. I'll take that.",
  "Good enough — I'm happy with that. Let's go ahead.",
];

export class BuyerAgent {
  readonly constraints: BuyerConstraints;
  readonly systemPrompt: string;

  private readonly rng: SeededRandom;
  private readonly patience: number;
  private declineCount = 0;

  constructor(constraints: BuyerConstraints, options: BuyerAgentOptions = {}) {
    this.constraints = buyerConstraintsSchema.parse(constraints);
    this.systemPrompt = renderBuyerSystemPrompt(this.constraints);
    this.rng = createSeededRandom(options.seed ?? 1);
    this.patience = options.patience ?? 2;
    if (!Number.isInteger(this.patience) || this.patience < 0) {
      throw new Error(`BuyerAgent: patience must be a non-negative integer, got ${String(this.patience)}`);
    }
  }

  /** How many offers the buyer has declined so far this negotiation. */
  get declinesSoFar(): number {
    return this.declineCount;
  }

  /** The buyer's opening line. Never states the budget (no digits). */
  openingMessage(): string {
    return randomChoice(this.rng, OPENING_MESSAGES);
  }

  /**
   * Decide what to do with a merchant offer. Pure function of the buyer's
   * hidden budget and this offer's total — plus the seeded generator, which
   * only ever picks the *wording*, never the decision.
   *
   * Accepts at or below budget. Otherwise pushes back, until it has pushed
   * back `patience` times, then walks. The merchant learns only which of the
   * three it was.
   */
  reactToOffer(offer: MerchantOfferView): BuyerAction {
    if (offer.totalMinor <= this.constraints.budgetMinor) {
      return { kind: "ACCEPT", message: randomChoice(this.rng, ACCEPT_MESSAGES) };
    }

    this.declineCount += 1;
    if (this.declineCount > this.patience) {
      return { kind: "WALK_AWAY", message: randomChoice(this.rng, WALK_AWAY_MESSAGES) };
    }
    return { kind: "DECLINE", message: randomChoice(this.rng, DECLINE_MESSAGES) };
  }
}
