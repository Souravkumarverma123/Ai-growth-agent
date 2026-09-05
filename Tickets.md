# Merchant Growth Agent — Implementation Plan

**Derived from:** `PRD.md`
**Issues found during implementation go to:** `issue-tracker.md`
**Build window:** ~32 hours wall clock

Statuses: `TODO` · `IN_PROGRESS` · `BLOCKED` · `DONE` · `CANCELLED`
Priorities: **P0** (invariant-critical, cannot ship without) · **P1** (demo-critical) · **P2** (drop if behind)

---

## Sizing reality

| | |
| --- | --- |
| Total tickets | 46 |
| Estimated agent-hours | ~48.5 |
| Wall clock available | ~32 h |
| Required parallelism | ~1.5× sustained, i.e. 3 agents with one reviewer |

**This is tight, not comfortable.** The plan is deliberately front-loaded with P0 invariant work so that if the schedule slips, what gets dropped is UI polish and P2 tickets — never a control. **Depth of the core invariant beats feature count.** If forced to choose, ship fewer screens with every invariant test passing.

**Phase 0 is serial and blocks everything.** It is owned by the lead, not delegated. Budget 4 hours and do not compress it: with frozen types, agents cannot collide on schema, PRs stop conflicting, and a bad ticket produces a compile error rather than a silent integration failure found at hour 28.

---

## Package layout assumed

| Package | Role |
| --- | --- |
| `packages/policy` | **New.** Deterministic engine. Zero AI dependencies, lint-enforced. |
| `packages/agent` | **New.** Merchant agent, model abstraction, message composition. |
| `packages/payments` | **New.** Razorpay adapter, rail state, reconciliation. |
| `packages/database` | Existing. Drizzle schema and client. |
| `packages/trpc` | Existing. Routers, OpenAPI surface. |
| `packages/services` | Existing. Service layer. |
| `apps/api` | Existing. Express host, OpenAPI, Scalar. |
| `apps/web` | Existing. Next.js merchant console. |

---

# Phase 0 — Contract Freeze  ✅ COMPLETE

**Serial. Owned by the lead. Blocks every other phase.** No feature ticket starts until all of Phase 0 is merged.

**Status: merged 2026-09-04.** Contracts are FROZEN — see `CONTRACTS.md` before changing anything they declare. `pnpm check-types`, `pnpm lint` and `pnpm test` are green; the B1 boundary rule is verified to fail the build on violation; the OpenAPI document generates 13 paths; migration `0001_sour_dreadnoughts.sql` covers 11 tables. **Phases 1–5 may now start in parallel.**

---

### TICKET-001 — Test infrastructure

**Status:** DONE · **Priority:** P0 · **Dependencies:** none

**Objective.** Establish Vitest at the workspace root so every package inherits it, and so invariant tests can be written from the first feature ticket onwards.

**Scope.** Vitest config at root with workspace projects; a test database strategy (separate Postgres database via the existing docker-compose, truncated between suites); npm scripts wired into Turbo. No tests written here beyond one smoke test proving the DB harness connects.

**Acceptance criteria.**
- `pnpm test` runs from the root and discovers tests in every package.
- A test can open a transaction against a real test database and roll it back.
- Turbo caches test runs correctly.

**Tests required.** One smoke test asserting the DB harness connects and rolls back.

**Affected.** Root config, `turbo.json`, each package's `package.json`.

**Gap noted 2026-09-04 (ISSUE-003):** the test-database strategy and DB-harness smoke test described above were never actually built — no second Postgres database exists and no smoke test exists anywhere in the repo. `packages/policy` and `packages/trpc` are the only packages with tests, and neither touches a database. TICKET-507 works around this by seeding and verifying directly against the real `dev` database. A proper shared real-Postgres test harness is still needed before TICKET-107's concurrency test.

**Update 2026-09-05:** ISSUE-003 is fixed. The harness now exists at `packages/database/testing/db.ts` — a sibling `dev_test` database on the same Postgres server as `DATABASE_URL`, created and migrated idempotently on first use, with `withRollback` and `truncateAllTables` isolation helpers, and its own smoke test at `packages/database/tests/db-harness.test.ts`. TICKET-107's concurrency test can build directly on this (`truncateAllTables` for the commit-visible-across-connections case its test needs) instead of inventing its own approach.

**Parallelization.** None — first ticket.

**References.** PRD §21; Settled by: Q26

---

### TICKET-002 — ReasonCode enum and state machine types

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-001

**Objective.** Freeze the 28-code closed enum and the session state type, so no other ticket can invent a code or a state.

**Scope.** The enum exactly as listed in PRD §14 — 28 members, no more. The state union from PRD §15. A transition type that makes `reason_code` a required field, so a transition written without one fails to typecheck.

**Acceptance criteria.**
- Enum has exactly 28 members matching PRD §14, verified by a test.
- State union matches PRD §15 including all six terminal states.
- Constructing a transition without a reason code is a compile error.
- `FLOOR_BREACH` is present and documented as a defensive assertion.

**Tests required.** Enum membership count and exact-name test. A type-level test that an incomplete transition does not compile.

**Affected.** `packages/policy`

**Parallelization.** None — everything downstream imports this.

**References.** PRD §14, §15; Settled by: Q30, Q34

---

### TICKET-003 — Merchant policy, SKU, and commitment schemas

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-002

**Objective.** Freeze the policy contract, including the fields deliberately absent.

