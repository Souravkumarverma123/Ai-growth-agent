/**
 * TICKET-401 — hash-chaining primitives for the append-only ledger.
 * Pure (CONTRACTS.md §2, §8) — no database, no I/O. See `hash-chain.ts`.
 *
 * TICKET-402 — the transition resolver wiring the frozen state machine to
 * the ledger: one function per transition family, each deriving the exact
 * `TRANSITIONS` row from typed business-decision inputs so a caller never
 * supplies a reason code directly. See `transition-resolver.ts`.
 */
export * from "./hash-chain";
export * from "./transition-resolver";
