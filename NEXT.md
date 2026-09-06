# NEXT — Ticket Solve Order

The live, ordered queue of what's left. Generated from `Tickets.md`'s
statuses/dependencies on 2026-09-06 (re-derived after TICKET-305 closed) —
**re-derive this whenever a ticket flips to `DONE` or a new one is added**,
don't hand-edit around a stale ordering. Full acceptance criteria live in
`Tickets.md`; this file only answers "what's next and why."

**Ordering rule:** dependency-ready first, then priority (P0 before P1 before
P2), with the payment control-path and invariant suites ahead of `apps/web`
UI polish — per `Tickets.md`'s own stated philosophy ("depth of the core
invariant beats feature count").

34 of 46 tickets are `DONE`. 12 remain.

## Solve in this order

1. **[TICKET-601](Tickets.md#ticket-601--invariant-suite-economics)** — Invariant suite: economics · P0 · ready now
   Parallelizable with 602/604 (different files) — good candidate for a worktree-isolated agent.
2. **[TICKET-602](Tickets.md#ticket-602--invariant-suite-offer-lifecycle-and-idempotency)** — Invariant suite: offer lifecycle and idempotency · P0 · ready now
   Also parallelizable alongside 601/604.
3. **[TICKET-604](Tickets.md#ticket-604--invariant-suite-payment-and-rail-authority)** — Invariant suite: payment and rail authority · P0 · ready now
   Unblocked by TICKET-305 (closed 2026-09-06). The last payment-path P0. Note ISSUE-012 sub-issue 12e — needs a Tier 2 catalog fixture nothing in the repo provides yet.
4. **[TICKET-205](Tickets.md#ticket-205--mcp-server-adapter)** — MCP server adapter · P1 · ready now
   Unblocks 206, which unblocks 603.
5. **[TICKET-206](Tickets.md#ticket-206--buyer-agent-harness)** — Buyer agent harness · P1 · blocked on 205
   Closes the longest dependency chain in the whole plan (Phase 0 → 102 → 103 → 104 → 110 → 202 → 204 → 205 → 206).
6. **[TICKET-603](Tickets.md#ticket-603--invariant-suite-injection-resistance-and-eligibility)** — Invariant suite: injection resistance and eligibility · P0 · blocked until Phase 2 (205+206) closes
7. **[TICKET-506](Tickets.md#ticket-506--minimal-buyer-surface)** — Minimal buyer surface · P1 · ready now
   Most demo-visible of the remaining UI work — do this before the smaller display widgets.
8. **[TICKET-502](Tickets.md#ticket-502--live-negotiation-event-stream)** — Live negotiation event stream · P1 · ready now
9. **[TICKET-503](Tickets.md#ticket-503--campaign-budget-countdown)** — Campaign budget countdown · P1 · ready now
10. **[TICKET-505](Tickets.md#ticket-505--audit-trail-display)** — Audit trail display · P1 · ready now
11. **[TICKET-504](Tickets.md#ticket-504--offer-status-and-ttl-display)** — Offer status and TTL display · P2 · ready now · drop first if time runs out
12. **[TICKET-508](Tickets.md#ticket-508--walk-away-policy-change-card)** — Walk-away policy-change card · P2 · ready now · drop first if time runs out

## Parallelizable right now

Everything below has all its dependencies satisfied *today* — a good set to
hand to separate worktree-isolated agents simultaneously instead of working
the list strictly top-to-bottom: `601`, `602`, `604`, `205`, `502`, `503`,
`505`, `506`, `504`, `508`. (`206` and `603` each wait on one item above
them.)

## Known blockers worth knowing about before you start

- **ISSUE-012, sub-issue 12b** (`issue-tracker.md`): `packages/payments`'s
  older repository functions (`offer-repository.ts`, `create-order.ts`) still
  bind to a singleton `db` instead of taking a generic `NodePgDatabase`.
  TICKET-305 did not end up needing them (its tests compose `reconcileOrder`,
  `reserveCampaignBudget`, and `releaseCampaignHold`, all already generic),
  but TICKET-604 may still hit this if it exercises the order-creation path
  end-to-end.
- **ISSUE-012, sub-issue 12e**: no catalog fixture in this repo can actually
  force a Tier 2 mint end-to-end through `propose` (the deterministic
  merchant model always prefers a self-funding candidate). TICKET-604 or
  TICKET-206 will need to build one.
- **ISSUE-014**: any *new* real-Postgres test file added to a package that
  already has one needs to double-check `vitest.config.ts` has
  `fileParallelism: false` — Vitest runs test files in a package concurrently
  by default, and two files sharing one physical test database will race
  each other's `truncateAllTables()` otherwise. Already fixed for
  `packages/database`, `packages/trpc`, and (as of TICKET-304)
  `packages/payments` — check before adding a fourth.
- **ISSUE-011 / ISSUE-012 sub-issue 12a, 12d**: both marked
  `NEEDS_SPEC_DECISION` — a money-formatting boundary, and stale-policy-
  version reads mid-negotiation. Neither blocks the tickets above directly,
  but flag them rather than silently deciding either while touching nearby
  code.