**Scope.** Drizzle tables and matching zod schemas for merchant policy (PRD §5.1), per-SKU policy (§5.2), and the closed commitment set (§5.3). `policy_version` on the merchant policy row. Schema documentation comment on `autonomous_payment_execution` carrying the exact semantics from PRD §9.2.

**Acceptance criteria.**
- All fields from PRD §5.1–5.3 present with stated MVP defaults.
- `max_discount_percent`, `min_profit_margin`, `max_transaction_value`, and binding COGS are **absent**, with a comment recording why.
- `autonomous_payment_execution` defaults to `false` and its comment states it means willingness to *accept* a buyer-side authorization, not permission to charge.
- `allowed_commitments` is a closed set; an unknown commitment fails validation.

**Tests required.** Zod rejects an unknown commitment type. Defaults match PRD.

**Affected.** `packages/database`, `packages/policy`

**Parallelization.** None.

**References.** PRD §5, §9.2; Settled by: Q11, Q23, Q33

---

### TICKET-004 — Session, Candidate, Offer, CampaignHold schemas

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-002, TICKET-003

**Objective.** Freeze the four objects that carry the negotiation and the money.

**Scope.** Drizzle tables and zod schemas for `NegotiationSession` (state, `round_index`, `tier1_refused`, `policy_version`), `Candidate` (move type, basket, contribution, tier, required shortfall), `Offer` (every field in PRD §10), `CampaignHold` (amount, state, TTL, offer reference). All money as **integer minor units** with an explicit currency field. Unique constraint groundwork for `offer_id → order_id`.

**Acceptance criteria.**
- Offer carries every field from PRD §10 including `policy_version`, `campaign_spend_minor`, `candidate_id`, `engine_signature`.
- No money field is a float anywhere.
- Candidate `move_type` is a closed enum of the five types in PRD §8.
- `CampaignHold` state is a closed enum: reserved / released / committed.

**Tests required.** Schema round-trip. A float amount is rejected.

**Affected.** `packages/database`, `packages/policy`

**Parallelization.** None.

**References.** PRD §8, §10, §6.5; Settled by: Q13, Q22, Q28

---

### TICKET-005 — AuditEvent schema and hash-chain types

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-002, TICKET-004

**Objective.** Freeze the ledger contract with justification and explanation structurally separated.

**Scope.** Append-only `AuditEvent` table per PRD §13.1. `reason_code` non-nullable. `model_explanation` nullable and in its own column, documented as non-authoritative. `prev_hash` and `event_hash`. No update or delete path exposed anywhere in the data layer.

**Acceptance criteria.**
- `reason_code` is non-nullable and typed to the closed enum.
- `model_explanation` is a distinct nullable column, never read by any decision path.
- The data layer exposes append and read only; no update or delete function exists.
- A comment records the self-anchored chain limitation from PRD §13.3.
- `model_explanation` is documented as holding a short final rationale only — never chain-of-thought (RA-5).
- **Exceeded, 2026-09-04:** append-only is now also enforced at the database level — migration `0002_audit_events_append_only.sql` installs `BEFORE UPDATE`/`BEFORE DELETE` triggers on `audit_events` that reject any such statement regardless of caller privilege. Closes the gap where any role with ordinary table privilege could have altered or removed evidence; does not touch the disclosed self-anchored-chain limitation, which remains accepted. Verified live: an UPDATE against the trigger raises `audit_events is append-only: UPDATE is not permitted on this table`.

**Tests required.** An event without a reason code fails to insert. No update/delete export exists.

**Affected.** `packages/database`, `packages/policy`

**Parallelization.** None.

**References.** PRD §13; Settled by: Q13

---

### TICKET-006 — Router signatures, stub bodies, and boundary lint rule

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-003, TICKET-004, TICKET-005

**Objective.** Publish every procedure signature so feature tickets implement against fixed contracts, and make boundary rule B1 machine-checked.

**Scope.** tRPC procedures for the buyer-facing surface (PRD §18) and the merchant console, with input/output zod schemas and stub bodies that throw. An ESLint dependency rule asserting `packages/policy` imports no model SDK. A rule or test asserting no order-creation function accepts an amount parameter.

**Acceptance criteria.**
- Every procedure named in PRD §18 and the merchant console has a typed signature and a throwing stub.
- OpenAPI document generates cleanly and Scalar renders it.
- Adding a model SDK import to `packages/policy` fails lint.
- The order-creation signature check is in place before `packages/payments` exists.

**Tests required.** Lint rule fires on a deliberately added forbidden import.

**Affected.** `packages/trpc`, `packages/policy`, `apps/api`, eslint config

**Parallelization.** None. **This is the gate — all parallel work begins after this merges.**

**References.** PRD §4 boundary rules, §18; Settled by: Q18, Q26

---

# Phase 1 — Deterministic Core

**All of Phase 1 lives in `packages/policy` and is pure.** No I/O except where stated. These tickets parallelize well because the contracts are frozen.

---

### TICKET-101 — Eligibility engine

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 0

**Objective.** Decide, from merchant-controlled state alone, whether a session may negotiate.

**Scope.** Rules over cart inactivity, exit-intent, cart age, cart value threshold, first-time-buyer. Returns eligible or a refusal code. **Takes no conversation input of any kind.**

**Acceptance criteria.**
- Function signature accepts session state and policy only — there is no parameter through which buyer text could arrive.
- Unflagged session yields `NOT_AT_RISK`.
- Kill switch off yields `NEGOTIATION_DISABLED`.
- Cart with no negotiable SKU yields `SKU_NOT_NEGOTIABLE`.
- Eligibility is evaluated at session open and re-checked **once** before a Tier 2 mint — never per round (RA-3).

