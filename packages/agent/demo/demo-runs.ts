import { runDemoNegotiation, type DemoNegotiationResult } from "./negotiation-harness";
import type { BuyerConstraints } from "../buyer";

/**
 * TICKET-206 — the two documented demo runs (PRD §18.1: "Two runs with
 * different hidden budgets, producing materially different endings — one
 * closing, one walking away").
 *
 * Same catalogue, same goal, same latitude, same seed — only `budgetMinor`
 * differs, and that one difference flips the ending. This is the strongest
 * available proof, in a recorded format, that the buyer is not scripted.
 *
 * With the reference scenario's Tier 1 offer at ₹2,500 and its feasible
 * Tier 2 offer at ₹1,835 (round 2), then the per-deal cap making a deeper
 * Tier 2 discount infeasible in round 3:
 *
 *  - CLOSING run — budget ₹2,100: refuses the ₹2,500 Tier 1 offer, then
 *    accepts the ₹1,835 campaign-funded Tier 2 offer. Deal.
 *  - WALK-AWAY run — budget ₹1,600: refuses ₹2,500, refuses ₹1,835, and in
 *    round 3 the engine can no longer fund a deeper discount without
 *    breaching the per-deal cap — so the merchant is back to ₹2,500 and the
 *    buyer walks, with campaign budget still unspent. PRD §18.2's "a
 *    different limit binds" ending.
 */

const SHARED: Pick<BuyerConstraints, "goal" | "latitude"> = {
  goal: "Buy my usual Vitamin C serum and gentle cleanser without paying more than they're worth to me.",
  latitude: "Push back a couple of times if the price is too high. Take a good offer when you see one; walk away if we're clearly not going to get there.",
};

export const CLOSING_RUN = {
  seed: 206,
  constraints: { ...SHARED, budgetMinor: 210_000 } satisfies BuyerConstraints,
} as const;

export const WALK_AWAY_RUN = {
  seed: 206,
  constraints: { ...SHARED, budgetMinor: 160_000 } satisfies BuyerConstraints,
} as const;

export interface DocumentedDemoRuns {
  readonly closing: DemoNegotiationResult;
  readonly walkAway: DemoNegotiationResult;
}

/** Runs both documented negotiations and returns their results. */
export async function runDocumentedDemoNegotiations(): Promise<DocumentedDemoRuns> {
  const [closing, walkAway] = await Promise.all([
    runDemoNegotiation(CLOSING_RUN),
    runDemoNegotiation(WALK_AWAY_RUN),
  ]);
  return { closing, walkAway };
}
