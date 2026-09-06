# NEXT — Ticket Solve Order

The live, ordered queue of what's left. Generated from `Tickets.md`'s
statuses/dependencies on 2026-09-06 (re-derived after TICKET-504 closed) —
**re-derive this whenever a ticket flips to `DONE` or a new one is added**,
don't hand-edit around a stale ordering. Full acceptance criteria live in
`Tickets.md`; this file only answers "what's next and why."

**Ordering rule:** dependency-ready first, then priority (P0 before P1 before
P2), with the payment control-path and invariant suites ahead of `apps/web`
UI polish — per `Tickets.md`'s own stated philosophy ("depth of the core
invariant beats feature count").

45 of 47 tickets are `DONE`. 2 remain — 1 ready, 1 blocked.

## Solve in this order

1. **[TICKET-508](Tickets.md#ticket-508--walk-away-policy-change-card)** — Walk-away policy-change card · P2 · ready now · drop first if time runs out

**Blocked, not in the queue:**

- **[TICKET-606](Tickets.md#ticket-606--trpc-authentication-and-per-tenant-authorization)** — tRPC auth + per-tenant authorization · P1 · `BLOCKED` on the auth-mechanism decision (needs a settled `OQ` + lead sign-off; it changes frozen router signatures). Post-demo work — the auth gap (ISSUE-020) is an explicit MVP cut for the single-seed-merchant demo. Do not start it without the decision.

The one ready ticket (TICKET-508) is `apps/web` UI work that also touches
`packages/trpc`.

## Parallelizable right now

Only TICKET-508 is ready; nothing to parallelize.

`apps/web` has a `vitest` + `happy-dom` component-test runner (added by
TICKET-502; see ISSUE-018). Use it for a required "display matches state"
component test instead of routing through `packages/trpc` — split shaping
logic into `apps/web/lib/` and keep the fetching container thin, the way
`event-stream.ts` / `audit-trail.ts` / `offer-status.ts` and their
containers are.

**Build the watch-screen chrome on the shared shell (ISSUE-019, now FIXED).**
TICKET-505 extracted `apps/web/components/merchant/poll-card.tsx`
(`<PollCard>` / `<PollError>` / `<PollLastChecked>` / `pollStatus()` /
`MERCHANT_POLL_INTERVAL_MS`) and `reason-code-badge.tsx`. TICKET-502/503/504
all use them — a fifth watch screen should too.

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
  *other* package. (`apps/web`'s new runner is jsdom-only, no Postgres, so it
  is unaffected.)
- **ISSUE-015** (`issue-tracker.md`, found in TICKET-601): the
  `BUYER_ENDS_SESSION → DECLINED` path has no `HOLD_RELEASED` transition in
  the frozen state machine, so a Tier 2 hold outstanding there self-heals
  only via TTL — no ledger event. Likely `NEEDS_SPEC_DECISION` (frozen-table
  change).
- **ISSUE-016** (`issue-tracker.md`, found in TICKET-601): `packages/policy`
  and `packages/trpc` omit `tests/` from their tsconfig `include`, so
  `pnpm check-types` never type-checks their test suites. A proper fix is
  still its own ticket. (`packages/agent` and `apps/web` do not have this
  gap — `apps/web`'s tsconfig `include` is `**/*.tsx`, so TICKET-502's test
  is type-checked.)
- **ISSUE-018** (`issue-tracker.md`, found in TICKET-502): `apps/web` gained
  its first component-test runner. Recorded because TICKET-506 had read
  CONTRACTS §8 as barring one; the entry explains why a props-only jsdom
  render is not one of §8's three backend seams.
- **ISSUE-011 / ISSUE-012 sub-issue 12a, 12d**: both marked
  `NEEDS_SPEC_DECISION` — a money-formatting boundary, and stale-policy-
  version reads mid-negotiation. Flag them rather than silently deciding
  either while touching nearby code.
- **ISSUE-020 → TICKET-606**: the merchant and audit tRPC routers are
  unauthenticated `publicProcedure`s keyed by a client-supplied id — any
  caller can read/write any tenant. Explicit MVP cut for the demo. If you add
  a new merchant/audit procedure, follow the existing pattern (don't invent a
  one-off auth check) so TICKET-606 can convert them all in one pass.