**Tests required.** Buyer-supplied claims cannot change the outcome (the type forbids passing them). Each refusal path returns its own code.

**Affected.** `packages/policy`

**Parallelization.** Independent.

**References.** PRD §3, §15, §16 RA-3; Settled by: Q4, Q24, OQ-3

---

### TICKET-102 — Basket contribution calculator

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 0

**Objective.** Compute contribution for any basket, at basket level.

**Scope.** `Σ((line_price − line_floor) × qty) + Σ(commitment_values)`. Integer minor units throughout. Also computes the counterfactual from the original cart at list.

**Acceptance criteria.**
- Matches the PRD §18.2 worked example exactly: original cart ₹950, Tier 1 bundle at ₹3,020 gives ₹950, Tier 2 at ₹2,300 gives ₹750.
- Per-line evaluation is impossible — the function takes a basket, not a line.
- No floating point anywhere in the calculation.

**Tests required.** All three worked-example figures. Commitment values contribute correctly. Rounding is exact.

**Affected.** `packages/policy`

**Parallelization.** Independent. **TICKET-103, 104, 109 depend on this.**

**References.** PRD §6.1–6.3, §18.2; Settled by: Q10, Q11

---

### TICKET-103 — Candidate generator

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-102

**Objective.** Produce a bounded, deterministic, capped candidate set.

**Scope.** The five move types and their slot allocation from PRD §8. Hard cap of 12. Deterministic ordering. **Inputs are session state and policy only** — boundary rule B4. Non-negotiable SKUs may appear at list price but never carry a concession.

**Acceptance criteria.**
- Never returns more than 12 candidates.
- Same input produces the identical set in the identical order, every run.
- No generated candidate prices any line below its floor.
- Function signature cannot accept conversation content.
- Emits the counts needed for `CANDIDATES_EVALUATED`.

**Tests required.** Determinism across 100 runs. Property test over randomized catalogues: no sub-floor line, ever. Cap holds when the catalogue is large.

**Affected.** `packages/policy`

**Parallelization.** Blocks TICKET-104.

**References.** PRD §8; Settled by: Q20, Q28

---

### TICKET-104 — Tier assignment and feasible-set marking

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-102, TICKET-103

**Objective.** One search, two zones: mark each candidate Tier 1 or Tier 2 with its required shortfall.

**Scope.** Tier derived arithmetically from contribution vs counterfactual. Tier 2 candidates carry their exact shortfall. Tier 2 candidates are present in the set but **locked** until `tier1_refused` is true.

**Acceptance criteria.**
- Tier is derived, never accepted from a caller.
- A Tier 2 candidate cannot be selected while `tier1_refused` is false.
- Empty feasible set yields `NO_FEASIBLE_BASKET`.

**Tests required.** Tier 2 selection before refusal is rejected. Tier assignment matches the worked example.

**Affected.** `packages/policy`

**Parallelization.** Blocks TICKET-110.

**References.** PRD §6.4, §7.1, §8; Settled by: Q19, Q20

---

### TICKET-105 — Concession curve and round envelope

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 0

**Objective.** Fix the economic envelope per round, deterministically, before the model is consulted.

**Scope.** `[0.4, 0.7, 1.0]` applied to available floor-derived headroom. Round cap at 3, yielding `ROUND_LIMIT_REACHED`.

**Acceptance criteria.**
- Round *n* releases exactly the curve fraction of available headroom.
- The curve is identical regardless of any message content — there is no path for conversation to reach it.
- Round 4 is impossible.

**Tests required.** **Injection-resistance test:** the round envelope is byte-identical across radically different buyer messages. Round cap enforced.

**Affected.** `packages/policy`

**Parallelization.** Independent.

**References.** PRD §7, §16 RA-4; Settled by: Q12, OQ-4

> **RA-4 settled:** the round envelope *is* the curve on floor-derived headroom. Do **not** add a separate merchant-set concession ceiling.

---

### TICKET-106 — Floor enforcement and defensive assertion

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-103

**Objective.** Make a sub-floor price structurally unreachable, and halt loudly if one ever appears.

**Scope.** Floors as a generation constraint, not a post-hoc filter. A defensive assertion at mint time that halts the session with `FLOOR_BREACH` if a sub-floor line is ever observed.

**Acceptance criteria.**
- The generator cannot construct a sub-floor candidate.
- The assertion exists, is reachable only by a bug, and halts rather than continues.

**Tests required.** Property test over randomized catalogues. A deliberately corrupted candidate triggers the halt.

**Affected.** `packages/policy`

**Parallelization.** Independent after TICKET-103.

**References.** PRD §14, §17 row 9; Settled by: Q34

---

### TICKET-107 — Campaign budget accounting with atomic reservation

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 0

**Objective.** Make joint overspend impossible under concurrency.

**Scope.** `available = total − reserved − committed`. Both caps checked against `available`. Reservation is an **atomic conditional decrement under a row lock** — not read, then check, then write. Emits `DILUTION_EXCEEDS_PER_DEAL_CAP` and `CAMPAIGN_BUDGET_EXHAUSTED`.

**Acceptance criteria.**
- Reservation is a single atomic statement.
- Per-deal cap and campaign budget are separate checks with separate codes.
- Shortfall exceeding the per-deal cap walks away even with budget remaining.

**Tests required.** **Concurrency test against the real database**, not simulated: N parallel reservations that each individually fit but jointly exceed must leave `available ≥ 0`. Both cap codes fire independently.

**Affected.** `packages/policy`, `packages/database`

**Parallelization.** Blocks TICKET-108.

