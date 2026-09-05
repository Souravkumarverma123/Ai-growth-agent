/**
 * TICKET-103 — the bounded, deterministic candidate generator, built on top
 * of the frozen contracts and the economics layer. Pure functions only — see
 * CONTRACTS.md §2 (no I/O in `packages/policy`).
 *
 * TICKET-105 (`./round-envelope`) and TICKET-106 (`./floor-enforcement`)
 * extract pieces `./candidates` originally computed inline; `./candidates`
 * now imports from both rather than defining them itself.
 *
 * TICKET-109 (`./objective-ordering`) picks one candidate out of the
 * feasible set TICKET-104's `./tiering` marks — a separate concern from
 * tiering itself, so it lives in its own file rather than growing
 * `tiering.ts`.
 */
export * from "./candidates";
export * from "./tiering";
export * from "./round-envelope";
export * from "./floor-enforcement";
export * from "./objective-ordering";
