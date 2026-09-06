# NEXT — Ticket Solve Order

The live, ordered queue of what's left. Generated from `Tickets.md`'s
statuses/dependencies on 2026-09-06 (re-derived after TICKET-206 closed) —
**re-derive this whenever a ticket flips to `DONE` or a new one is added**,
don't hand-edit around a stale ordering. Full acceptance criteria live in
`Tickets.md`; this file only answers "what's next and why."

**Ordering rule:** dependency-ready first, then priority (P0 before P1 before
P2), with the payment control-path and invariant suites ahead of `apps/web`
UI polish — per `Tickets.md`'s own stated philosophy ("depth of the core
invariant beats feature count").

39 of 46 tickets are `DONE`. 7 remain.

## Solve in this order

1. **[TICKET-603](Tickets.md#ticket-603--invariant-suite-injection-resistance-and-eligibility)** — Invariant suite: injection resistance and eligibility · P0 · ready now
   The last invariant-suite P0. Its dependency (TICKET-206, Phase 2 close) is now done.
2. **[TICKET-506](Tickets.md#ticket-506--minimal-buyer-surface)** — Minimal buyer surface · P1 · ready now
   Most demo-visible of the remaining UI work — do this before the smaller display widgets.
3. **[TICKET-502](Tickets.md#ticket-502--live-negotiation-event-stream)** — Live negotiation event stream · P1 · ready now
4. **[TICKET-503](Tickets.md#ticket-503--campaign-budget-countdown)** — Campaign budget countdown · P1 · ready now
5. **[TICKET-505](Tickets.md#ticket-505--audit-trail-display)** — Audit trail display · P1 · ready now
6. **[TICKET-504](Tickets.md#ticket-504--offer-status-and-ttl-display)** — Offer status and TTL display · P2 · ready now · drop first if time runs out
7. **[TICKET-508](Tickets.md#ticket-508--walk-away-policy-change-card)** — Walk-away policy-change card · P2 · ready now · drop first if time runs out

## Parallelizable right now

Everything remaining has all its dependencies satisfied *today* — a good set
to hand to separate worktree-isolated agents simultaneously: `603`, `502`,
`503`, `505`, `506`, `504`, `508`.

## Known blockers worth knowing about before you start

- **ISSUE-017** (`issue-tracker.md`, found in TICKET-206): on PRD §18.2's own
  cart the frozen concession curve's smallest step (0.4 × ₹950 headroom =
  ₹380) exceeds §18.2's own ₹200 per-deal cap, so `generateCandidates`
  cannot produce §18.2's round-2 Tier 2 offer at all. `NEEDS_SPEC_DECISION`.
  TICKET-206's harness worked around it with a ₹700-cap demo fixture; any
  ticket that wants to reproduce §18.2's *exact* figures end to end is
  blocked on the spec decision.
- **ISSUE-012, sub-issue 12b** (`issue-tracker.md`): `packages/payments`'s
  older repository wrappers (`offer-repository.ts`, `order-repository.ts`)
  bind to a singleton `db` instead of taking a generic `NodePgDatabase`, so
  `createOrder` cannot be driven end-to-end against the shared sibling test
  database. Still open for any future ticket that must go through
  `createOrder` itself.
- **ISSUE-012, sub-issue 12e**: no fixture forces a Tier 2 mint end-to-end
  through the DB-backed `propose` HTTP path (the deterministic tRPC merchant
  model always prefers a self-funding candidate). TICKET-206 addressed this
  for the *pure-engine* harness path only (`DemoMerchantModel` picks the
  lowest-total candidate); the `propose` path is unchanged and still open.
- **ISSUE-014**: any *new* real-Postgres test file added to a package that
  already has one needs to double-check `vitest.config.ts` has
  `fileParallelism: false`. Already set for `packages/database`,
  `packages/trpc`, and `packages/payments` — check before adding one to any
  *other* package. (TICKET-206 added no Postgres-backed tests — its harness
  is pure.)
- **ISSUE-015** (`issue-tracker.md`, found in TICKET-601): the
  `BUYER_ENDS_SESSION → DECLINED` path has no `HOLD_RELEASED` transition in
  the frozen state machine, so a Tier 2 hold outstanding there self-heals
  only via TTL — no ledger event. Likely `NEEDS_SPEC_DECISION` (frozen-table
  change).
- **ISSUE-016** (`issue-tracker.md`, found in TICKET-601): `packages/policy`
  and `packages/trpc` omit `tests/` from their tsconfig `include`, so
  `pnpm check-types` never type-checks their test suites. A proper fix is
  still its own ticket. (`packages/agent` does not have this gap — its
  tsconfig has no restrictive `include`, so TICKET-206's test suites are
  type-checked.)
- **ISSUE-011 / ISSUE-012 sub-issue 12a, 12d**: both marked
  `NEEDS_SPEC_DECISION` — a money-formatting boundary, and stale-policy-
  version reads mid-negotiation. Flag them rather than silently deciding
  either while touching nearby code.