**References.** PRD §6.5; Settled by: Q22

---

### TICKET-108 — Campaign hold lifecycle

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-107

**Objective.** Reserve / release / commit, with a TTL matching the offer.

**Scope.** Hold created at Tier 2 mint with TTL = 600 s. Released on expiry, decline, or payment failure. Committed on confirmed capture. Each transition emits its code.

**Acceptance criteria.**
- Expiry releases the hold and restores `available`.
- Payment failure releases the hold.
- Capture commits the hold.
- A hold is never double-released or double-committed.

**Tests required.** Full lifecycle across all three terminal paths. Denial-of-budget: repeatedly minting and abandoning offers cannot permanently reduce `available`.

**Affected.** `packages/policy`, `packages/database`

**Parallelization.** Blocks TICKET-403.

**References.** PRD §6.5; Settled by: Q22

---

### TICKET-109 — Objective ordering and slow-moving tolerance

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-102, TICKET-104

**Objective.** Select within the feasible set by a stated deterministic ordering.

**Scope.** Contribution primary; a slow-moving candidate within **3%** of the best contribution is preferred; tiebreak on lowest campaign spend. The 3% constant is fixed, not configurable.

**Acceptance criteria.**
- Ordering is the stated lexicographic rule, never a weighted score.
- The band changes selection at 2% behind and does not at 4% behind.

**Tests required.** Boundary test at 2% and 4%. Ordering determinism.

**Affected.** `packages/policy`

**Parallelization.** Independent.

**References.** PRD §6.6; Settled by: Q21, Q29

---

### TICKET-110 — Offer minting and signature

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-104, TICKET-107

**Objective.** Make the engine the only thing in the system that can mint an offer.

**Scope.** Mint takes a structured intent (candidate id + frame), re-derives economics from the candidate, reserves budget if Tier 2, writes the offer with TTL and `policy_version`, signs it. The signing path is **not exported to the agent package**.

**Acceptance criteria.**
- Mint accepts no amount, no tier, and no campaign spend from its caller — all three are derived.
- A candidate id not in this round's set is rejected.
- Tier 2 mint without `tier1_refused` is rejected.
- The signing function is not reachable from `packages/agent`.

**Tests required.** Mint with a forged candidate id fails. Mint with an out-of-set id fails. Derived amount matches the worked example exactly.

**Affected.** `packages/policy`

**Parallelization.** Blocks TICKET-202, TICKET-301.

**References.** PRD §10; Settled by: Q6, Q13

---

### TICKET-111 — Offer TTL, single-use, and basket binding

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-110

**Objective.** Three refusals that make an offer unreplayable, unreassignable, and perishable.

**Scope.** `OFFER_EXPIRED` past 600 s. `OFFER_ALREADY_CONSUMED` on replay — `consumed_at` set exactly once, transactionally. `BASKET_MISMATCH` if the accepted basket differs in any respect.

**Acceptance criteria.**
- Accepting an expired offer fails.
- Accepting twice fails the second time, under concurrency as well as sequentially.
- Any basket difference — SKU, quantity, unit price, commitment — fails.

**Tests required.** All three refusals. Concurrent double-accept leaves exactly one consumption.

**Affected.** `packages/policy`, `packages/database`

**Parallelization.** Blocks TICKET-302.

**References.** PRD §10.2; Settled by: Q13

---

# Phase 2 — Agent Layer

---

### TICKET-201 — NegotiationModel abstraction and structured intent

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 0

**Objective.** Define the model's entire output surface, containing no numbers.

**Scope.** The `NegotiationModel` interface returning `{ candidate_id, message_frame, terminal_action? }`. Nothing else. A scripted implementation for tests. **Seam 2** from the spec.

**Acceptance criteria.**
- The intent type has **no numeric field**. Adding one is a review-blocking change.
- A scripted implementation satisfies the interface with the same power as a real model.
- `terminal_action` accepts only `WALK_AWAY`.

**Tests required.** Type-level test that no numeric field exists. Scripted model drives a full negotiation.

**Affected.** `packages/agent`

**Parallelization.** Blocks TICKET-202, TICKET-206.

**References.** PRD §10.1; Settled by: Q6

---

### TICKET-202 — Merchant agent orchestration

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-110, TICKET-201

**Objective.** Run the negotiation loop: context in, intent out, offer minted, round advanced.

**Scope.** Fetch unlocked candidates for the round, call the model, pass the intent to mint, advance the round, handle terminal conditions including `WALK_AWAY`. **Tier 1 is presented first in every session; Tier 2 candidates are not exposed until a refusal is logged.**

**Acceptance criteria.**
- Round 1 exposes only Tier 1 candidates to the model.
- A Tier 1 refusal sets `tier1_refused` and unlocks Tier 2 for later rounds.
- The agent package cannot import the payment layer or policy write paths.
- `WALK_AWAY` terminates cleanly with its code.

**Tests required.** Tier 2 never reachable in round 1. Refusal unlocks correctly. Walk-away terminates.

**Affected.** `packages/agent`

**Parallelization.** Blocks TICKET-204.

**References.** PRD §7, §7.1, §16 RA-2; Settled by: Q12, Q19, OQ-2

> **RA-2 settled:** present the engine's **best** Tier 1 candidate. **One** refusal of it sets `tier1_refused` and unlocks Tier 2.

---

### TICKET-203 — Constrained message composition

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-110, TICKET-201

**Objective.** Make it structurally impossible for the agent to state a fact the offer does not contain.

