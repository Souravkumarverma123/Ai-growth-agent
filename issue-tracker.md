# Local Issue Tracker

This file replaces Linear / Jira / GitHub Issues for this project. Every implementation issue discovered during development is recorded here.

**Scope discipline.** This file records **problems found during implementation**. It does not redefine product requirements (that is `PRD.md`) and it does not describe planned work (that is `Tickets.md`).

> **If an issue reveals that the product specification itself is wrong, STOP.** Record the issue here, flag that `PRD.md` requires an approved change, and wait. Do not silently rewrite the requirement.

---

## Rules

When an issue is discovered:

1. Add it to this file.
2. Assign the next incrementing `ISSUE-NNN` id.
3. Classify severity.
4. Identify the ticket where it was found.
5. **Determine whether it violates a product invariant** (PRD §21). If it does, severity is at least HIGH and usually CRITICAL.
6. Fix the root cause, not the symptom.
7. Add a regression test for any behavioural or invariant bug.
8. Update the issue status and its status history.
9. Update the related ticket in `Tickets.md` if its scope or acceptance criteria changed.

**Do not silently fix important bugs without recording them.**

**Do not** open issues for trivial typos or harmless formatting unless they affect functionality.

### Severity

| Severity | Meaning |
| --- | --- |
| **CRITICAL** | Violates a non-negotiable invariant from PRD §21. Money, policy, or audit integrity is affected. Stop other work. |
| **HIGH** | Breaks a documented product behaviour, or a failure scenario does not fail closed. |
| **MEDIUM** | Incorrect behaviour with a workaround, or a demo-path defect. |
| **LOW** | Cosmetic or non-blocking. |

### Statuses

`OPEN` · `IN_PROGRESS` · `FIXED` · `WONTFIX` · `NEEDS_SPEC_DECISION`

`NEEDS_SPEC_DECISION` means the issue cannot be fixed without an approved change to `PRD.md`. It blocks its ticket.

---

## Invariant quick reference

An issue touching any of these is **CRITICAL** by default. Full list in `PRD.md` §21.

1. The LLM cannot directly control money.
2. No model-generated string becomes a monetary amount.
3. Merchant policy is deterministic and enforced outside the LLM.
4. The buyer cannot self-declare checkout eligibility.
5. Tier 2 requires explicit Tier 1 refusal and continued eligibility.
6. Campaign spend is calculated deterministically.
7. Campaign spend cannot exceed per-deal or campaign limits.
8. Campaign budget reservations are atomic and have a lifecycle.
9. One offer can mint exactly one order.
10. Offers are single-use and expire after 10 minutes.
11. Payment state comes from the payment rail, not an agent's claim.
12. Buyer payment authorization remains separate from merchant commercial authority.
13. Autonomous payment is disabled and not implemented in the MVP.
14. Audit events are append-only and hash-chained.
15. Reason codes are deterministic and cannot be invented by the LLM.
16. `WALK_AWAY` is a real terminal state.
17. The system fails closed at financial and security boundaries.

---

## Open issues

## ISSUE-021 — the deployed engine's `CANDIDATES_EVALUATED` ledger payload omits the `feasible` count that PRD §8 says it records

Status: OPEN
Severity: MEDIUM
Found in: TICKET-505 (audit trail display)
Date: 2026-09-06
Violates invariant: none in PRD §21 — but it contradicts PRD §8's explicit
statement that "the ledger records the counts — evaluated, feasible, Tier 1".

### Problem

PRD §8: *"The ledger records the counts — evaluated, feasible, Tier 1. That
single line forecloses 'how do you know there wasn't a better deal?'"*

The deployed write path records only two of the three. In
`packages/trpc/server/routes/negotiation/route.ts` the `CANDIDATES_EVALUATED`
event is written with `payload: { ...generation.counts }`, and
`generation.counts` (`packages/policy/generation/candidates.ts`,
`CandidateGenerationCounts`) is `{ evaluatedCount, selfFundingCount,
byMoveType }`. So:

- **evaluated** → `evaluatedCount` ✅
- **Tier 1** → `selfFundingCount` (candidates with `contributionDelta >= 0`);
  close enough — its own doc-comment calls it "the raw material for what
  TICKET-104 will call 'Tier 1 feasible'" ✅ (modulo the rename)
- **feasible** → not written at all ❌

The feasible count (Tier 1 feasible + Tier 2 feasible-within-caps) exists at
write time — it is derivable from `assignTiersAndFeasibility`'s result — but
that result is not folded into the event payload. On the
`NO_FEASIBLE_BASKET` branch `assignTiersAndFeasibility` returns only
`{ feasible: false, reasonCode }` with no candidate array, so a fix has to
decide what the feasible count is there (0) too.

Separately, the hand-authored worked-example fixtures
(`packages/trpc/tests/audit-route.test.ts`,
`apps/web/tests/event-stream.test.tsx`) use a *different* payload shape —
`{ evaluated, feasible, tier1 }` — which no production code writes. So there
are two shapes in the tree and neither is a superset of the other.

### Impact

TICKET-505's audit screen surfaces candidate counts for the judge.
`extractCandidateCounts` (`apps/web/lib/audit-trail.ts`) reads both shapes
(`evaluated`/`evaluatedCount`, `feasible`/`feasibleCount`,
`tier1`/`tier1Count`/`selfFundingCount`); on real deployed data it therefore
shows **evaluated** and **Tier 1** but renders **feasible** as "—" with a
"not recorded" note. It never fabricates the missing number.

### Fix

Not done here — out of TICKET-505's `apps/web` scope, and it touches the
`CANDIDATES_EVALUATED` write in `packages/trpc` (and possibly the
`CandidateGenerationCounts` type in `packages/policy`). Its own small ticket:
extend the recorded payload to carry an explicit `feasibleCount` (and settle
the key names — `evaluated` / `feasible` / `tier1` per §8, vs the current
`…Count` suffixes), update the two fixture files to the real shape, and
tighten `extractCandidateCounts` once one shape is canonical.

### Related Ticket

TICKET-505 (found), TICKET-103 / TICKET-104 (counts origin), TICKET-404 (the
read API), TICKET-204 (the write path)

### Status History

- 2026-09-06: OPEN — recorded while building the TICKET-505 candidate-counts panel.

---

## ISSUE-020 — the whole merchant tRPC surface is `publicProcedure` with `merchantId` as an input — any caller can read/write any merchant

