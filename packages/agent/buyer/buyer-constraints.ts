import { z } from "zod";

/**
 * TICKET-206 — buyer agent harness (PRD §18, §18.1; CONTRACTS.md §5.1).
 *
 * The buyer agent's ENTIRE hidden state. Three things and nothing else:
 *
 *  - `budgetMinor`  — the buyer's reservation price: the most it is willing
 *    to pay for this cart, in integer minor units (paise), CONTRACTS.md §3.
 *    This is the number that stays hidden from the merchant agent
 *    (acceptance criterion: "The merchant agent never receives the
 *    reservation price"). The harness never puts it on the wire — the buyer
 *    only ever emits free text and accept/decline/walk decisions, none of
 *    which carry a number (see {@link BuyerAgent}).
 *  - `goal`        — a plain-language sentence describing what the buyer
 *    wants (e.g. "buy my usual serum and cleanser without overpaying").
 *  - `latitude`    — a plain-language sentence describing how the buyer is
 *    allowed to negotiate (e.g. "push back once or twice, then take the best
 *    offer or walk").
 *
 * There is deliberately NO field for a script, a target price, a target
 * outcome, a per-round plan, or any knowledge of the merchant's floors,
 * tiers, concession curve or campaign budget. The prompt built from this
 * ({@link renderBuyerSystemPrompt}) is displayable on screen and visibly
 * contains none of those things — that is the point of the type being this
 * small.
 */
export const buyerConstraintsSchema = z.object({
  /** Reservation price in paise. Integer minor units only (CONTRACTS.md §3). */
  budgetMinor: z.number().int().nonnegative(),
  /** One plain-language sentence. No steps, no numbers. */
  goal: z.string().min(1),
  /** One plain-language sentence describing negotiating latitude. */
  latitude: z.string().min(1),
});

export type BuyerConstraints = z.infer<typeof buyerConstraintsSchema>;