**Scope.** Outbound message generated **from the minted offer object** through a constrained template with slots. No free-form claim generation about stock, scarcity, expiry, or price movement. Truthful answer if directly asked about expiry.

**Acceptance criteria.**
- Every number in an outbound message comes from the offer row.
- The agent cannot emit manufactured urgency or scarcity.
- Slow-moving status is not volunteered but is answered truthfully when asked.

**Tests required.** No outbound message contains a numeral absent from the offer. Scarcity phrases cannot be produced.

**Affected.** `packages/agent`

**Parallelization.** Independent after TICKET-201.

**References.** PRD §7.2; Settled by: Q16, Q23

---

### TICKET-204 — Negotiation protocol procedures

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-006, TICKET-202

**Objective.** Implement the buyer-facing tRPC procedures behind the frozen signatures.

**Scope.** Get session context, open negotiation, propose, respond to offer, accept offer. **Nothing on this surface reveals the floor, available budget, per-deal cap, or the concession curve.**

**Acceptance criteria.**
- Ineligible session returns `NOT_AT_RISK` cleanly and logs it.
- No response body contains a floor, a budget figure, a cap, or a curve value.
- Accept returns a payment handle, never a captured payment.

**Tests required.** Response-shape test asserting no forbidden field is ever serialized. Ineligible refusal path.

**Affected.** `packages/trpc`, `apps/api`

**Parallelization.** Blocks TICKET-205.

**References.** PRD §18; Settled by: Q18, Q24

---

### TICKET-205 — MCP server adapter

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-204

**Objective.** Expose the same procedures as MCP tools so a third-party agent can negotiate without bespoke integration.

**Scope.** Thin adapter over the existing procedures. Public endpoint. The Scalar documentation URL is part of the submission.

**Acceptance criteria.**
- A stock model connected to the endpoint can complete a negotiation end to end.
- Tool descriptions leak no policy internals.

**Tests required.** End-to-end negotiation driven through the MCP surface.

**Affected.** `apps/api`, `packages/trpc`

**Parallelization.** Independent after TICKET-204.

**References.** PRD §18; Settled by: Q18

---

### TICKET-206 — Buyer agent harness

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-201, TICKET-205

**Objective.** An independent buyer agent with hidden constraints, for the demo and for tests.

**Scope.** Stock model. System prompt contains **only** a budget, a goal, and negotiating latitude — no script, no target outcome, no knowledge of floors, tiers, or budget. Reservation price hidden from the merchant agent. Configurable budget so two runs can produce different endings.

**Acceptance criteria.**
- The prompt is displayable on screen and visibly contains no script.
- Two different budgets produce materially different outcomes — one closing, one walking away.
- The merchant agent never receives the reservation price.

**Tests required.** Two seeded runs produce the two documented outcomes.

**Affected.** `packages/agent`, demo harness

**Parallelization.** Independent after TICKET-205.

**References.** PRD §18.1; Settled by: Q3, Q32

---

# Phase 3 — Payments

---

### TICKET-301 — Razorpay test-mode order creation

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-110

**Objective.** Create an order from an offer id and nothing else.

**Scope.** Razorpay test-mode client. `createOrder(offerId)` — **no amount parameter, boundary rule B3.** Amount, currency, and basket read from the offer row. `receipt` carries the offer id; `notes` carry offer id, tier, and campaign spend.

**Acceptance criteria.**
- The function signature has exactly one parameter.
- Amount sent to Razorpay always equals `offer.total_minor`.
- `notes` and `receipt` populated for human reconciliation.
- No capture or charge call exists anywhere in the package.

**Tests required.** Signature test asserting no amount parameter. Amount always sourced from the offer row. Grep-style test that no capture call exists.

**Affected.** `packages/payments`

**Parallelization.** Blocks TICKET-302, TICKET-303.

**References.** PRD §11, §4 B3; Settled by: Q6, Q9

---

### TICKET-302 — Offer-to-order uniqueness

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-111, TICKET-301

**Objective.** `offer_id → exactly one order`, enforced by the database.

**Scope.** Unique constraint plus a transactional invariant. **Do not reference `X-Payout-Idempotency` anywhere** — it is a RazorpayX Payouts feature and does not apply to Orders.

**Acceptance criteria.**
- A second order creation for the same offer fails at the database level, not in application logic.
- Concurrent order creation for one offer yields exactly one order.
- No code or comment claims header-based idempotency.

**Tests required.** Concurrent double-create leaves exactly one order. Constraint violation is surfaced as a clean domain error.

**Affected.** `packages/payments`, `packages/database`

**Parallelization.** Independent after TICKET-301.

**References.** PRD §11; Settled by: Q9, Q15

---

### TICKET-303 — Payment handle and buyer authorization

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-301

**Objective.** Return a handle the human buyer authorizes. Nothing more.

**Scope.** Order creation returns a payment handle to the buyer surface. The buyer authorizes in Razorpay test mode. No agent-initiated capture at any point.

**Acceptance criteria.**
- The only reachable path is `createOrder(offerId) → handle → buyer authorizes`.
- No agent code path can trigger a charge.

**Tests required.** No capture path is reachable from the agent package.

**Affected.** `packages/payments`, `apps/web`

**Parallelization.** Independent after TICKET-301.

**References.** PRD §9.1, §9.3; Settled by: Q33

---

### TICKET-304 — RailStateSource and polling reconciler

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-301

**Objective.** Make the rail authoritative, without depending on inbound network.

**Scope.** `RailStateSource` interface — **Seam 3.** Polling implementation. One-directional reconciliation: rail state overwrites local belief, always. Webhooks are **not** on the critical path.

