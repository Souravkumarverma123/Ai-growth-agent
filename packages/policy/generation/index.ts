/**
 * TICKET-103 — the bounded, deterministic candidate generator, built on top
 * of the frozen contracts and the economics layer. Pure functions only — see
 * CONTRACTS.md §2 (no I/O in `packages/policy`).
 *
 * TICKET-105 (`./round-envelope`) and TICKET-106 (`./floor-enforcement`)
 * extract pieces `./candidates` originally computed inline; `./candidates`
 * now imports from both rather than defining them itself.
 */
export * from "./candidates";
export * from "./tiering";
export * from "./round-envelope";
export * from "./floor-enforcement";
