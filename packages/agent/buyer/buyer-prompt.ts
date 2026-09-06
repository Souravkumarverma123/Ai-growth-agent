import type { BuyerConstraints } from "./buyer-constraints";

/**
 * TICKET-206 — the buyer agent's system prompt.
 *
 * ============================================================================
 * WHAT THIS PROMPT MAY CONTAIN, AND WHAT IT MUST NOT
 * ============================================================================
 * Acceptance criterion: "The prompt is displayable on screen and visibly
 * contains no script." So this function renders a fixed frame with exactly
 * three slots — `budgetMinor`, `goal`, `latitude` — and nothing else. There
 * is no step list, no "first do X then Y", no target price, no target
 * outcome, and no mention of the merchant's floors, tiers, concession curve,
 * or campaign budget. A reader looking at the rendered string can see at a
 * glance that the buyer is not following a script.
 *
 * The budget is the buyer's own private information — it appears here (this
 * is the buyer's prompt) with an explicit instruction never to state it to
 * the seller. The harness enforces that structurally too: {@link BuyerAgent}
 * only ever emits free text with no digits and accept/decline/walk
 * decisions, so the reservation price cannot leak onto the wire even if this
 * instruction were ignored.
 *
 * Money stays in integer minor units (CONTRACTS.md §3: rupee formatting
 * happens only at the React render boundary — a prompt string is not that
 * boundary).
 */
export function renderBuyerSystemPrompt(constraints: BuyerConstraints): string {
  const { budgetMinor, goal, latitude } = constraints;

  return [
    "You are an autonomous buyer agent negotiating one checkout on behalf of a shopper.",
    "",
    `Your budget: ${budgetMinor} (minor currency units). This is the most you may agree to pay.`,
    "Keep this figure to yourself — never state it, hint at it, or confirm a guess at it to the seller.",
    "",
    `Your goal: ${goal}`,
    "",
    `Your latitude: ${latitude}`,
    "",
    "There is no script and no required outcome. Decide each message yourself from what the",
    "seller offers: accept an offer if the terms work for you, keep negotiating if they do not,",
    "and walk away if it is clear no acceptable deal is on the table.",
  ].join("\n");
}