**Acceptance criteria.**
- The interface has exactly one implementation in the MVP, and the seam is obvious.
- Reconciliation never writes back to the rail.
- A test can force captured, failed, and divergent outcomes deterministically.

**Tests required.** Rail-reported failure overwrites a local belief of success. Polling converges.

**Affected.** `packages/payments`

**Parallelization.** Blocks TICKET-305.

**References.** PRD §12; Settled by: Q15

---

### TICKET-305 — Divergence and failure handling

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-304, TICKET-108

**Objective.** Record the disagreement before resolving it, and unwind the hold.

**Scope.** `RAIL_STATE_DIVERGENCE` written **before** the correction is applied. Hold released. Session moves to `PAYMENT_FAILED`.

**Acceptance criteria.**
- The divergence event precedes the corrective event in the ledger.
- Hold is released exactly once.
- The disagreement is reconstructable from the ledger alone.

**Tests required.** Ledger ordering test. Hold released exactly once on divergence.

**Affected.** `packages/payments`, `packages/policy`

**Parallelization.** Independent after TICKET-304.

**References.** PRD §12, §17 row 7; Settled by: Q8, Q15

---

### TICKET-306 — Autonomous-payment gate

**Status:** TODO · **Priority:** P0 · **Dependencies:** TICKET-303

**Objective.** Make the flag a real enforced boundary with a visible extension seam.

**Scope.** The terminal action after acceptance checks `autonomous_payment_execution`. `false` → order creation path only. `true` → **exists in code and fails closed** with `NOT_IMPLEMENTED`, emitting `AUTONOMOUS_PAYMENT_NOT_AUTHORIZED`. It must not silently no-op.

**Acceptance criteria.**
- The `true` branch exists and throws — verified by a test that flips the flag.
- The refusal is audited with its reason code.
- With `false`, no other terminal path is reachable.

**Tests required.** Flag flipped to `true` produces a thrown error and an audit event, never a silent success and never an actual charge.

**Affected.** `packages/payments`, `packages/policy`

**Parallelization.** Independent after TICKET-303.

**References.** PRD §9.2, §9.3; Settled by: Q33

---

# Phase 4 — Audit

---

### TICKET-401 — Append-only ledger writer with hash chaining

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-005

**Objective.** One append path, hash-linked, no mutation.

**Scope.** Append function computing `prev_hash` and `event_hash`. No update or delete exported. Chain verification helper.

**Acceptance criteria.**
- Events form a verifiable chain from genesis.
- No update or delete function is exported from the ledger module.
- Tampering with any stored event breaks verification.

**Tests required.** Chain verifies over a full negotiation. A mutated event fails verification.

**Affected.** `packages/policy`, `packages/database`

**Parallelization.** Blocks TICKET-402, TICKET-404.

**References.** PRD §13; Settled by: Q13

---

### TICKET-402 — Reason code enforcement at every transition

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-401, TICKET-002

**Objective.** Guarantee every state transition writes exactly one code.

**Scope.** Wire the state machine from PRD §15 to the ledger so a transition cannot occur without an event. Exhaustiveness check over the transition table.

**Acceptance criteria.**
- Every transition in PRD §15 produces exactly one event with exactly one code.
- A transition path with no code fails to compile or fails a test.
- The model cannot supply a code anywhere.

**Tests required.** Exhaustive walk of the transition table. Every one of the 28 codes is reachable by some path (except `FLOOR_BREACH`, which is reachable only via the defensive assertion).

**Affected.** `packages/policy`

**Parallelization.** Independent after TICKET-401.

**References.** PRD §14, §15; Settled by: Q30, Q34

---

### TICKET-403 — Campaign hold events in the ledger

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-108, TICKET-401

**Objective.** Make hold movement visible in the audit stream.

**Scope.** `HOLD_RESERVED`, `HOLD_RELEASED`, `HOLD_COMMITTED` written with hold id and amount, so budget movement is reconstructable.

**Acceptance criteria.**
- Every hold transition appears in the ledger with its amount.
- Summing ledger hold events reproduces `available`.

**Tests required.** Ledger-derived budget equals stored budget after a full lifecycle.

**Affected.** `packages/policy`

**Parallelization.** Independent.

**References.** PRD §6.5, §13.1; Settled by: Q13, Q22

---

### TICKET-404 — Ledger read API and chain verification endpoint

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-401

**Objective.** Let the console and a judge read and verify the chain.

**Scope.** Read procedures for a session's events; a verification procedure returning chain validity. Response includes reason code, structured payload, and the non-authoritative explanation clearly labelled.

**Acceptance criteria.**
- A completed negotiation is fully reconstructable from this API alone.
- The explanation column is labelled non-authoritative in the response shape.

**Tests required.** Full reconstruction of the worked-example run from ledger reads only.

**Affected.** `packages/trpc`, `apps/api`

**Parallelization.** Blocks TICKET-505.

**References.** PRD §13; Settled by: Q13

---

# Phase 5 — Merchant UI / Demo

---

### TICKET-501 — Merchant policy configuration and approval

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-003, TICKET-006

**Objective.** The screen where the merchant delegates authority.

**Scope.** Floors, campaign budget, per-deal cap, negotiable SKUs, slow-moving flags, commitment values, kill switch. Three **pre-computed** proposed bounds the merchant edits and approves — generation is out of scope, the approval moment is the point. Displays the 3% slow-moving rule as a stated rule.