Status: OPEN
Severity: MEDIUM
Found in: TICKET-503 (CodeAnt review of PR #44 flagged `getCampaignBudget`)
Date: 2026-09-06
Violates invariant: none listed in PRD §21 — but it is a real
authorization gap on the merchant console surface.

### Problem

Every procedure in `packages/trpc/server/routes/merchant/route.ts`
(`getPolicy`, `approvePolicy`, `setNegotiationEnabled`, and now
`getCampaignBudget`) is a `publicProcedure` that takes `merchantId` as a
plain input field. There is no authentication or authorization anywhere in
the stack — `Context` is just `{ db }`, and `apps/web` hardcodes the single
seed merchant id. So any unauthenticated caller who knows (or guesses) a
merchant UUID can read that merchant's policy, floors, per-deal cap and full
campaign-budget breakdown, and can approve policy changes or flip their kill
switch.

CodeAnt flagged this specifically on `getCampaignBudget` (PR #44), but it is
not a TICKET-503 defect — `getCampaignBudget` follows the exact pattern the
other three merchant procedures established in TICKET-501, and the frozen
Phase-0 signature (TICKET-006) already fixed `{ merchantId: z.string() }` as
its input. Fixing it for one procedure would be inconsistent and wouldn't
close the hole.

### Fix

Out of scope for TICKET-503 and not a unilateral change: it needs an
auth story (a `protectedProcedure` with a real session / API key in
`Context`, and `merchantId` derived from the caller identity instead of
taken as input) applied across the whole merchant router at once. That is a
change to frozen router signatures (CONTRACTS.md §1/§11.2) and needs lead
sign-off on the auth mechanism. The buyer-facing surface has the same shape
and should be reviewed in the same pass.

Acceptable for the MVP demo as-is (single seed merchant, no real merchant
data), but must not ship to real merchants without this.

### Related Ticket

TICKET-503 (found), TICKET-501 / TICKET-006 (established the pattern)

### Status History

- 2026-09-06: OPEN — recorded from a CodeAnt review comment on PR #44.

---

## ISSUE-019 — `apps/web` merchant "watch" screens are copying the same poll-card chrome per ticket

Status: FIXED (TICKET-505)
Severity: LOW
Found in: TICKET-503 (campaign budget countdown)
Date: 2026-09-06
Violates invariant: none — a UI-duplication judgement call.

### Problem

`apps/web/app/merchant/sessions/[sessionId]/merchant-event-stream.tsx`
(TICKET-502) and `apps/web/app/merchant/budget/campaign-budget-countdown.tsx`
(TICKET-503) now carry near-identical copies of the same poll-card shell: the
`POLL_INTERVAL_MS = 2_000` constant, the `CardHeader` with the `RefreshCw` +
`aria-live` "Live / Refreshing" status line, the `isError` `<p>` with
`AlertCircle`, and the "Last checked … `toLocaleTimeString()`" footer. Each
ticket was told to mirror TICKET-502, so two copies is defensible — but
TICKET-504 (offer status / TTL) and TICKET-505 (audit trail) are both more
`apps/web` "watch" screens and will make it four.

### Fix

Done in TICKET-505. `apps/web/components/merchant/poll-card.tsx` holds the
shared chrome once: `MERCHANT_POLL_INTERVAL_MS` / `…_SECONDS`, `pollStatus()`
(flags → "Live" / "Refreshing" / "Settled"), `<PollCard>` (the `Card` +
`CardHeader` with the spinning `RefreshCw` + `aria-live` status line),
`<PollError>` (the `AlertCircle` line, `md` full-panel + `sm` stale-refresh
sizes) and `<PollLastChecked>` (the footer). The reason-code badge — the
shared "justification" primitive — moved to
`apps/web/components/merchant/reason-code-badge.tsx`.

TICKET-502 (`merchant-event-stream.tsx`) and TICKET-503
(`campaign-budget-countdown.tsx`) were retrofitted onto it with no DOM/behaviour
change — both suites pass untouched. Each screen still owns its own tRPC query,
`refetchInterval` policy, and blank-vs-keep-last-good error choice; only the
chrome is shared.

### Related Ticket

TICKET-502, TICKET-503, TICKET-504, TICKET-505

### Status History

- 2026-09-06: OPEN — recorded when TICKET-503's second copy landed.
- 2026-09-06: FIXED — shared `poll-card.tsx` + `reason-code-badge.tsx`
  extracted in TICKET-505; 502 and 503 retrofitted. TICKET-504 should build on
  the same shell.

---

## ISSUE-018 — `apps/web` gained a jsdom component-test runner; TICKET-506 had read CONTRACTS §8 as barring one

Status: OPEN
Severity: LOW
Found in: TICKET-502 (live negotiation event stream)
Date: 2026-09-06
Violates invariant: none — a testing-infrastructure judgement call.

### Problem

TICKET-506's implementation notes state "`apps/web` has no runner and §8
bars a fourth seam" and, on that basis, placed its required test in
`packages/trpc/tests/`. TICKET-502's required test — "Component renders a
full event sequence" — is a pure render assertion with no backend at all,
and `packages/trpc` cannot host it (no React, no DOM). So TICKET-502 added
`vitest` + `jsdom` + `@testing-library/react` to `apps/web` and a
`vitest.config.ts` scoped to `tests/**/*.test.{ts,tsx}`.

### Resolution taken

Read CONTRACTS §8 again. Its "three seams, no more" rule governs **isolating
the negotiation engine's backend dependencies** — the tRPC/Postgres seam,
`NegotiationModel`, `RailStateSource`. A jsdom render of a presentational
component fakes none of those: it injects a plain `EventStreamRow[]` prop and
asserts what the browser would paint. It does not mock the database (§8's
explicit prohibition) because it never touches it. Treated as **not** a
fourth seam and allowed.

The split that makes this cheap: all shaping logic lives in the pure
`apps/web/lib/event-stream.ts` (`toEventStreamRows`, `isStreamSettled`), and
`MerchantEventStream` (the polling container) is separated from
`EventStreamView` (props-only), so the test needs no tRPC/react-query
harness.

Note: `apps/web` also gained a real dependency on `@repo/policy` in this
ticket (for the frozen `ReasonCode` / `TERMINAL_STATES` contracts — a
type-only import for the enum, a tiny const for the states). That is the
intended use of the pure contracts package and is not a boundary violation
(CONTRACTS §2 restricts what `policy` / `agent` / `payments` may import, not
what may import `policy`), but it is the first non-`@repo/trpc` workspace
import in the web app, so it is called out here alongside the runner.

### If this is judged wrong

Delete the `apps/web` runner and its five deps, keep only
`tests/event-stream.test.ts` re-scoped to the pure `event-stream.ts`
functions, and run it from wherever a plain `vitest` lives. The component
would then be covered only transitively (it is a direct `.map` over
`toEventStreamRows`).

### Related Ticket

TICKET-502

### Status History

- 2026-09-06: OPEN — recorded so the divergence from TICKET-506's reading of
  §8 is visible, not silent.

---

## ISSUE-017 — PRD §18.2's Tier 2 worked example is not reproducible by `generateCandidates` under the seeded ₹200 per-deal cap

Status: NEEDS_SPEC_DECISION
Severity: MEDIUM
Found in: TICKET-206
Date: 2026-09-06
Violates invariant: none — the engine fails closed (a Tier 2 candidate that
would breach the per-deal cap is marked infeasible, never offered).

### Problem

PRD §18.2's worked example has round 2 land on "original cart at ₹2,300 …
shortfall ₹200 — exactly at the per-deal cap." No fixture can make
`generateCandidates` produce that offer. It emits exactly one
`PRICE_CONCESSION` candidate per round, at the *full* concession-curve
fraction of the cart's floor-derived headroom (`round-envelope.ts`). On the
§18.2 cart (Serum + Cleanser, ₹950 headroom) that is:

| Round | curve | discount | shortfall | vs ₹200 cap |
| --- | --- | --- | --- | --- |
| 1 | 0.4 | ₹380 | ₹380 | infeasible |
| 2 | 0.7 | ₹665 | ₹665 | infeasible |
| 3 | 1.0 | ₹950 | ₹950 | infeasible |

So with `perDealCapMinor = 20_000` (₹200, what `packages/database/seed.ts`
seeds and what §5 / §18.2 state) **every** Tier 2 candidate on this cart is
infeasible at every round — a Tier 2 offer is not generable end to end, on
this cart, ever. The concession curve and the per-deal cap are mutually
inconsistent for a cart this size: the curve's smallest step (0.4 × headroom)
already exceeds the cap.

### Expected

Either the round-2 Tier 2 offer of §18.2 is generable (shortfall ≈ cap), or
PRD §18.2 is corrected to numbers the frozen engine can actually produce.

### Actual

Neither. §18.2 is stated as "all tests and demo data use these numbers" but
no test drives that Tier 2 offer, and none can.

### Root Cause

`generateCandidates` has no cap-aware `PRICE_CONCESSION` — it never proposes
a *partial* discount sized to land just inside the per-deal cap. The
concession curve is a fixed fraction of headroom (RA-4, frozen), and the
per-deal cap is a separate downstream feasibility gate; nothing sizes the
concession to the cap.

### Impact

Demo-path only. PRD §18.2's headline "the agent refusing a deal it could
afford because a different limit binds" is real in principle but cannot be
shown with §18.2's own cart + cap through the real generator.

### Fix

Needs a spec decision: (a) change §18.2's cart/cap so 0.4 × headroom ≤ cap,
(b) change the concession curve, or (c) add a cap-aware partial
`PRICE_CONCESSION` move to `generateCandidates` (a frozen-generator change,
CONTRACTS.md §1). Not decided here.

### Regression Test

None yet — blocked on the spec decision.

### Related Ticket

TICKET-206 (worked around, not blocked — see below), overlaps ISSUE-012
sub-issue 12e.

### Status History

- 2026-09-06: NEEDS_SPEC_DECISION

**TICKET-206 workaround (not a fix).** The buyer agent harness
(`packages/agent/demo/`) does drive a real Tier 2 offer end to end — buyer
agent ↔ `runNegotiationRound` ↔ `mintOffer` against the pure engine — by
using a demo fixture whose `perDealCapMinor` is widened to ₹700
(`reference-scenario.ts`, documented inline). That makes rounds 1–2 Tier 2
feasible and round 3 infeasible, reproducing §18.2's *shape* ("feasible,
feasible, then the cap binds and it walks") without §18.2's exact figures.
The DB-backed `propose` HTTP path still has no Tier-2-reaching fixture
(ISSUE-012 sub-issue 12e stays open for it).

---

## ISSUE-016 — `pnpm check-types` does not type-check the test suites in `packages/policy` and `packages/trpc`

Status: OPEN
Severity: MEDIUM
Found in: TICKET-601 (economics invariant suite)
Date: 2026-09-06
Violates invariant: none — a CI-coverage gap.

### Problem

`packages/policy/tsconfig.json` and `packages/trpc/tsconfig.json` both set an
explicit `include` list (`contracts/`, `economics/`, … / `server/`,
`client/`) that omits `tests/`. Their `check-types` script is `tsc --noEmit`,
so **test files in those two packages are never type-checked** — by anything.
Vitest transpiles with esbuild (no type checking), and eslint's type-aware
rules do not catch a plain "object literal is missing required properties"
assignability error.

`packages/payments`, `packages/database` and `packages/agent` have no
`include` override, so their default `tsc` run *does* cover `tests/`.

Concretely, while writing TICKET-601's `invariants-economics.test.ts` a call
passed `{ ...offer, candidateId, sessionId, roundIndex }` — an `Offer`, not a
`Candidate` — to `assertNoFloorBreach(candidate: Candidate, …)`. It compiled
and the test passed (the function only reads `.basket`/`.candidateId` at
runtime); `tsc` flags it as `error TS2345` only when the file is checked
directly. Existing comments like candidate-generation.test.ts's "Checked by
`pnpm check-types`, not at runtime" are therefore currently inaccurate for
this package.

### Fix

Add `"tests/"` to the `include` array in both tsconfigs (or drop the
`include` override and rely on the default like the other three packages),
then fix the latent errors it surfaces. Measured 2026-09-06 by adding
`tests/` locally and running `check-types`:

- **`packages/policy`** — 3 errors, all in `tests/contribution.test.ts`
  (lines ~295/299/319): a `Partial<SkuPolicy>`-style override object passed
  where a full `SkuPolicy` is required. Small and localized.
- **`packages/trpc`** — 17 errors across `tests/audit-route.test.ts`,
  `tests/merchant-policy-approval.test.ts`, `tests/negotiation-route.test.ts`:
  mostly `NodePgDatabase<…>` not assignable to `NodePgDatabase<…> & { $client: Pool }`
  (a drizzle client typing mismatch at the test-db seam), plus one
  top-level-`await` needing the test `module`/`target` raised, and a
  `readonly []` vs mutable `commitments` array. Needs its own pass.

Kept out of the TICKET-601 PR and its CodeAnt follow-up: ~20 unrelated type
fixes across two packages do not belong in a review of one new test file. The
TICKET-601 suite itself is hand-checked with a direct `tsc --noEmit` run on
the file and is clean.

### Status history

- 2026-09-06: OPEN — found when a type-unsound call in the new invariant
  suite compiled cleanly under `pnpm check-types`.
- 2026-09-06: measured the cascade (3 policy + 17 trpc errors, categorized
  above) so the fix can be scoped as its own ticket.

---

## ISSUE-015 — No `HOLD_RELEASED` ledger event on the `BUYER_ENDS_SESSION -> DECLINED` path when a Tier 2 hold is outstanding

Status: OPEN
Severity: MEDIUM
Found in: TICKET-601 (economics invariant suite)
Date: 2026-09-06
Violates invariant: arguably 8 (campaign budget reservations "have a
lifecycle") — but only the *ledger-visible* half; the reservation itself
still returns to available budget on TTL expiry.

### Problem

A Tier 2 offer reserves a campaign hold while the session sits in
`OFFER_PENDING` (`OFFER_PENDING --BUDGET_RESERVED--> OFFER_PENDING`,
`HOLD_RESERVED`). The frozen state machine
(`packages/policy/contracts/state-machine.ts`) models three `HOLD_RELEASED`
transitions — from `OFFER_PENDING` (buyer declines the offer), `EXPIRED`
(TTL), and `PAYMENT_FAILED`. It has **no** `HOLD_RELEASED` row for
`DECLINED`, which is where `OFFER_PENDING --BUYER_ENDS_SESSION--> DECLINED`
(`BUYER_DECLINED`) lands — the buyer abandoning the session outright, as
opposed to declining the specific offer.

So if a buyer ends the session while a Tier 2 offer (and its hold) is
pending, the hold is neither released nor committed by any ledger event. It
stays `RESERVED` until its TTL (= offer TTL, 600 s) elapses, at which point
`reserveCampaignBudget`'s `state = 'RESERVED' AND expires_at > now()`
predicate stops counting it and the budget silently returns to available
(`packages/database/repositories/campaign-holds.ts`). The economic outcome
is correct; what is missing is a ledger event making that release
reconstructable, and for up to 10 minutes the abandoned hold still counts
against `available` for other negotiations.

The same shape applies to any future `OFFER_PENDING`-adjacent walk-away that
carries a live hold — there is no `WALKED_AWAY --HOLD_RELEASED--> WALKED_AWAY`
row either — but no such transition exists in the frozen table today, and no
orchestration layer yet reserves-then-walks, so `DECLINED` is the only
concretely reachable case.

### Expected / Actual

Not a test failure — TICKET-601's suite asserts the frozen table's current
reading (three release paths) and passes. This entry records the gap between
that reading and PRD §6.5's "Release | Offer expires, is declined, or
payment fails" if "declined" is taken to include a buyer-terminal end.

### Fix

Deferred — likely `NEEDS_SPEC_DECISION`: closing it means adding a
`DECLINED --HOLD_RELEASED--> DECLINED` self-loop to the **frozen** state
machine (CONTRACTS.md §1 — lead approval required), then wiring the release
into whatever handles `BUYER_ENDS_SESSION`. Until then the TTL self-heal
(PRD §6.5: "holds expire and return") is the accepted safety net.

### Status history

- 2026-09-06: OPEN — found while writing the TICKET-601 invariant suite's
  "hold lifecycle across all terminal paths" assertion.
- 2026-09-06: still OPEN — a CodeAnt review comment on PR #34 re-flagged the
  same gap. Follow-up: `invariants-economics.test.ts` now pins it with an
  explicit "KNOWN GAP (ISSUE-015)" test that fails if a
  `DECLINED --HOLD_RELEASED--> DECLINED` row is ever added, and the suite's
  invariant-4 wording no longer claims "every terminal path".

---

## ISSUE-014 — `packages/payments`' first real-Postgres test files raced against each other on the shared sibling test database (recurrence of ISSUE-007)

Status: FIXED
Severity: MEDIUM
Found in: TICKET-304 (RailStateSource and polling reconciler)
Date: 2026-09-06
Violates invariant: none — a test-harness gap, not application behaviour.

### Problem

`reconcile-order.test.ts` and `poll-pending-orders.test.ts` are the first
`packages/payments` tests to use `@repo/database/testing/db.ts`'s real
sibling-database harness (CONTRACTS.md §8 — every prior test in this package
mocks its dependencies). `packages/payments/vitest.config.ts` had no
`fileParallelism: false`, so Vitest ran both new files concurrently against
the one physical test database, and one file's `truncateAllTables()` wiped
rows the other file had just inserted mid-test.

### Expected / Actual

Expected: both new test files green in isolation and together.
Actual: intermittent `insert or update on table "offers" violates foreign
key constraint "offers_session_id_negotiation_sessions_id_fk"`, a session
row unexpectedly `undefined` mid-assertion, and a deferred-FK `commit`
failure — all symptoms of a row existing when read but gone by the time a
later statement in the same test needed it.

### Root Cause

Identical to ISSUE-007: `packages/payments/vitest.config.ts` never carried
the `fileParallelism: false` guard that `packages/database` and
`packages/trpc` already have for the exact same reason — nothing about
adding a *second* real-DB test file to a package that already has one
reminds you the guard is missing, since each file alone still passes fine.

### Fix

Added `fileParallelism: false` to `packages/payments/vitest.config.ts`, with
a comment naming both files and pointing at ISSUE-003/ISSUE-007 as
precedent.

Two unrelated, smaller issues surfaced getting these two files running at
all, fixed in the same pass:
- `reconcile-order.ts` imported `getCampaignHoldByOfferId` from
  `@repo/database/repositories/campaign-holds` (no such export there — it
  lives in `campaign-budget-snapshot.ts`) and `packages/payments/package.json`
  never listed `drizzle-orm` as a direct dependency despite importing
  `NodePgDatabase` from it. Both were TICKET-304 code that had never been
  type-checked before this session picked it back up.
- `packages/payments/vitest.config.ts` pins `DATABASE_URL` to an inert
  placeholder for every other (mocked) test in this package, on purpose
  (see that file's own comment) — these two new files need the real value,
  restored from a preserved `REAL_DATABASE_URL` before dynamically importing
  the test-db harness. `REAL_DATABASE_URL` needed declaring in
  `packages/payments/turbo.json` for turbo's env-var lint rule — that file
  already existed (`7c4b9b6`, declaring `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`)
  and was overwritten from scratch without reading it first, which
  transiently dropped those two declarations and made lint flag them as
  newly-undeclared. Caught by the very next lint run and restored alongside
  the new addition — net diff is additive only, but worth naming as a
  process mistake (should have read the file before writing it), not a
  genuine pre-existing gap.

### Regression Test

No new test added for the race itself — same reasoning as ISSUE-007: this is
a harness-configuration fix, and the two existing new test files (now
running serially) are the proof. Ran `pnpm test` at the repo root repeatedly
with both files present, all green.

### Related Ticket

TICKET-304.

### Status History

- 2026-09-06: OPEN — found finishing TICKET-304's test suite.
- 2026-09-06: FIXED — `fileParallelism: false` added to
  `packages/payments/vitest.config.ts`; the two incidental import/dependency
  bugs and the turbo env-var gaps fixed alongside.

---

## ISSUE-013 — `acceptOffer`'s autonomous-payment refusal threw from inside its own transaction, silently rolling back the audit event it was reporting

Status: FIXED
Severity: CRITICAL
Found in: closing out TICKET-306 (adding its required "flag flipped to true"
regression test surfaced this — the test asserted the refusal's audit event
existed and it didn't)
Date: 2026-09-06
Violates invariant: #14 (audit integrity) and #17 (fail closed) — the
refusal itself failed closed correctly (offer never consumed, no order
created, no capture reachable), but the LEDGER's own record of why it
failed closed did not survive.

### Problem

`acceptOffer` (`packages/trpc/server/routes/negotiation/route.ts`) wraps its
entire body in `ctx.db.transaction(async (tx) => {...})` (this session's own
earlier fix for the accept/decline race, ISSUE-012's sibling). The
autonomous-payment gate inside that transaction did:

```ts
await appendAuditEvent(tx, auditParamsFromTransition(paymentTransition, {...}));
throw new TRPCError({ code: "NOT_IMPLEMENTED", ... });
```

Throwing from inside a `drizzle` transaction callback rolls back everything
written in that transaction and re-throws the error to the caller. The
`appendAuditEvent` call one line above the throw was therefore never
actually committed — the client correctly received `NOT_IMPLEMENTED`, but
`AUTONOMOUS_PAYMENT_NOT_AUTHORIZED` never appeared in `audit_events` at all,
directly contradicting TICKET-306's own acceptance criterion ("the refusal
is audited with its reason code").

### Root Cause

Introduced by wrapping `acceptOffer` in a transaction for a DIFFERENT reason
(the accept/decline race fix) without re-examining every existing early
exit inside it for whether it still needed to survive a throw. A throw
inside a transaction and "record why, then fail" are structurally
incompatible in the same statement sequence — the second write undoes the
first.

### Fix

The transaction's callback no longer throws for this case; it returns a
discriminated `AcceptOfferTxResult` (`{ blocked: true, reasonCode }` or
`{ blocked: false, value }`). The `TRPCError` is thrown OUTSIDE the
transaction, only after it has resolved — by which point the audit event
has actually committed. Every other early exit in this same transaction
(the declined/expired branches, the success branch) was already a plain
`return`, never a `throw`, so none of them needed this change — this was
the one path that mixed the two.

### Regression Test

`packages/trpc/tests/negotiation-route.test.ts` — "acceptOffer fails closed
with NOT_IMPLEMENTED when autonomousPaymentExecution is true..." (added
while closing TICKET-306) asserts the audit event, the offer's untouched
status, and the session's untouched state all survive the throw — this is
exactly the assertion that caught the bug (it failed before the fix).

### Related Ticket

TICKET-306, TICKET-204 (the transaction wrap this bug lived inside)

### Status History

- 2026-09-06: FIXED

---

## ISSUE-012 — Five composition gaps surfaced by TICKET-204's end-to-end wiring

Status: OPEN (partially mitigated in TICKET-204; each sub-issue names the ticket that should actually close it)
Severity: MEDIUM
Found in: TICKET-204 (negotiation protocol procedures — the first ticket to
actually drive `packages/policy` + `packages/agent` + `packages/database` +
`packages/payments` together, end to end, against a real request)
Violates invariant: none directly — each sub-issue is a genuine gap in how
two already-DONE tickets compose, not a violation of a stated invariant on
its own. (12a fails closed correctly today; it is recorded because the
*specific* ledger entry it writes doesn't correspond to a row in the frozen
state machine, not because money or policy integrity is at risk.)

### 12a. RA-3's mid-negotiation eligibility re-check has no modeled ledger transition for its failure path

PRD §16 RA-3 requires eligibility to be re-checked once before a Tier 2 mint
(`packages/policy/eligibility/eligibility.ts`'s own module doc says the same).
TICKET-204 implements that re-check in `propose` (`packages/trpc/server/
routes/negotiation/route.ts`) so a merchant flipping the kill switch
mid-negotiation (RA-1) is honored before a Tier 2 offer is minted. When the
re-check fails, the session is halted (fails closed — no mint occurs), but
`contracts/state-machine.ts`'s frozen `TRANSITIONS` table has no row for
"eligibility re-check failed while the session is OPEN": every
`NEGOTIATION_REQUESTED` row is keyed `from: "IDLE"` or `from: "AT_RISK"`,
never `from: "OPEN"`. TICKET-204's ledger write for this path uses
`fromState: "OPEN"` directly (accurate) with the re-check's own reason code,
bypassing `resolveNegotiationRequestedTransition`'s `lookupTransition` (which
would throw, since `(OPEN, NEGOTIATION_REQUESTED, <code>)` genuinely isn't in
the table) — so the write is honest about the actual state, but doesn't
correspond to any row a reviewer can point to in the frozen table. Recording
here per CONTRACTS.md §1's instruction ("if a ticket seems to require a
change here, that is a signal to stop... record it") rather than adding a
transition row unilaterally. **NEEDS_SPEC_DECISION**: either add an explicit
`OPEN --NEGOTIATION_REQUESTED--> HALTED` family of rows for the RA-3 re-check
outcomes, or bless the current behavior in `PRD.md`/`CONTRACTS.md` as
intentionally outside the table (the way `FLOOR_BREACH`'s `from: "*"` row is
an explicitly-documented exception).

### 12b. `packages/payments` cannot compose with the shared test-db harness without mocking

`getOfferById`/`createOrder` (`packages/payments/src/offer-repository.ts`,
`create-order.ts`) import `@repo/database`'s exported singleton `db` directly
— unlike every repository function elsewhere in this codebase, which is
generic over `NodePgDatabase` specifically so it can run against
`getTestDb()`'s sibling test database (CONTRACTS.md §8's own harness note).
That singleton always points at `DATABASE_URL`, a different physical
database from whatever `getTestDb()` derives from it. TICKET-301/302's own
tests never noticed this because they mock every one of `createOrder`'s
dependencies for a different reason (no real Razorpay network call in
tests). TICKET-204's `acceptOffer` procedure is the first caller that needs
`createOrder` to see a row a *different* package's test just inserted via
`ctx.db`, and it cannot — worked around in
`packages/trpc/tests/negotiation-route.test.ts` by mocking `@repo/payments`
entirely (which is also required anyway, to avoid a real Razorpay HTTP call).
Affects any future ticket that composes `packages/payments` with the shared
test-db harness (TICKET-303, TICKET-304, TICKET-305, TICKET-306) — worth
considering whether `getOfferById`/`createOrder` should take an optional
`NodePgDatabase` parameter, matching every other repository in this repo.

**2026-09-06 (TICKET-602):** hit again writing the offer-lifecycle invariant
suite. The database-enforced invariants (one offer → one order under
concurrency; consume-exactly-once) genuinely need a real Postgres, and
`createOrder`'s singleton still can't reach the sibling test DB. Worked
around the same way TICKET-304/305 did — by testing the `@repo/database`
repositories `createOrder` delegates to (`reserveOrder`, `attachRailOrder`,
`acceptOffer`), which ARE generic over `NodePgDatabase`, directly against
`getTestDb()` from a `packages/payments` test file. `createOrder`'s own thin
wrapper stays covered by the fully-mocked `create-order.test.ts`. Still worth
the optional-parameter refactor eventually; not blocking.

### 12c. `acceptOffer`'s frozen input schema carries no separate "basket the buyer is accepting" field

TICKET-006's frozen `acceptOffer` input is `{ negotiationId, offerId }` only
— no basket. TICKET-111's `BASKET_MISMATCH` refusal
(`packages/policy/acceptance/acceptance.ts`,
`packages/database/repositories/offers.ts`) compares the offer's minted
basket against "the basket the buyer is attempting to accept right now,"
which implies a second, independently-supplied basket. Through this specific
transport, TICKET-204 has no such second value to supply and passes the
offer's own basket back to itself, so `BASKET_MISMATCH` is structurally
unreachable via `acceptOffer` today (TTL and single-use are still fully
enforced). Not a defect in TICKET-111 or TICKET-006 individually — recording
because a future ticket revisiting cart-drift detection at accept time will
need to widen this input, which is itself a frozen-contract change
(CONTRACTS.md §1) requiring lead sign-off, not a routine addition.

### 12d. `propose` reads the merchant's CURRENT policy, not the session's pinned `policyVersion`, because no historical version of it is ever stored

`NegotiationSession.policyVersion` (frozen, `contracts/negotiation.ts`) exists
specifically so a session started under one set of merchant terms keeps
negotiating under those SAME terms even if the merchant approves a policy
change mid-negotiation — the whole point of "pinning" a version. `propose`
(`packages/trpc/server/routes/negotiation/route.ts`) calls
`loadMerchantNegotiationContext`, which calls `getMerchantPolicy` —
unconditionally the merchant's live row, never filtered or joined by
`session.policyVersion` at all.

This is not a call-site oversight: `merchant_policies` (TICKET-003, frozen)
is a single mutable row per merchant. `approveMerchantPolicy`
(`packages/database/repositories/merchant-policies.ts`) does
`SET policy_version = policy_version + 1` on the SAME row, in place — the
values `maxRounds`, `offerTtlSeconds`, `concessionCurve`,
`perDealCapMinor`, `allowedCommitments`, etc. carried at the OLD version are
overwritten and gone the moment an approval lands. There is no
`merchant_policy_history` table, no snapshot column anywhere, and nothing in
the frozen schema a query could even ask for "policy as it stood at version
N" — `propose` reading the current row is the only row that exists to read.

**Impact:** identical to 12a's kill-switch case in kind, broader in scope —
a merchant approving a policy change (tightening `maxRounds`, shortening
`offerTtlSeconds`, changing the concession curve or per-deal cap) takes
effect on every session CURRENTLY MID-NEGOTIATION, immediately, not just on
sessions opened after the change. A buyer could be offered a materially
different deal on round 3 than what round 1 promised, from the SAME
session, with no session-side record of which terms actually applied.

**NEEDS_SPEC_DECISION**: this requires a genuine data model addition, not a
call-site fix — e.g. a `merchant_policy_history` table snapshotting the full
policy at every `policyVersion`, or a JSONB snapshot captured onto
`NegotiationSession` itself at `openNegotiation` time — either is a change
to a frozen contract (CONTRACTS.md §1, TICKET-003/004) and needs lead
sign-off on where the snapshot lives, not a decision made unilaterally
inside this ticket's `Affected: packages/trpc` scope.

### 12e. Tier 2 has no end-to-end test fixture in this suite — `propose`'s RA-3 fix is verified by reasoning, not by an integration test

A code review of PR #31 found `propose`'s RA-3 re-check
(`packages/trpc/server/routes/negotiation/route.ts`) always passed
`isFlaggedAtRisk: isFlaggedAtRisk(session.state)` — evaluating `false`
unconditionally, since `propose` only ever runs once `session.state ===
"OPEN"`, and `isFlaggedAtRisk` returns true only for `"AT_RISK"`. Every Tier
2 proposal therefore failed this re-check with `NOT_AT_RISK`, making Tier 2
entirely unreachable. Fixed by passing `isFlaggedAtRisk: true` directly,
with a comment proving why that's sound: `openNegotiation` only transitions
a session to `OPEN` after `checkEligibility` already required
`isFlaggedAtRisk(session.state) === true` (state was `AT_RISK`) at that
time, so a currently-OPEN session was necessarily flagged at risk when it
opened — the frozen schema just has no column still recording that once
state has moved on.

The fix itself follows deductively from that invariant, not from
observation — but attempting to also add a live integration test (`propose`
actually minting a Tier 2 offer, proving the re-check no longer blocks it)
surfaced a separate, pre-existing gap: in every single-SKU test fixture
tried, `DeterministicMerchantModel` (`packages/trpc/server/routes/
negotiation/merchant-model.ts`) prefers a self-funding `QUANTITY_VALUE`
candidate (buying more of the one SKU at list price, `contributionDeltaMinor
>= 0` by construction — more units at list price always outweighs the
fixed, smaller-quantity counterfactual) over any Tier 2 `PRICE_CONCESSION`
candidate, every round, up to `maxRounds`. Forcing a real Tier 2 mint
therefore needs a catalog fixture where no self-funding candidate is
reachable at all (e.g. multiple SKUs with no further affinity add
available, and some way to suppress quantity bumping) — building and
verifying that catalog was not completed within this fix's scope.

**Impact:** the fix is validated by precise code-tracing of the state
machine invariant above, and by the fact that all 38 existing `@repo/trpc`
tests plus a new database-level regression test for 12's sibling FK-ordering
bug still pass — but no test in this repository actually drives a Tier 2
offer through `propose` end to end. Any future change to `propose`,
`assignTiersAndFeasibility`, or `DeterministicMerchantModel` that
re-introduces an RA-3-style regression on the Tier 2 path would not be
caught by the current suite. Worth a follow-up ticket building a genuine
Tier-2-reaching fixture (likely needs `generateCandidates`'s `QUANTITY_VALUE`
move type investigated for how to suppress or exhaust it) once TICKET-206 or
TICKET-604 (invariant suite: payment and rail authority) need one anyway.

**Update 2026-09-06 (TICKET-206):** partially addressed for the *pure-engine*
path. The buyer agent harness (`packages/agent/demo/`) drives a real Tier 2
mint end to end — `DemoMerchantModel` offers the lowest-total exposed
candidate rather than the highest-contribution one, so once a Tier 1 refusal
unlocks Tier 2 the merchant actually picks it. This needed a demo fixture
with `perDealCapMinor` widened to ₹700 (ISSUE-017 records why ₹200 makes
Tier 2 categorically infeasible on the reference cart). The DB-backed
`propose` path is unchanged and still has no Tier-2-reaching fixture — this
sub-issue stays OPEN for it.

---

## ISSUE-011 — No agreed buyer-facing money-formatting boundary exists yet, so TICKET-203's composed messages carry raw minor units

Status: NEEDS_SPEC_DECISION
Severity: LOW
Found in: TICKET-203
Date: 2026-09-05
Violates invariant: none

### Problem

TICKET-203 requires an outbound, buyer-facing message built from the minted
`Offer`. CONTRACTS.md §3 is explicit that "formatting to rupees happens only
at the React render boundary. Never in the engine, never in an API
response" — but no such boundary exists yet anywhere in this repo (no
`formatMinorUnits`/rupee helper in `packages/policy`, `packages/agent`,
`apps/web`, or elsewhere; confirmed by grep). `packages/agent` is not "the
engine" (`packages/policy` is) and is not an API response either, so the
letter of §3 does not forbid formatting here — but no ticket has yet defined
where that boundary actually lives for a chat-style buyer message (as
opposed to a UI prop), so building one now inside this ticket would be
inventing a shared formatting convention unilaterally.

### Expected

A defined, single place (per §3's own intent: "happens only at ... the
boundary", singular) that turns `MinorUnits` into a locale-correct rupee
string for buyer-facing surfaces, reused by every caller that needs one.

### Actual

`packages/agent/message/message-composer.ts` (TICKET-203) renders every
amount as its raw `MinorUnits` integer plus a `"minor units"` label (e.g.
`"180000 INR (minor units) in total"`) rather than `"₹1,800.00"`. This is
the conservative reading of §3 — it introduces no new formatting logic
anywhere — but it is not realistic buyer copy, and whichever ticket first
renders these messages to an actual buyer (TICKET-206, currently TODO) will
need real rupee formatting before this is demo-ready.

### Root Cause

§3 was written before any ticket needed to produce buyer-facing natural-
language text (as opposed to a numeric API field or a React prop); it
doesn't say which layer owns formatting for that third case.

### Impact

Cosmetic only for now — every number in a composed message is still exactly
traceable to the offer row (TICKET-203's actual acceptance criterion), just
in an unfriendly unit. No invariant is at risk. Blocks a good demo
experience until resolved.

### Fix

Not fixed here — this needs a lead decision on where the formatting
boundary lives for buyer chat text (a new shared helper? part of TICKET-206?
part of the eventual `packages/trpc` buyer surface?), not a unilateral
choice made inside this ticket's `Affected: packages/agent` scope.

### Regression Test

N/A — no behavior to regress; this is a scope/spec gap, not a bug.

### Related Ticket

TICKET-203, TICKET-206

### Status History

- 2026-09-05: NEEDS_SPEC_DECISION

## ISSUE-010 — Raw `sql`-tagged timestamp comparisons silently corrupt under the host's local time zone

Status: FIXED
Severity: HIGH
Found in: TICKET-111
Date: 2026-09-05
Violates invariant: 10 (offers are single-use and expire after 10 minutes) — not by design but by exposing a latent footgun that would silently break the TTL check anywhere it's reused this way.

### Problem

`packages/database/repositories/offers.ts`'s `acceptOffer` needed to compare
`offers.expires_at` (a Postgres `timestamp` — no time zone — column, frozen
schema) against the accept attempt's `now`. The first implementation bound a
raw JS `Date` object directly into a `drizzle-orm` `sql` template tag —
`WHERE expires_at > ${now}` — the same style `campaign-holds.ts` uses for
`now()`/`clock_timestamp()` SQL-side comparisons, but here the comparison
value came from the JS side, not from Postgres itself.

Every accept attempt against a genuinely unexpired, unconsumed, basket-exact
offer failed with `OFFER_EXPIRED` — including the straightforward "accept a
valid offer" case — when run in this sandbox, whose host process time zone
is `Asia/Calcutta` (UTC+5:30).

### Expected / Actual

Expected: a freshly minted offer, accepted well within its 600s TTL,
succeeds regardless of the host machine's configured time zone.
Actual: it failed every time, misclassified as expired.

### Root Cause

Two compounding issues, both time-zone-dependent, found in this order:

1. **Read side.** `NodePgDatabase#execute` (raw `sql` tag) — unlike a plain
   `pg.Pool` query and unlike `drizzle-orm`'s own query builder — hands back
   a `timestamp` (no zone) column as raw Postgres text with no zone marker
   (e.g. `"2026-09-05 12:49:32.854126"`, space-separated, no `Z`/offset).
   Passing that string straight to `new Date(...)` makes JS parse it in the
   *host process's local* time zone rather than UTC — verified directly:
   `new Date("2026-09-05 12:49:32.854126")` on this host comes out ~5.5
   hours off from the intended UTC instant. `drizzle-orm`'s own column
   mapping (`pg-core/columns/timestamp.ts`, `mapFromDriverValue`) already
   works around exactly this by appending `+0000` before parsing — this
   module's raw-`sql` path had no equivalent.
2. **Write/compare side.** Even after fixing the read side, every "should
   succeed" test still failed. The bound `${now}` parameter — a raw JS
   `Date` object handed straight to `pg`'s default parameter serialization —
   round-tripped incorrectly against a zone-less column: probed directly
   against this repo's own test database, binding `new Date()` as `$1` and
   comparing `$1::timestamp` vs. `$1::timestamptz` produced instants ~5.5
   hours apart (this host's UTC offset) from each other and from the true
   current instant. `drizzle-orm`'s own column mapping
   (`mapToDriverValue`) avoids this entirely by never handing `pg` a raw
   `Date` for this column type — it always sends `value.toISOString()`, an
   unambiguous UTC string, instead.

Both bugs are latent in *any* raw `sql`-tagged query in this codebase that
binds a JS `Date` against, or reads back, a zone-less `timestamp` column and
then does JS-side `Date` arithmetic on the result — they only surface on a
host whose local time zone isn't UTC (this sandbox; plausibly some
contributors' laptops or CI runners too), which is exactly why `pnpm test`
could pass in one environment and fail in another with no code change.

### Impact

Had this shipped, `acceptOffer`'s `OFFER_EXPIRED` check would misfire
(false positives) or, depending on the sign of the host's UTC offset,
under-enforce the TTL (false negatives — accepting an offer that should have
been refused) on any deployment host not configured to UTC. Caught before
merge by this ticket's own required tests, all of which initially failed for
this reason; never reached `dev` or any real data.

### Fix

Applied, contained entirely inside
`packages/database/repositories/offers.ts`:

- Every raw-SQL read of `expires_at` / `consumed_at` / `created_at` now goes
  through a local `toDate` helper that normalizes Postgres's zone-less text
  to ISO-8601 and appends `Z` before parsing, forcing the UTC interpretation
  this codebase always intends (mirroring `drizzle-orm`'s own
  `mapFromDriverValue` for the same column type).
- Every raw-SQL write/compare of `now` uses `now.toISOString()` — never a
  raw `Date` object — mirroring `drizzle-orm`'s own `mapToDriverValue` for
  `timestamp` columns.

This is scoped to the one new file this ticket added; no existing repository
function was touched. Worth a follow-up: `campaign-holds.ts` and
`audit-events.ts` don't hit this bug today only because they never do
JS-side `Date` arithmetic on a value read back through a raw `sql` tag (their
timestamp comparisons all happen SQL-side, via `now()`/`clock_timestamp()`,
or the value is only ever checked for null-ness) — but the underlying
footgun (raw `Date` bound into `sql`\`\` against a zone-less column) is
general to this codebase, not specific to offers, and would be worth a
shared helper or a lint rule if another ticket hits it again.

### Regression Test

`packages/database/tests/offer-acceptance.test.ts`'s "accepts a valid,
unexpired, unconsumed offer" test and its `OFFER_EXPIRED` boundary tests are
the regression coverage: they run in whatever time zone the test runner's
host is configured to, and would have failed under the original bug in this
sandbox specifically. (No test asserts a specific non-UTC time zone —
CI/local hosts weren't assumed to control for this — but the fix itself no
longer depends on the host's time zone at all, which is what actually
closes the gap.)

### Related Ticket

TICKET-111 (found and fixed here)

### Status History

- 2026-09-05: OPEN — discovered when every `acceptOffer` test, including the
  straightforward success case, failed with `OFFER_EXPIRED` in this sandbox.
- 2026-09-05: FIXED — raw-SQL timestamp reads and writes in
  `offers.ts` now force UTC explicitly, matching the discipline
  `drizzle-orm`'s own column mapping already uses for the same column type.

---

## ISSUE-009 — `createOrder` POSTs to Razorpay without reserving a local order first, so concurrent/retried calls can mint two orders for one offer

Status: FIXED
Severity: HIGH
Found in: TICKET-301 (flagged independently by CodeAnt on commit `fa2b1c2e`, rated MEDIUM there)
Date: 2026-09-05
Violates invariant: 9 (one offer can mint exactly one order) — at risk, not yet breached in a shipped path

### Problem

`packages/payments/src/create-order.ts`'s `createOrder(offerId)` does:

```
const offer = await getOfferById(offerId);       // read-only
const request = buildRazorpayOrderRequest(offer); // pure
return createRazorpayOrder(request);              // external POST
```

There is no local orders row reserved or persisted before the external
POST. Two calls with the same `offerId` — a genuine race, or a client
retry after a slow/dropped response — both read the same offer and both
POST to Razorpay, producing two live orders for one offer. Razorpay does
not dedupe on `receipt` by default, so the offer id in `receipt` does not
prevent this.

### Expected / Actual

Expected: an offer maps to at most one Razorpay order, no matter how many
callers race or retry.
Actual: N concurrent/retried `createOrder(offerId)` calls create up to N
Razorpay orders.

### Root Cause

Not a defect in TICKET-301's implementation — it is a scope boundary.
TICKET-301's only economic acceptance criterion is "amount sent to
Razorpay always equals `offer.total_minor`", which holds. Offer-to-order
uniqueness is deliberately **not** in TICKET-301: `offer-repository.ts` is
kept read-only on purpose so it does not collide with TICKET-111, which
owns offer-state writes on its own branch. The uniqueness constraint plus
the transactional reserve-before-POST invariant are the entire scope of
**TICKET-302 — Offer-to-order uniqueness** (depends on TICKET-111 +
TICKET-301, P0, TODO).

### Fix

Fixed by TICKET-302. `packages/database/repositories/orders.ts` (new)
exports `reserveOrder(database, { offerId, amountMinor, currency })`: a
single `INSERT` into `orders` (schema unchanged — `orders.offer_id` was
already `notNull().unique()` in `models/payment.ts`, already migrated in
`drizzle/0001_sour_dreadnoughts.sql` as `orders_offer_id_unique`, per
TICKET-301's own frozen model). It relies on Postgres to reject a second
concurrent insert for the same `offerId` at the database level (error code
`23505`) and translates that into a clean domain result — `{ reserved:
false, reason: "ORDER_ALREADY_EXISTS" }` — instead of letting the raw
Postgres error escape.

`packages/payments/src/create-order.ts`'s `createOrder(offerId)` now calls
`reserveLocalOrder` (a thin wrapper, `./src/order-repository.ts`, mirroring
`./src/offer-repository.ts`'s existing pattern) BEFORE `createRazorpayOrder`,
and only proceeds to the POST if the reservation succeeded. If it did not —
an order already exists for this offer — `createOrder` throws a typed
`OrderAlreadyExistsError` (exported from the package) and never reaches
Razorpay. Once the POST does succeed, `attachRailOrderId` records the
returned Razorpay order id/payload onto the reserved row (for human
reconciliation and so TICKET-304's polling reconciler has a rail order id to
poll) — a plain follow-up `UPDATE`, no part of the uniqueness guarantee
itself.

The new and changed code cites no rail-supplied idempotency header at all —
the uniqueness guarantee is entirely our own unique constraint plus the
reserve-before-POST ordering, exactly as `models/payment.ts`'s "IDEMPOTENCY
IS OURS, NOT THE RAIL'S" doc comment always intended.

### Regression Test

`packages/database/tests/orders.test.ts` — a real-Postgres concurrency test:
20 concurrent `reserveOrder` calls for the SAME `offerId` leave exactly one
row `reserved: true` and every other call comes back the clean `{ reserved:
false, reason: "ORDER_ALREADY_EXISTS" }` domain result, never a thrown raw
Postgres error; a sequential-double-reserve variant of the same assertion;
and an `amountMinor` validation test mirroring `campaign-holds.ts`'s
convention. `packages/payments/tests/create-order.test.ts` — asserts
`reserveLocalOrder` is called before `createRazorpayOrder` (call-order
assertion), and that a reservation failure throws `OrderAlreadyExistsError`
without ever calling `createRazorpayOrder`.

### Related Ticket

TICKET-302 (owner, fixed here), TICKET-301 (where found), TICKET-602
(invariant suite)

### Status History

- 2026-09-05: OPEN — flagged by CodeAnt on commit `fa2b1c2e` during
  TICKET-301 review; validated as a real gap, confirmed already owned by
  TICKET-302, recorded here so TICKET-302 is not dropped.
- 2026-09-05: FIXED — `reserveOrder`/`attachRailOrder` added to
  `packages/database/repositories/orders.ts`; `createOrder` now reserves
  before POSTing and throws `OrderAlreadyExistsError` on a duplicate,
  verified by a 20-way concurrency test against the real database.

---

## ISSUE-008 — `paymentsBoundaries`' model-SDK rule mislabeled itself "B3", colliding with the real B3

Status: FIXED
Severity: LOW
Found in: TICKET-605
Date: 2026-09-05
Violates invariant: none — a lint-message labeling collision, not application behaviour.

### Problem

`packages/eslint-config/boundaries.js`'s `paymentsBoundaries` rule (a
defense-in-depth mirror of B1, banning a model SDK import from the
not-yet-built `packages/payments`) had its `no-restricted-imports` message
citing itself as `"B3 (CONTRACTS.md §2): ..."`. TICKET-605's actual scope
item — "no order-creation function accepts an amount parameter" — is
CONTRACTS.md §2's real, numbered B3. Building the new rule under the same
label would have left two different rules both claiming to be "B3" in CI
output and in this codebase's own comments, which defeats the point of the
numbering (a reader grepping for "B3" to find CONTRACTS.md's actual
order-creation rule would land on the wrong one first).

### Expected / Actual

Expected: exactly one rule in this codebase cites itself as B3, matching
CONTRACTS.md §2's numbered list.
Actual: two did, until this fix.

### Root Cause

The payments-side model-SDK mirror of B1 was written before CONTRACTS.md's
B3 (order-creation amount parameter) had a corresponding rule in this file,
and was labeled "B3" informally / by position rather than by checking
CONTRACTS.md's actual numbering.

### Fix

Dropped the incorrect `"B3"` citation from `paymentsBoundaries`' message
(it now reads `"CONTRACTS.md §2: ..."` with no rule letter, since it isn't
one of the four numbered rules itself — see the comment above
`paymentsBoundaries` in `packages/eslint-config/boundaries.js`), and
reserved the `"B3"` label for the new `orderCreationBoundaries` rule added
in this same ticket, which is the rule CONTRACTS.md actually numbers B3.

### Regression Test

`packages/eslint-config/tests/boundaries.test.ts`'s B3 `describe` block
asserts the new `orderCreationBoundaries` rule's messages contain `"B3"`
against three violation fixtures and does not fire on two compliant
fixtures — see `packages/eslint-config/tests/fixtures/order-creation-*.ts`.

### Related Ticket

TICKET-605

### Status History

- 2026-09-05: OPEN — found while adding TICKET-605's order-creation B3 rule
  and noticing the label was already in use.
- 2026-09-05: FIXED — incorrect `"B3"` citation removed from
  `paymentsBoundaries`; reserved for the new `orderCreationBoundaries` rule.

---

## ISSUE-007 — Concurrent `packages/trpc` test files race on the shared sibling test database

Status: FIXED
Severity: MEDIUM
Found in: merge of TICKET-403/PR #15 and TICKET-404/PR #14 into TICKET-501/PR #16
Date: 2026-09-05
Violates invariant: none — a test-harness gap, not application behaviour.

### Problem

`packages/trpc/tests/audit-route.test.ts` (TICKET-404) and
`packages/trpc/tests/merchant-policy-approval.test.ts` (TICKET-501) each hit
the one physical sibling test database via `@repo/database/testing/db.ts`,
and each truncates every table between its own tests. Vitest runs different
test files within one package concurrently by default, and
`packages/trpc/vitest.config.ts` never opted out of that — `packages/database`
already had (TICKET-001/ISSUE-003's original harness fix set
`fileParallelism: false` there), but nothing carried that same guard over to
`packages/trpc` when it gained its first real-Postgres test file.

Both PRs passed cleanly in isolation (each `pnpm --filter @repo/trpc test`
run only ever saw its own single DB-touching test file). The race only
existed once both files landed on the same branch together, which first
happened resolving TICKET-501's merge conflict against `main` (both TICKET-403
and TICKET-404 had already merged ahead of it).

### Expected / Actual

Expected: `pnpm test` at the repo root, run after this merge, green.
Actual: intermittent `insert or update on table "audit_events" violates
foreign key constraint "audit_events_session_id_negotiation_sessions_id_fk"`
— one test file's `truncateAllTables()` wiped the `negotiation_sessions` row
the other file had just inserted and was mid-way through using.

### Root Cause

`packages/trpc/vitest.config.ts` had no `fileParallelism: false`, so its two
DB-touching test files ran concurrently against the one shared sibling
database.

### Fix

Added the identical guard `packages/database/vitest.config.ts` already
carries: `fileParallelism: false` in `packages/trpc/vitest.config.ts`, with a
comment naming both files and the shared-database reason.

### Regression Test

No new test added — this is a harness-configuration fix, not application
behavior, and the two existing test files (already real-Postgres,
already exercising truncate-between-tests) are themselves the proof: re-ran
`pnpm --filter @repo/trpc test` and the root `pnpm test` repeatedly after the
fix with both files present, all green.

### Related Ticket

None single ticket — a cross-PR interaction between TICKET-403, TICKET-404 and TICKET-501.

### Status History

- 2026-09-05: OPEN — found resolving TICKET-501's merge conflict against `main`.
- 2026-09-05: FIXED — `fileParallelism: false` added to `packages/trpc/vitest.config.ts`.

---

## ISSUE-006 — Dev-mode CORS (`origin: "*"`) rejects every credentialed client-side tRPC call from `apps/web`

Status: FIXED
Severity: MEDIUM
Found in: TICKET-501
Date: 2026-09-05
Violates invariant: none

### Problem

`apps/web/trpc/create-client.ts` sends every request with `credentials: "include"` (needed so browser-side tRPC calls carry cookies). `apps/api/src/server.ts`'s dev-mode CORS middleware was configured with `cors({ origin: "*" })`. A wildcard `Access-Control-Allow-Origin` combined with a credentialed request is rejected by the browser itself (not a server-side 4xx — the fetch never even completes), regardless of what the server returns.

### Expected

The new TICKET-501 merchant policy page (the first *client-side* interactive tRPC consumer in this codebase — every prior usage was a server component calling `api.*.query()` from Node, which never goes through browser CORS at all) should be able to call `merchant.getPolicy` / `merchant.approvePolicy` / `merchant.setNegotiationEnabled` from the browser and round-trip against the real API + Postgres.

### Actual

Every client-side call failed in the browser console with: `Access to fetch at 'http://localhost:8000/trpc/merchant.getPolicy?...' from origin 'http://localhost:3000' has been blocked by CORS policy: The value of the 'Access-Control-Allow-Origin' header ... must not be the wildcard '*' when the request's credentials mode is 'include'.` The policy form never loaded in-browser. Verified independently via `curl` (bypasses browser CORS enforcement entirely) that `getPolicy` / `approvePolicy` / `setNegotiationEnabled` all work correctly against the real Postgres instance — so the bug is purely transport-layer CORS configuration, not the procedures implemented in this ticket.

### Root Cause

Leftover dev CORS config from the template this repo was scaffolded from (`apps/api` is outside TICKET-501's own affected packages `apps/web` / `packages/trpc`, but the misconfiguration blocks any browser-based client of the API, present or future, the moment a client component tries to use `trpc.*.useQuery` / `useMutation` instead of the server-side proxy client).

### Impact

Blocked in-browser verification of the merchant policy screen — the literal DoD step "start the dev server ... and check the new page renders and the approve/kill-switch actions actually round-trip." Would have silently blocked every future client-side tRPC consumer too.

### Fix

Applied. `apps/api/src/server.ts`: dev-mode CORS changed from `cors({ origin: "*" })` to `cors({ origin: true, credentials: true })` — `origin: true` reflects the requesting origin (required once credentials are involved; a wildcard is invalid alongside them), and `credentials: true` emits the `Access-Control-Allow-Credentials` header the browser also requires. Gated the same as before (`NODE_ENV !== "prod"`), so no production behavior changed.

### Regression Test

None added. This is transport/dev-tooling configuration, not application behavior — the existing `router-boot.test.ts` doesn't exercise HTTP/CORS at all, and standing up a browser-CORS test harness for one config line isn't proportionate. Re-verified manually: the merchant policy page loads, approves, and flips the kill switch against the real dev API + Postgres after the fix.

### Related Ticket

TICKET-501

### Status History

- 2026-09-05: OPEN
- 2026-09-05: FIXED — dev CORS now reflects origin + allows credentials

---

## ISSUE-005 — TICKET-403's ledger-writer functions can't know *why* a hold is being released/reserved/committed

Status: FIXED
Severity: LOW
Found in: TICKET-403
Date: 2026-09-05
Violates invariant: none — a design-completeness gap, not a broken invariant.

### Problem

TICKET-403 asks `reserveCampaignBudget` / `releaseCampaignHold` /
`commitCampaignHold` (`packages/database/repositories/campaign-holds.ts`,
built by TICKET-107/108) to each append exactly one ledger event
(`HOLD_RESERVED` / `HOLD_RELEASED` / `HOLD_COMMITTED`) via `appendAuditEvent`
(TICKET-401) in the same transaction as the hold's own state change. But the
exact `eventType` / `fromState` / `toState` for a given call is not derivable
from the hold row alone: `releaseCampaignHold` is called for three different
real-world causes (buyer decline of a tier-2 offer, TTL expiry, payment
failure), each a *different* transition in the frozen state machine
(`packages/policy/contracts/state-machine.ts`) — `OFFER_PENDING
--BUYER_DECLINES--> OPEN`, `EXPIRED --HOLD_RELEASED--> EXPIRED`, and
`PAYMENT_FAILED --HOLD_RELEASED--> PAYMENT_FAILED` respectively — even though
all three carry the identical `HOLD_RELEASED` reason code. No
session-orchestration layer exists yet in this codebase to resolve "why" a
release is happening, so the repository function itself has no way to pick
the right transition on its own.

### Expected / Actual

Not a behavioural bug — no test failed. This is a design-completeness gap
the ticket text itself flagged as "a real ambiguity" and explicitly invited a
reasoned engineering call on, rather than a defect discovered after the
fact.

### Fix

Extended the parameter lists of all three functions with a caller-supplied
`ledger: CampaignHoldLedgerContext` (`sessionId`, `eventType`, `fromState`,
`toState`, `reasonCode`, plus optional `payload` / `policyVersion` /
`modelExplanation`) — mirroring how `appendAuditEvent` itself already takes
these as plain params rather than deriving them. The repository stays dumb
about *why* a transition is happening; the caller (today, each test's own
fixture code; eventually the session-orchestration layer no ticket has built
yet) supplies the exact transition. `campaignHoldId`, `campaignSpendMinor`
and `offerId` are deliberately NOT part of the caller-supplied context —
those always come from the hold row the call resolves, so the ledger amount
can never diverge from the hold's real `amount_minor`.

### Regression Test

`packages/database/tests/campaign-hold-ledger.test.ts` — asserts every
appended event carries the caller-supplied `eventType`/`fromState`/`toState`/
`reasonCode` correctly, that `campaignHoldId`/`campaignSpendMinor`/`offerId`
are always derived from the hold row, and that a full reserve→commit and
reserve→release lifecycle's ledger events net to the same outstanding budget
as `campaign_holds` itself.

### Related Ticket

TICKET-403 (found and resolved here)

### Status History

- 2026-09-05: OPEN — flagged by the ticket text itself as a genuine ambiguity
  requiring an engineering call, not a blocking spec gap.
- 2026-09-05: FIXED — `CampaignHoldLedgerContext` parameter added to all
  three hold functions; caller supplies the transition, repository stays
  pure I/O.

---

## ISSUE-004 — The "recommended" single-CTE-statement campaign-budget reservation over-admits under real concurrency

Status: FIXED
Severity: CRITICAL
Found in: TICKET-107
Date: 2026-09-05
Violates invariant: 7 (campaign spend cannot exceed per-deal or campaign limits), 8 (campaign budget reservations are atomic)

### Problem

TICKET-107 suggested, as "the recommended shape" (while explicitly allowing a
different design "if you're confident it's still genuinely atomic... but you
must actually prove that with the concurrency test"), a single SQL statement:

```sql
WITH locked_policy AS (
  SELECT campaign_budget_total_minor FROM merchant_policies
  WHERE merchant_id = $1 FOR UPDATE
),
outstanding AS (
  SELECT COALESCE(SUM(amount_minor), 0) AS outstanding_minor
  FROM campaign_holds
  WHERE merchant_id = $1 AND state IN ('RESERVED', 'COMMITTED')
)
INSERT INTO campaign_holds (...)
SELECT ... FROM locked_policy, outstanding
WHERE locked_policy.campaign_budget_total_minor - outstanding.outstanding_minor >= $amount
RETURNING ...
```

This was implemented exactly as described and run against the ticket's own
required real-Postgres concurrency test: 20 concurrent reservations of
₹100 each against a ₹1,000 campaign budget (each individually within the
per-deal cap; jointly ₹2,000, double the budget; expected exactly 10 to
succeed). The test failed: 18 of 20 succeeded, meaning the campaign budget
was jointly overspent by 80% — the exact failure mode this ticket exists to
prevent.

### Expected

Exactly 10 of 20 concurrent reservations succeed; `available` never goes
negative; the invariant holds regardless of how many callers race it.

### Actual

18 of 20 succeeded, reproducibly across repeated runs.

### Root Cause

PostgreSQL fixes one MVCC snapshot per *statement* under READ COMMITTED
(the default, and what this project uses). `SELECT ... FOR UPDATE`'s
wait-then-recheck behaviour (EvalPlanQual) only re-fetches and re-evaluates
the *specific row it was blocked on* (the `merchant_policies` row here) once
the lock is granted — it does not take a fresh snapshot for the rest of the
statement. The `outstanding` CTE reads a different table (`campaign_holds`)
that is not the locked row, so it kept using the *original* snapshot taken
before the statement blocked on the lock. Under real concurrency, many of
the 20 attempts had already opened their statement (and taken their
snapshot) before the first one committed, so their view of `outstanding`
stayed stale — missing holds committed by other transactions while they were
queued waiting for the row lock — and several of them independently
concluded there was room when there no longer was.

This is a genuine, load-bearing gap in the ticket's suggested "recommended
shape," not a design preference: the single-statement CTE pattern is unsafe
for this specific case (locking one table while aggregating an unrelated
one in the same statement), even though superficially similar
lock-then-conditionally-write patterns are safe in other contexts.

### Impact

Had this shipped, two or more concurrent negotiations could jointly reserve
more campaign budget than a merchant approved — a direct violation of PRD
§21 invariants 7 and 8, and of PRD §6.5's stated defense ("two concurrent
negotiations cannot jointly overspend"). Caught before merge by the ticket's
own required concurrency test; never reached `dev` or any real merchant
data.

### Fix

Applied. `packages/database/repositories/campaign-holds.ts`'s
`reserveCampaignBudget` now runs three sequential statements inside one
`database.transaction(...)`, not one SQL statement:

1. `SELECT campaign_budget_total_minor FROM merchant_policies WHERE
   merchant_id = $1 FOR UPDATE` — acquires the row lock, blocking until any
   other in-flight reservation for this merchant commits.
2. A **separate** statement summing `campaign_holds` for RESERVED/COMMITTED
   states. Because it is a new statement, READ COMMITTED gives it a fresh
   snapshot taken only after step 1 has the lock — and every other
   concurrent attempt for this merchant is either already committed (visible
   here) or still blocked on its own step 1 (and therefore cannot have
   inserted anything yet). Never stale.
3. A conditional `INSERT`, still inside the same transaction and therefore
   still holding the lock from step 1, so nothing can interleave between
   the read in step 2 and this write.

This still satisfies "not read, then check, then write" in the sense that
matters — no concurrent transaction can observe or mutate this merchant's
outstanding holds between this transaction's read and its write — using
three statements under one lock instead of one statement, because the
one-statement version was measured to be unsafe.

### Regression Test

`packages/database/tests/campaign-budget-reservation.test.ts` — the
20-concurrent-reservations test itself is the regression test: it asserts
exactly 10 of 20 succeed, every successful hold is distinct, and the final
`available` (`total − Σ(RESERVED/COMMITTED amount_minor)`) equals the exact
expected arithmetic (0), not merely "≥ 0."

### Related Ticket

TICKET-107 (found and fixed here)

### Status History

- 2026-09-05: OPEN — discovered by the ticket's own required concurrency test.
- 2026-09-05: FIXED — reservation rewritten as three statements under one
  row-locked transaction; concurrency test passes consistently across
  repeated runs.

---

## ISSUE-003 — TICKET-001's database test harness was never built, despite being marked DONE

Status: FIXED
Severity: MEDIUM
Found in: TICKET-507 (pre-check, before starting)
Date: 2026-09-04
Violates invariant: none

### Problem

TICKET-001 ("Test infrastructure") is marked DONE and folded into the Phase 0 "✅ COMPLETE" banner. Its scope included "a test database strategy (separate Postgres database via the existing docker-compose, truncated between suites)" and its acceptance criteria required a test that "can open a transaction against a real test database and roll it back," with "one smoke test proving the DB harness connects." None of this exists: `docker-compose.yml` defines exactly one Postgres service (`postgresdb`, database `dev`); there is no second/test database; there is no root-level shared DB-test helper; and no smoke test exists anywhere in the repo.

### Expected

A ticket marked DONE should have its acceptance criteria actually met, and any later ticket needing "a real Postgres" (CONTRACTS.md §8 seam 1) should find an established, shared pattern to build on.

### Actual

`packages/database/package.json` has no `test` script and no `vitest.config.ts`. The only two test files in the repo (`packages/policy/tests/contracts.test.ts`, `packages/trpc/tests/router-boot.test.ts`) never touch a database.

### Root Cause

TICKET-001 was marked DONE during the Phase 0 push without its DB-harness acceptance criterion actually being verified — likely conflated with the schema/migration work in TICKET-003/004, which touches the database but doesn't test connectivity or provide a reusable harness.

### Impact

No product invariant is broken. But every ticket that needs seam 1 — TICKET-107 (real-concurrency budget test), TICKET-111, TICKET-302, TICKET-507, and others — is building on a foundation that was claimed but not delivered, and risks each one inventing its own ad hoc approach.

### Fix

Fixed. Built the shared real-Postgres test harness TICKET-001 originally promised, at `packages/database/testing/db.ts`, with **no changes to `docker-compose.yml` or `.github/workflows/ci.yml`** — both already run a single Postgres server reachable at `DATABASE_URL`, and that is all this design needs:

- On first use in a process, the harness derives a sibling database name from `DATABASE_URL` (`dev` → `dev_test`, on the exact same Postgres server) and, connecting to the server's built-in `postgres` administrative database, creates it if it does not already exist. Postgres has no `CREATE DATABASE IF NOT EXISTS` and a database name cannot be a bind parameter, so this is guarded with a `pg_database` pre-check plus a catch on Postgres error code `42P04` (`duplicate_database`) for the race between parallel test workers or CI runs — every other error still propagates (CONTRACTS.md §6: fail closed, don't swallow the unexpected).
- It then applies the real Drizzle migrations to that sibling database programmatically, via `drizzle-orm/node-postgres/migrator`'s `migrate()` pointed at `packages/database/drizzle` — the same folder `drizzle-kit generate` already writes to. No new SQL migration files; the schema is identical to `dev`'s.
- Two isolation strategies are exported for tests to pick from: `withRollback` (open a transaction, run inside it, always roll back — including the DDL, since Postgres DDL is transactional) for the common case, and `truncateAllTables` (clear every committed row in `public`, migrations bookkeeping in the separate `drizzle` schema untouched) for tests that must observe real commits across separate connections, e.g. TICKET-107's concurrency test.
- The real `dev` database (TICKET-507's seed data) is never touched by any of this — the harness only ever opens a connection to `dev_test` or, transiently, to the admin `postgres` database to issue `CREATE DATABASE`.

Verified end-to-end, not just in theory: dropped the `dev_test` database, ran `pnpm --filter @repo/database test`, and confirmed via `psql` that the harness recreated `dev_test` from scratch and applied all 3 migrations (matching `packages/database/drizzle/meta/_journal.json` exactly) before the smoke test suite ran against it; `tests/seed.test.ts` continued passing unmodified against the real `dev` database in the same run.

### Regression Test

`packages/database/tests/db-harness.test.ts` — asserts `TEST_DATABASE_URL` differs from `DATABASE_URL` and resolves to the expected `_test`-suffixed sibling; asserts `SELECT current_database()` through the harness's client actually returns that sibling name; opens a transaction via `withRollback`, creates a throwaway table and row inside it, confirms it's visible inside the transaction, then confirms the table does not exist at all afterwards (proving both data and DDL roll back); and asserts `truncateAllTables` clears a committed row from a throwaway table without dropping it.

### Related Ticket

TICKET-001 (unmet, now delivered), TICKET-507 (worked around, unaffected), TICKET-107 (unblocked — can now build its real-concurrency test on `withRollback`/`truncateAllTables` against `dev_test`)

### Status History

- 2026-09-04: OPEN
- 2026-09-05: FIXED — built the sibling-database (`dev_test`) real-Postgres test harness at `packages/database/testing/db.ts`, no docker-compose or CI changes needed, with regression test `packages/database/tests/db-harness.test.ts`.

---

## Closed issues

## ISSUE-001 — API cannot boot without Google OAuth environment variables

Status: FIXED
Severity: MEDIUM
Found in: TICKET-006
Date: 2026-09-04
Violates invariant: none

### Problem

Anything that imports the tRPC server router fails at module load unless three Google OAuth environment variables are set. This was hit while verifying that the OpenAPI document still generates after adding the negotiation, merchant and audit routers.

### Expected

A clean checkout with only `DATABASE_URL` configured should be able to boot the API and serve the OpenAPI document. Google sign-in is starter scaffolding, not a dependency of this product.

### Actual

`packages/services/env.ts` validates `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_OAUTH_REDIRECT_URI` as required strings at module load. The auth router imports the user service, and the root router imports the auth router, so the whole router tree throws. Supplying dummy values makes it work, which is how the OpenAPI check was completed.

### Root Cause

Pre-existing in the starter template, not introduced by Phase 0. The service itself already treats Google as optional — `UserService.getAuthenticationMethods` branches on `!!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET)` — so the env schema and the code that reads it disagree. The schema is the side that is wrong.

### Impact

Every Phase 2 and Phase 3 agent hits this on first run, as will the demo machine. No product invariant is affected; it is a boot blocker, not a correctness problem.

### Fix

Applied. The product decision was to drop Google sign-in entirely rather than make the variables optional, so the dead surface was removed rather than patched:

- Deleted `packages/services/user/`, `packages/services/clients/google-oauth.ts` and `packages/services/env.ts` — the env schema declared only the three OAuth variables, so it had nothing left to validate.
- Deleted `packages/trpc/server/routes/auth/` and `packages/trpc/server/services/`, and removed `auth` from the root router.
- Dropped the `google-auth-library` dependency from `@repo/services`, and the now-unused `@repo/services` dependency from `@repo/trpc`.
- `packages/services` is kept as the empty service-layer placeholder named in `CONTRACTS.md` §2, with a README explaining why it is empty.

The three variables were never present in any `.env` file, so nothing needed removing there.

### Regression Test

`packages/trpc/tests/router-boot.test.ts`. Importing the router tree is itself the assertion — the test runs with `DATABASE_URL` and nothing else, so a future change that puts a required environment variable behind the router fails at import time. It also asserts the four public paths still generate, and that `/authentication/supported-providers` is gone.

### Related Ticket

TICKET-006 (found), TICKET-204 (would have been blocked by it)

### Status History

- 2026-09-04: OPEN
- 2026-09-04: FIXED — auth surface removed, regression test added

---

## ISSUE-002 — Legacy `.eslintrc.cjs` files shadow the flat config

Status: FIXED
Severity: LOW
Found in: TICKET-006
Date: 2026-09-04
Violates invariant: none

### Problem

`packages/database/.eslintrc.cjs` survives from the pre-flat-config era. Now that the package has a `lint` script, ESLint lints the legacy file itself and reports `'module' is not defined`.

### Expected

`pnpm lint` is clean, so that a real boundary violation is the only thing that ever shows up in its output.

### Actual

One warning on every run. Harmless today, but it fails immediately if anyone adds `--max-warnings 0` to that package — which the boundary rules require for `packages/policy` and will require for `packages/agent` and `packages/payments`.

### Root Cause

Leftover configuration files from the template. `packages/services`, `packages/logger` and `packages/trpc` carry the same file.

### Impact

Noise in lint output, which makes a genuine boundary violation easier to miss. That is the only reason this is worth recording at all.

### Fix

Applied. Deleted all five orphaned files: `packages/database`, `packages/logger`, `packages/trpc`, `packages/services` and `apps/api`. Every one of those packages already had a flat `eslint.config.mjs` or was covered by one, so nothing changed about which rules run — only the warning went away.

### Regression Test

None warranted. `pnpm lint` exiting clean is the check, and the boundary rules run under `--max-warnings 0`, so any new noise fails the build rather than hiding in output.

### Related Ticket

TICKET-006

### Status History

- 2026-09-04: OPEN
- 2026-09-04: FIXED — five orphaned config files deleted

---

## Template

Copy this block for each new issue.

```markdown
## ISSUE-001 — <short title>

Status: OPEN
Severity: CRITICAL / HIGH / MEDIUM / LOW
Found in: TICKET-XXX
Date: YYYY-MM-DD
Violates invariant: <number from PRD §21, or "none">

### Problem

What happened.

### Expected

What should have happened.

### Actual

What actually happened.

### Root Cause

Why it happened.

### Impact

What product behavior or invariant is affected.

### Fix

What was changed or needs to be changed.

### Regression Test

What test prevents this issue from returning.

### Related Ticket

TICKET-XXX

### Status History

- YYYY-MM-DD: OPEN
- YYYY-MM-DD: FIXED
```
