# NEXT — Ticket Solve Order

The live, ordered queue of what's left. Generated from `Tickets.md`'s
statuses/dependencies on 2026-09-06 (re-derived after TICKET-602 closed) —
**re-derive this whenever a ticket flips to `DONE` or a new one is added**,
don't hand-edit around a stale ordering. Full acceptance criteria live in
`Tickets.md`; this file only answers "what's next and why."

**Ordering rule:** dependency-ready first, then priority (P0 before P1 before
P2), with the payment control-path and invariant suites ahead of `apps/web`
UI polish — per `Tickets.md`'s own stated philosophy ("depth of the core
invariant beats feature count").

36 of 46 tickets are `DONE`. 10 remain.

## Solve in this order

1. **[TICKET-604](Tickets.md#ticket-604--invariant-suite-payment-and-rail-authority)** — Invariant suite: payment and rail authority · P0 · ready now
   The last payment-path P0. Note ISSUE-012 sub-issue 12e — needs a Tier 2 catalog fixture nothing in the repo provides yet — and sub-issue 12b if it exercises the order-creation path end-to-end (TICKET-602 worked around 12b by driving the `@repo/database` repositories directly rather than through `createOrder`).
2. **[TICKET-205](Tickets.md#ticket-205--mcp-server-adapter)** — MCP server adapter · P1 · ready now
   Unblocks 206, which unblocks 603.
3. **[TICKET-206](Tickets.md#ticket-206--buyer-agent-harness)** — Buyer agent harness · P1 · blocked on 205
   Closes the longest dependency chain in the whole plan (Phase 0 → 102 → 103 → 104 → 110 → 202 → 204 → 205 → 206).
4. **[TICKET-603](Tickets.md#ticket-603--invariant-suite-injection-resistance-and-eligibility)** — Invariant suite: injection resistance and eligibility · P0 · blocked until Phase 2 (205+206) closes
5. **[TICKET-506](Tickets.md#ticket-506--minimal-buyer-surface)** — Minimal buyer surface · P1 · ready now
   Most demo-visible of the remaining UI work — do this before the smaller display widgets.
6. **[TICKET-502](Tickets.md#ticket-502--live-negotiation-event-stream)** — Live negotiation event stream · P1 · ready now
7. **[TICKET-503](Tickets.md#ticket-503--campaign-budget-countdown)** — Campaign budget countdown · P1 · ready now
8. **[TICKET-505](Tickets.md#ticket-505--audit-trail-display)** — Audit trail display · P1 · ready now
9. **[TICKET-504](Tickets.md#ticket-504--offer-status-and-ttl-display)** — Offer status and TTL display · P2 · ready now · drop first if time runs out
10. **[TICKET-508](Tickets.md#ticket-508--walk-away-policy-change-card)** — Walk-away policy-change card · P2 · ready now · drop first if time runs out

## Parallelizable right now

Everything below has all its dependencies satisfied *today* — a good set to
hand to separate worktree-isolated agents simultaneously instead of working
the list strictly top-to-bottom: `604`, `205`, `502`, `503`, `505`, `506`,
`504`, `508`. (`206` and `603` each wait on one item above them.)

## Known blockers worth knowing about before you start

- **ISSUE-012, sub-issue 12b** (`issue-tracker.md`): `packages/payments`'s
  older repository wrappers (`offer-repository.ts`, `order-repository.ts`)
  bind to a singleton `db` instead of taking a generic `NodePgDatabase`, so
  `createOrder` cannot be driven end-to-end against the shared sibling test
  database. TICKET-602 sidestepped this by exercising the underlying
  `@repo/database` repositories (`reserveOrder`, `acceptOffer`) directly
  against real Postgres; TICKET-604 will hit the same wall if it tries to go
  through `createOrder` itself.
- **ISSUE-012, sub-issue 12e**: no catalog fixture in this repo can actually
  force a Tier 2 mint end-to-end through `propose` (the deterministic
  merchant model always prefers a self-funding candidate). TICKET-604 or
  TICKET-206 will need to build one.
- **ISSUE-014**: any *new* real-Postgres test file added to a package that
  already has one needs to double-check `vitest.config.ts` has
  `fileParallelism: false` — Vitest runs test files in a package concurrently
  by default, and two files sharing one physical test database will race
  each other's `truncateAllTables()` otherwise. Already set for
  `packages/database`, `packages/trpc`, and `packages/payments` (which now
  has three such files, TICKET-602's included) — check before adding a
  fourth to any *other* package.
- **ISSUE-015** (`issue-tracker.md`, found in TICKET-601): the
  `BUYER_ENDS_SESSION → DECLINED` path has no `HOLD_RELEASED` transition in
  the frozen state machine, so a Tier 2 hold outstanding there self-heals
  only via TTL — no ledger event. Likely `NEEDS_SPEC_DECISION` (frozen-table
  change). Relevant if TICKET-604 asserts hold-lifecycle completeness.
- **ISSUE-016** (`issue-tracker.md`, found in TICKET-601): `packages/policy`
  and `packages/trpc` omit `tests/` from their tsconfig `include`, so
  `pnpm check-types` never type-checks their test suites. TICKET-602's
  policy-side suite was hand-checked with a temporary `include` addition and
  is clean; a proper fix is still its own ticket.
- **ISSUE-011 / ISSUE-012 sub-issue 12a, 12d**: both marked
  `NEEDS_SPEC_DECISION` — a money-formatting boundary, and stale-policy-
  version reads mid-negotiation. Neither blocks the tickets above directly,
  but flag them rather than silently deciding either while touching nearby
  code.