**Acceptance criteria.**
- Merchant can edit and approve; approval increments `policy_version`.
- The kill switch is writable at any time, including mid-negotiation (RA-1); every other field is pinned at session open.
- The 3% rule is visible and described in plain language.
- The kill switch is reachable in one click.

**Tests required.** Approval writes a new policy version.

**Affected.** `apps/web`, `packages/trpc`

**Parallelization.** Independent.

**References.** PRD §5, §6.6, §19; Settled by: Q7, Q27, Q29

---

### TICKET-502 — Live negotiation event stream

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-404

**Objective.** Let the merchant watch without approving.

**Scope.** Polling-based stream of ledger events for active sessions. **Do not build SSE.**

**Acceptance criteria.**
- Events appear within a couple of seconds.
- Reason codes are shown, not hidden behind prose.

**Tests required.** Component renders a full event sequence.

**Affected.** `apps/web`

**Parallelization.** Independent.

**References.** PRD §13; Settled by: Q13

---

### TICKET-503 — Campaign budget countdown

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-107

**Objective.** The visible number that makes "bounded" concrete.

**Scope.** Total, reserved, committed, available. Updates as holds move.

**Acceptance criteria.**
- Reserved and available update visibly when a Tier 2 offer is minted and again when it expires.

**Tests required.** Display matches engine state across a hold lifecycle.

**Affected.** `apps/web`

**Parallelization.** Independent.

**References.** PRD §6.5; Settled by: Q10, Q22

---

### TICKET-504 — Offer status and TTL display

**Status:** TODO · **Priority:** P2 · **Dependencies:** TICKET-111

**Objective.** Show the offer perishing.

**Scope.** Status, remaining TTL, tier, campaign spend.

**Acceptance criteria.** TTL counts down and the offer visibly expires.

**Tests required.** Expiry reflected in the UI state.

**Affected.** `apps/web`

**Parallelization.** Independent. **Drop first if behind.**

**References.** PRD §10; Settled by: Q13

---

### TICKET-505 — Audit trail display

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-404

**Objective.** The screen a judge will look at.

**Scope.** Chronological events with reason code, structured payload, and the model explanation shown as clearly non-authoritative. Chain verification indicator. Candidate counts surfaced (`evaluated / feasible / tier-1`).

**Acceptance criteria.**
- Every event shows its reason code prominently.
- The explanation is visually distinguished from the justification.
- Chain validity is displayed.

**Tests required.** Renders the full worked-example run.

**Affected.** `apps/web`

**Parallelization.** Independent after TICKET-404.

**References.** PRD §13.2, §8; Settled by: Q13, Q28

---

### TICKET-506 — Minimal buyer surface

**Status:** TODO · **Priority:** P1 · **Dependencies:** TICKET-204, TICKET-303

**Objective.** A functional, obviously agent-oriented buyer view — **minimal by design, not unfinished.**

**Scope.** Transcript, current offer, accept/decline, payment authorization handoff. No storefront.

**Acceptance criteria.**
- A human can complete the payment authorization step from here.
- It reads as an agent console, not a half-built shop.

**Tests required.** Accept-to-handle flow works end to end.

**Affected.** `apps/web`

**Parallelization.** Independent.

**References.** PRD §19; Settled by: Q17

---

### TICKET-507 — Seed data and demo fixtures

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-003, TICKET-004

**Objective.** One catalogue that tests and the demo both use.

**Scope.** ~20 D2C skincare SKUs, 3 flagged slow-moving, including the three from PRD §18.2 with their exact list and floor prices. Campaign budget ₹50,000, per-deal cap ₹200. Reference cart fixture.

**Acceptance criteria.**
- The worked example reproduces exactly: ₹950 / ₹3,020 / ₹2,300 / walk-away at ₹2,200.
- Seed is idempotent.

**Tests required.** The three worked-example figures assert against seeded data.

**Affected.** `packages/database`

**Parallelization.** **Do early** — Phase 1 tests depend on it.

**References.** PRD §18.2; Settled by: Q16

---

### TICKET-508 — Walk-away policy-change card

**Status:** TODO · **Priority:** P2 · **Dependencies:** TICKET-404

**Objective.** The feedback narrative without building the feedback loop.

**Scope.** A single card computed from the run's real walk-away data: how many deals were refused and what cap would have closed them. **Not a scheduled job, not analytics.**

**Acceptance criteria.**
- The card's numbers are computed from actual ledger events, never hardcoded.

**Tests required.** Card figures match ledger contents.

**Affected.** `apps/web`, `packages/trpc`

**Parallelization.** Independent. **Drop if behind.**

**References.** PRD §19; Settled by: Q7, Q27

---

# Phase 6 — Testing / Hardening

**Invariant tests are P0 and are not optional.** They are the product claim. If a UI ticket and an invariant test compete for the last hour, the test wins.

Good tests here assert **external behaviour**, never internal structure. "A Tier 2 offer cannot be minted before a Tier 1 refusal is logged" is a good test. "The tiering function was called with these arguments" is not — it describes today's implementation and will be deleted within a day.

---

### TICKET-601 — Invariant suite: economics

**Status:** TODO · **Priority:** P0 · **Dependencies:** Phase 1

**Scope and required assertions.**
- An offer can never violate a SKU floor (property test over randomized catalogues).
- Campaign spend cannot exceed the per-deal cap.
- Campaign spend cannot exceed remaining campaign budget.
- Holds are reserved, released, and committed correctly across all terminal paths.
- Tier 2 cannot unlock before a Tier 1 refusal.
- The 3% slow-moving band changes selection at 2% and not at 4%.
- Candidate generation is deterministic across 100 runs.

**Affected.** `packages/policy`

**References.** PRD §6, §7.1, §8, §21; Settled by: Q19, Q21, Q22, Q29

---

### TICKET-602 — Invariant suite: offer lifecycle and idempotency

**Status:** TODO · **Priority:** P0 · **Dependencies:** Phase 1, TICKET-302

**Scope and required assertions.**
- One offer cannot create multiple orders, including under concurrency.
- An expired offer cannot be consumed.
- A consumed offer cannot be consumed again.
- A basket altered between mint and accept is refused.

**Affected.** `packages/policy`, `packages/payments`

**References.** PRD §10.2, §11, §21; Settled by: Q13

---

### TICKET-603 — Invariant suite: injection resistance and eligibility

**Status:** TODO · **Priority:** P0 · **Dependencies:** Phase 2

**Scope and required assertions.**
- The LLM cannot directly set a monetary amount — type-level assertion that the intent has no numeric field.
- The concession curve is byte-identical across radically different buyer messages, including the budget-inflation attack.
- Prompt injection cannot modify policy — no policy write path is reachable from the agent package.
- A buyer cannot self-declare eligibility — eligibility signature accepts no conversation input.

**Affected.** `packages/policy`, `packages/agent`

**References.** PRD §17, §21; Settled by: Q6, Q24, Q31

---

### TICKET-604 — Invariant suite: payment and rail authority

**Status:** TODO · **Priority:** P0 · **Dependencies:** Phase 3, Phase 4

**Scope and required assertions.**
- Razorpay state is authoritative — a rail-reported failure overwrites a local belief of success.
- Payment divergence is handled safely: divergence event precedes correction, hold released once.
- Autonomous payment cannot occur when disabled — the `true` branch throws and audits.
- Audit events are produced correctly for every transition, and the chain verifies.

**Affected.** `packages/payments`, `packages/policy`

**References.** PRD §9, §12, §13, §21; Settled by: Q15, Q33

---

### TICKET-605 — Static boundary checks

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-006

**Objective.** Enforce two claims statically, because that is stronger than testing them.

**Scope.**
- `packages/policy` declares no model SDK dependency — lint rule fails the build otherwise.
- No order-creation function accepts an amount parameter.
- `packages/agent` cannot import the payment layer or policy write paths.

**Acceptance criteria.** Each rule fires on a deliberately introduced violation, in CI.

**Affected.** eslint config, CI

**References.** PRD §4 boundary rules; Settled by: Q6, Q26

---

## Critical path

```
Phase 0 (serial, 4h)
  └─> TICKET-507 seed  ─┐
  └─> TICKET-102 contribution ─> TICKET-103 generator ─> TICKET-104 tiering ─┐
  └─> TICKET-107 budget ─> TICKET-108 holds ────────────────────────────────┤
                                                                             ├─> TICKET-110 mint ─> TICKET-111 offer rules
  └─> TICKET-201 model abstraction ──────────────────────────────────────────┘        │
                                                                                      ├─> TICKET-202 agent ─> TICKET-204 protocol ─> TICKET-205 MCP ─> TICKET-206 buyer
                                                                                      └─> TICKET-301 order ─> TICKET-302 uniqueness
                                                                                                          └─> TICKET-304 rail ─> TICKET-305 divergence
TICKET-401 ledger ─> TICKET-402 codes ─> TICKET-404 read API ─> TICKET-505 audit UI
```

**Longest chain:** Phase 0 → 102 → 103 → 104 → 110 → 202 → 204 → 205 → 206 ≈ 14 hours serial. Everything else must fit around it. **TICKET-507 and TICKET-401 should start immediately after Phase 0** so that Phase 1 tests and Phase 4 wiring are never blocked.

## Suggested parallel streams

| Stream | Tickets |
| --- | --- |
| **A — Engine** (strongest agent) | 102, 103, 104, 105, 106, 109, 110, 111 |
| **B — Money** | 107, 108, 301, 302, 303, 304, 305, 306 |
| **C — Agent & protocol** | 201, 202, 203, 204, 205, 206 |
| **D — Ledger & UI** | 401, 402, 403, 404, 501, 502, 503, 505, 506 |
| **Lead** | Phase 0, 507, 605, all review and merge, hand-review of `packages/policy` |

Phase 6 invariant suites are written by whichever stream owns the code under test, not by a separate stream.

## Settled ambiguities baked into tickets

All five are resolved (PRD §16). No ticket is blocked.

| Ticket | Decision | Behaviour |
| --- | --- | --- |
| TICKET-105 | RA-4 | Curve only; no separate concession ceiling |
| TICKET-202 | RA-2 | One refusal of the best Tier 1 candidate unlocks Tier 2 |
| TICKET-101 | RA-3 | Eligibility at open, re-checked once before a Tier 2 mint |
| TICKET-501 | RA-1 | Kill switch exempt from the policy freeze |
| TICKET-005 | RA-5 | Short final rationale only; no reasoning traces |


| Ticket | Blocked on | Interim behaviour |
| --- | --- | --- |
| TICKET-105 | **OQ-4** — separate concession ceiling vs curve only | Curve only |
| TICKET-202 | **OQ-2** — one Tier 1 refusal vs all | One refusal of the best Tier 1 candidate |
| TICKET-101 | **OQ-3** — eligibility re-check mid-negotiation | Check at open, re-check once before Tier 2 mint |
| TICKET-501 | **OQ-1** — kill switch exempt from policy freeze | Kill switch exempt |
| TICKET-005 | **OQ-5** — explanation storage scope | Store short final rationale only, no reasoning traces |
