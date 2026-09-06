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

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-102, TICKET-104

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

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-110, TICKET-201

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

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-110, TICKET-201

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

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-006, TICKET-202

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

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-204

**Objective.** Expose the same procedures as MCP tools so a third-party agent can negotiate without bespoke integration.

**Scope.** Thin adapter over the existing procedures. Public endpoint. The Scalar documentation URL is part of the submission.

**Acceptance criteria.**
- A stock model connected to the endpoint can complete a negotiation end to end. ✅ `packages/trpc/server/mcp/` re-exposes the five buyer-facing `negotiationRouter` procedures (`get_session_context`, `open_negotiation`, `propose`, `respond_to_offer`, `accept_offer`) as MCP tools, each a 1:1 pass-through via `serverRouter.createCaller` using that procedure's own `negotiationInputSchemas` member — no logic, no state, no re-declared schema. `packages/trpc/tests/mcp-negotiation.test.ts` drives `open → propose → decline → propose → accept` to a payment handle both through an in-memory `Client`↔`McpServer` pair and through the real `POST /mcp` HTTP endpoint (SDK `StreamableHTTPClientTransport` against a Node server wrapping `createMcpHttpHandler`), all against real Postgres.
- Tool descriptions leak no policy internals. ✅ Only the negotiation surface is exposed — no merchant-console or audit tool. The suite asserts the full serialized tool list (names, titles, descriptions, input schemas) contains no `floor` / `budget` / `per-deal` / `concession` / `curve` / `tier` substring; the procedures themselves already guarantee no such value is in a response (`response-shape.test.ts`). Error text is filtered too: only a `TRPCError` message reaches the buyer (same as tRPC's own HTTP surface); any other fault is collapsed to a generic string.

**Tests required.** End-to-end negotiation driven through the MCP surface. ✅ `packages/trpc/tests/mcp-negotiation.test.ts` (5 tests, in-memory + real HTTP transport, real Postgres, `@repo/payments` mocked for the Razorpay HTTP call via a shared `tests/support/negotiation-fixtures.ts` helper).

**Implementation notes (2026-09-06).**
- Endpoint: `POST /mcp` on `apps/api`, stateless Streamable HTTP (`sessionIdGenerator: undefined`) — a negotiation's entire state already lives in Postgres keyed by `sessionId`/`negotiationId`, so there is nothing to keep in MCP session memory, and a stateless endpoint survives a restart / second replica. `GET`/`DELETE /mcp` return 405.
- New dependency: `@modelcontextprotocol/sdk` (`packages/trpc` only — `apps/api` reaches it transitively through `@repo/trpc/server/mcp`, and `http.ts` deliberately takes no logger/HTTP-framework dependency, exposing an `onError` hook the host wires to its own logger). `packages/trpc` is the transport layer with no boundary lint rules, so this import is allowed there (the `@modelcontextprotocol/*` ban in `packages/eslint-config/boundaries.js` applies to `packages/policy`/`packages/payments` only).
- `route.ts` change: the five inline `.input(z.object({…}))` schemas are hoisted to a named, exported `negotiationInputSchemas` and passed to `.input()` unchanged, so the MCP adapter reuses the exact shapes. Not a frozen-contract change — the shapes are identical, still the narrow buyer-facing surface §9 governs; adding an export is permitted by CONTRACTS.md §1. No behaviour changed; all 44 `@repo/trpc` tests pass.
- No frozen contract changed. No issues found.

**Affected.** `apps/api`, `packages/trpc`

**Parallelization.** Independent after TICKET-204.

**References.** PRD §18; Settled by: Q18

---

### TICKET-206 — Buyer agent harness

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-201, TICKET-205

**Objective.** An independent buyer agent with hidden constraints, for the demo and for tests.

**Scope.** Stock model. System prompt contains **only** a budget, a goal, and negotiating latitude — no script, no target outcome, no knowledge of floors, tiers, or budget. Reservation price hidden from the merchant agent. Configurable budget so two runs can produce different endings.

**Acceptance criteria.**
- The prompt is displayable on screen and visibly contains no script. ✅ `renderBuyerSystemPrompt` (`packages/agent/buyer/buyer-prompt.ts`) renders a fixed 13-line frame with three slots — `budgetMinor`, `goal`, `latitude` — and nothing else. `packages/agent/tests/buyer-prompt.test.ts` asserts it carries exactly those three values, says "no script" / "no required outcome", contains no `floor` / `tier` / `concession` / `curve` / `campaign` / `per-deal` / `counterfactual` / `candidate` substring, has no step-list or target-price phrasing, and that the only number in it is the budget itself. `pnpm --filter @repo/agent demo` prints it to screen above both runs.
- Two different budgets produce materially different outcomes — one closing, one walking away. ✅ `CLOSING_RUN` (budget ₹2,100) and `WALK_AWAY_RUN` (budget ₹1,600) in `packages/agent/demo/demo-runs.ts` share goal, latitude, seed and scenario — only `budgetMinor` differs. `packages/agent/tests/demo-negotiation.test.ts` asserts the first ends `CLOSED` on the round-2 campaign-funded Tier 2 offer (`settledOffer.tier === 2`, `campaignSpendMinor > 0`, total ≤ budget) and the second ends `WALKED_AWAY` after a Tier 2 offer was reached but the round-3 per-deal cap forced the merchant back to Tier 1 — PRD §18.2's "a different limit binds" ending.
- The merchant agent never receives the reservation price. ✅ Structural: `BuyerAgent.reactToOffer` is handed only `{ totalMinor, currency }` and returns `{ kind, message }` — no numeric field, and every message is drawn from a fixed pool with no digit in any phrase. Tests assert no buyer transcript turn in either documented run contains a digit or `String(budgetMinor)`.

**Tests required.** Two seeded runs produce the two documented outcomes. ✅ `packages/agent/tests/demo-negotiation.test.ts` (7 tests) drives both documented runs to their terminal state and also pins determinism (same config → identical transcript). Plus `buyer-agent.test.ts` (7) and `buyer-prompt.test.ts` (6). All 65 `@repo/agent` tests pass; `pnpm check-types` and `pnpm lint` green repo-wide; full `pnpm test` green.

**Implementation notes (2026-09-06).**
- New module `packages/agent/buyer/` — `BuyerConstraints` (budget + goal + latitude, nothing else), `renderBuyerSystemPrompt`, and `BuyerAgent`: a deterministic "stock model" stand-in (no model SDK exists in the lockfile and CI has no credentials; the "two seeded runs" criterion needs reproducibility). It accepts at/below its hidden budget, pushes back on an over-budget offer, and walks once its `patience` runs out — driven by a seeded PRNG that only ever picks *wording*, never a decision or an amount.
- New module `packages/agent/demo/` — a pure harness (`runDemoNegotiation`) pairing `BuyerAgent` against the real engine pipeline (`generateCandidates → assignTiersAndFeasibility → runNegotiationRound → mintOffer`) with in-memory campaign-hold accounting. No database, no HTTP, no model SDK — stays inside B2 (`mintOffer` is the only engine entry point). `DemoMerchantModel` offers the lowest-total exposed candidate each round (a merchant genuinely chasing a deal with a price-sensitive buyer), which is what makes a Tier 2 offer actually reachable end to end — the tRPC `DeterministicMerchantModel` never picks one (ISSUE-012 sub-issue 12e).
- `pnpm --filter @repo/agent demo` (`tsx demo/run-demo.ts`, new `tsx` devDep) prints the prompt and both transcripts.
- **ISSUE-017** raised: on §18.2's own cart the frozen concession curve's smallest step (0.4 × ₹950 headroom = ₹380) already exceeds §18.2's own ₹200 per-deal cap, so no Tier 2 candidate is *generable* on that cart under that cap — §18.2's round-2 "₹2,300, shortfall exactly ₹200" offer cannot be produced by `generateCandidates`. `NEEDS_SPEC_DECISION`. Worked around here (not blocked) with a demo fixture whose per-deal cap is ₹700, documented inline in `reference-scenario.ts`; `packages/database/seed.ts` still seeds ₹200 for the live surface. Partially advances ISSUE-012 sub-issue 12e for the pure-engine path; the DB `propose` path is untouched.
- No frozen contract changed.

**Affected.** `packages/agent`, demo harness

**Parallelization.** Independent after TICKET-205.

**References.** PRD §18.1; Settled by: Q3, Q32

---

# Phase 3 — Payments

---

### TICKET-301 — Razorpay test-mode order creation

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-110

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

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-111, TICKET-301

> **Confirmed gap (ISSUE-009, now FIXED):** CodeAnt independently flagged the
> missing reserve-before-POST on TICKET-301's `createOrder`. TICKET-301 was
> left as read-only by design; this ticket is where the race got fixed.

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

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-301

**Objective.** Return a handle the human buyer authorizes. Nothing more.

**Scope.** Order creation returns a payment handle to the buyer surface. The buyer authorizes in Razorpay test mode. No agent-initiated capture at any point.

**Acceptance criteria.**
- The only reachable path is `createOrder(offerId) → handle → buyer authorizes`. ✅ `acceptOffer` (TICKET-204, `packages/trpc/server/routes/negotiation/route.ts`) calls `createOrder(offer.id)` and returns `paymentHandle: { orderId, railOrderId, amountMinor, currency }` only — no capture-shaped field exists on the response (asserted directly, `negotiation-route.test.ts`'s happy-path test).
- No agent code path can trigger a charge. ✅ Structural, not just tested: `packages/agent`'s own eslint config (`agentBoundaries`, CONTRACTS.md B2) forbids importing `@repo/payments` at all — a reviewer can verify this in ten seconds, and a lint test already proves the rule fires on a deliberately-added forbidden import (TICKET-006).

**Tests required.** No capture path is reachable from the agent package. ✅ `packages/payments/tests/no-capture-call.test.ts` asserts zero capture/charge-shaped calls anywhere in the package; `packages/agent`'s boundary lint rule makes the package structurally unable to reach `packages/payments` in the first place.

**Note (2026-09-06):** the `apps/web` half of this ticket's original scope (a UI page where the buyer clicks through to authorize) was never built here — that UI surface is TICKET-506's ("Minimal buyer surface") job, which already lists TICKET-303 as a dependency. Closing this ticket on its own testable acceptance criteria (the API-level handle contract and the no-charge guarantee), not on a UI that belongs to a different ticket.

**Affected.** `packages/payments`, `apps/web`

**Parallelization.** Independent after TICKET-301.

**References.** PRD §9.1, §9.3; Settled by: Q33

---

### TICKET-304 — RailStateSource and polling reconciler

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-301

**Objective.** Make the rail authoritative, without depending on inbound network.

**Scope.** `RailStateSource` interface — **Seam 3.** Polling implementation. One-directional reconciliation: rail state overwrites local belief, always. Webhooks are **not** on the critical path.

**Acceptance criteria.**
- The interface has exactly one implementation in the MVP, and the seam is obvious. ✅ `RailStateSource` (`packages/payments/src/rail-state-source.ts`) has exactly one production implementation, `RazorpayRailStateSource` (`razorpay-rail-state-source.ts`), which polls Razorpay's `GET /orders/{id}/payments` — never a webhook.
- Reconciliation never writes back to the rail. ✅ `reconcile-order.ts`'s `reconcileOrder` only ever calls `railSource.getOrderState(...)` (a read) — `no-capture-call.test.ts` (which walks every source file in this package) covers this file too.
- A test can force captured, failed, and divergent outcomes deterministically. ✅ `reconcile-order.test.ts` scripts a fake `RailStateSource` per test to force each of `CAPTURED`/`FAILED`/a divergent (amount-mismatched) `CAPTURED` outcome against a real Postgres (CONTRACTS.md §8's sanctioned seam 3).

**Tests required.** Rail-reported failure overwrites a local belief of success. ✅ `reconcile-order.test.ts`'s FAILED test. Polling converges. ✅ `poll-pending-orders.test.ts` scripts an order across three poll cycles (`CREATED` → `AUTHORIZED` → `CAPTURED`) and asserts a fourth cycle no longer selects it at all.

**Note (2026-09-06):** deliberately does NOT release a Tier 2 hold on `FAILED`/`CONTRADICTS_LOCAL` — that's TICKET-305's job ("Divergence and failure handling"). Does commit a Tier 2 hold on `CAPTURED`, since that's the natural conclusion of success, not a TICKET-305 concern. The polling driver (`poll-pending-orders.ts`) isolates each order's failure so one bad order never blocks another order's reconciliation in the same cycle — see that file's own module doc for why that's the correct reading of "polling converges," not a weakening of it.

**Affected.** `packages/payments`

**Parallelization.** Blocks TICKET-305.

**References.** PRD §12; Settled by: Q15

---

### TICKET-305 — Divergence and failure handling

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-304, TICKET-108

**Objective.** Record the disagreement before resolving it, and unwind the hold.

**Scope.** `RAIL_STATE_DIVERGENCE` written **before** the correction is applied. Hold released. Session moves to `PAYMENT_FAILED`.

**Acceptance criteria.**
- The divergence event precedes the corrective event in the ledger. ✅ `reconcileOrder` (`packages/payments/src/reconcile-order.ts`) appends the `RAIL_STATE_DIVERGENCE` / `PAYMENT_FAILED` event, then overwrites local belief, then releases the Tier 2 hold — so the `HOLD_RELEASED` event is always a higher sequence than the divergence/failure event. `reconcile-order.test.ts` asserts the ledger index ordering for both a FAILED and a divergent report.
- Hold is released exactly once. ✅ Two guards: the terminal-`localState` short-circuit at the top of `reconcileOrder` stops a later poll cycle re-entering, and `releaseCampaignHold`'s conditional `WHERE state = 'RESERVED'` UPDATE appends no ledger event on an already-released hold. Tested by "releases a diverged Tier 2 hold exactly once, even across repeated reconciliation" and the already-released-hold no-op test.
- The disagreement is reconstructable from the ledger alone. ✅ The `RAIL_STATE_DIVERGENCE` event's payload carries `expectedAmountMinor` and `capturedAmountMinor` (set in TICKET-304); the `HOLD_RELEASED` event carries `holdId` / `amountMinor`. Asserted in `reconcile-order.test.ts`.

**Tests required.** Ledger ordering test. ✅ Hold released exactly once on divergence. ✅ Both in `packages/payments/tests/reconcile-order.test.ts`.

**Note (2026-09-06):** the frozen state machine models a rail report as a single moment with three readings — there is no separate "corrective" transition row from `AWAITING_PAYMENT`, so the `HOLD_RELEASED` self-loop on `PAYMENT_FAILED` IS the corrective event the ordering criterion refers to. FAILED and CONTRADICTS_LOCAL both release the hold via the same `PAYMENT_FAILED --HOLD_RELEASED--> PAYMENT_FAILED` transition (`resolveHoldReleaseTransition`). No frozen contract changed; `packages/policy` needed no edit — `resolveHoldReleaseTransition` already existed from TICKET-402.

**Affected.** `packages/payments`, `packages/policy`

**Parallelization.** Independent after TICKET-304.

**References.** PRD §12, §17 row 7; Settled by: Q8, Q15

---

### TICKET-306 — Autonomous-payment gate

**Status:** DONE · **Priority:** P0 · **Dependencies:** TICKET-303

**Objective.** Make the flag a real enforced boundary with a visible extension seam.

**Scope.** The terminal action after acceptance checks `autonomous_payment_execution`. `false` → order creation path only. `true` → **exists in code and fails closed** with `NOT_IMPLEMENTED`, emitting `AUTONOMOUS_PAYMENT_NOT_AUTHORIZED`. It must not silently no-op.

**Acceptance criteria.**
- The `true` branch exists and throws — verified by a test that flips the flag. ✅
- The refusal is audited with its reason code. ✅ — but only after fixing ISSUE-013 (`issue-tracker.md`): the audit write originally lived inside the same database transaction as the throw, so the throw rolled its own audit event back. Fixed by returning a `blocked` result from the transaction and throwing only after it commits.
- With `false`, no other terminal path is reachable. ✅ (unchanged, pre-existing behavior.)

**Tests required.** Flag flipped to `true` produces a thrown error and an audit event, never a silent success and never an actual charge. ✅ `negotiation-route.test.ts` — "acceptOffer fails closed with NOT_IMPLEMENTED when autonomousPaymentExecution is true..." — also asserts the offer stays unconsumed and the session stays in `OFFER_PENDING`, so a merchant who later disables the flag can still let the buyer accept the same offer (offers are single-use; consuming one on a doomed attempt would strand the buyer).

**Affected.** `packages/payments`, `packages/policy`, `packages/trpc`

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

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-404

**Objective.** Let the merchant watch without approving.

**Scope.** Polling-based stream of ledger events for active sessions. **Do not build SSE.**

**Acceptance criteria.**
- Events appear within a couple of seconds. ✅ `apps/web/app/merchant/sessions/[sessionId]` polls `audit.getSessionLedger` on a 2s `refetchInterval` (react-query, `refetchIntervalInBackground: false`). No SSE.
- Reason codes are shown, not hidden behind prose. ✅ Every row leads with the raw `reasonCode` in a monospace badge; `modelExplanation` is rendered separately and labelled "non-authoritative" (PRD §13.2). The state transition, event type, flattened payload (candidate counts, contribution/shortfall as rupees), campaign spend, offer id and policy version sit under it.

**Tests required.** Component renders a full event sequence. ✅ `apps/web/tests/event-stream.test.tsx` renders `EventStreamView` with the full PRD §18.2 worked-example sequence (the 8 events TICKET-404's route test reconstructs) and asserts every reason code appears in ledger order, the model explanation is flagged non-authoritative, campaign spend shows on hold-moving events, plus empty/loading/error states — and unit-tests the pure `toEventStreamRows` shaping (ordering, rupee formatting, genesis transition, tone classification).

**Affected.** `apps/web`

**Parallelization.** Independent.

**Implementation notes (2026-09-06).**
- No frozen contract touched. Pure client of the existing `auditRouter` (TICKET-404); no new procedure, no output-schema change.
- Split for testability: `apps/web/lib/event-stream.ts` holds all shaping (`toEventStreamRows`, payload flattening, `isStreamSettled`); `MerchantEventStream` (polling container) is separated from the props-only `EventStreamView`. Money stays in minor units through the shaping layer — `EventRow` calls `formatRupees` at the JSX boundary (CONTRACTS §3), matching the buyer console.
- `apps/web` now depends on `@repo/policy` (the pure, zero-dep contracts package). `reasonTone`'s map is keyed by the frozen `ReasonCode` enum so a renamed/added code is a compile error, not a silent grey badge; the terminal-state check reads the frozen `TERMINAL_STATES`. No runtime enum is bundled — `ReasonCode` is a type-only import.
- Polling stops once the last event is terminal (`isStreamSettled`) — a finished negotiation is not an "active session".
- First component-test runner in `apps/web` (`vitest` + `jsdom` + `@testing-library/react`). TICKET-506 had read CONTRACTS §8 as barring this — see **ISSUE-018** for why a props-only jsdom render is not one of §8's three backend seams.
- Watch-only by construction: the screen has no control. The merchant's only lever mid-negotiation stays the kill switch on the policy page (RA-1).
- Two-axis `/code-review` (standards + spec) run against `main` before merge; the money-boundary, enum-drift and infinite-poll findings above are the fixes it produced. The route is reachable by URL only (no session-list nav) — noted, out of this ticket's scope.

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

**Status:** DONE · **Priority:** P1 · **Dependencies:** TICKET-204, TICKET-303

**Objective.** A functional, obviously agent-oriented buyer view — **minimal by design, not unfinished.**

**Scope.** Transcript, current offer, accept/decline, payment authorization handoff. No storefront.

**Acceptance criteria.**
- A human can complete the payment authorization step from here. ✅ `apps/web/app/buyer/[sessionId]` drives the public `negotiation.*` surface: `getSessionContext` renders the cart, `openNegotiation` → a message composer → `propose` returns an offer, `acceptOffer` returns the payment handle, and the accepted state hands off to Razorpay's own hosted checkout (`checkout.razorpay.com`, keyed by `NEXT_PUBLIC_RAZORPAY_KEY_ID`) with the handle's `railOrderId`/`amountMinor` — the buyer authorizes there, the app never charges. When the key is absent the handle (order id + amount + currency) is still shown in full.
- It reads as an agent console, not a half-built shop. ✅ No storefront, no cart editing, no browsing — a cart summary, a role-labelled transcript with the raw `reasonCode` on every turn, an offer card, and the handoff. Amounts formatted to rupees only at the render boundary (`apps/web/lib/money.ts`).

**Tests required.** Accept-to-handle flow works end to end. ✅ `packages/trpc/tests/buyer-surface.test.ts` (3 tests) drives the exact call sequence the screen drives — `getSessionContext → openNegotiation → propose → decline → propose → acceptOffer` — against a real Postgres (CONTRACTS.md §8 primary seam; `apps/web` has no runner and §8 bars a fourth seam), asserting each response carries what that step renders and that the handle is never capture-shaped, plus the unflagged-checkout refusal path.

**Affected.** `apps/web` (+ `packages/trpc/tests/` for the required test, per the TICKET-501 precedent — no `packages/trpc` source changed)

**Parallelization.** Independent.

**Implementation notes (2026-09-06).**
- No frozen contract touched. The buyer surface is a pure client of the existing `negotiationRouter`; no new procedure, no output-schema change.
- `apps/web/next.config.js`: set `agentRules: false` — Next 16's `next dev` otherwise writes `AGENTS.md`/`CLAUDE.md` into `apps/web` on every run; this repo's agent instructions are the root `CLAUDE.md`.
- `apps/web/env.js`: added optional client var `NEXT_PUBLIC_RAZORPAY_KEY_ID` (publishable `rzp_test_…` key). Optional by design — its absence only disables the in-page checkout, not the handoff information.
- Local dev needs `NEXT_PUBLIC_API_URL` pointing at the API origin (same requirement as the TICKET-501 merchant page; see ISSUE-006).

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

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 1

**Scope and required assertions.** All in `packages/policy/tests/invariants-economics.test.ts` (20 tests), which drives the whole engine pipeline — `generateCandidates → assignTiersAndFeasibility → selectCandidate → mintOffer` — over randomized catalogues/baskets/rounds/budgets and asserts each invariant as an emergent property of the composition, not just of one stage.
- An offer can never violate a SKU floor (property test over randomized catalogues). ✅ 200 randomized trials: every generated candidate line and every minted offer line stays ≥ its SKU floor, cross-checked against `assertNoFloorBreach`; a separate sweep asserts non-negotiable SKUs are never discounted.
- Campaign spend cannot exceed the per-deal cap. ✅ 200-trial sweep over every feasible Tier 2 candidate + a forced Tier-2-only selection that mints and asserts `campaignSpendMinor ≤ perDealCapMinor` + a 1-minor-unit-over-cap boundary case.
- Campaign spend cannot exceed remaining campaign budget. ✅ same tests, `≤ availableCampaignBudgetMinor`; plus "spend == exact shortfall, no rounding, no buffer" over 120 trials.
- Holds are reserved, released, and committed correctly across all terminal paths. ✅ asserted through the transition resolvers + frozen `TRANSITIONS`: reserve→`HOLD_RESERVED` (Tier 2 only), commit→`HOLD_COMMITTED` on `SETTLED` (Tier 2 only), every unwind path→`HOLD_RELEASED`, tier-1 resolvers throw. Found ISSUE-015 (no `HOLD_RELEASED` row for the `BUYER_ENDS_SESSION → DECLINED` path — TTL self-heal only); suite asserts today's frozen reading.
- Tier 2 cannot unlock before a Tier 1 refusal. ✅ 200-trial sweep with `tier1Refused: false`: zero Tier 2 in `selectableCandidates`, selected + minted offer always Tier 1; a flip test; and `mintOffer` throws on a Tier 2 id while `tier1Refused` is false.
- The 3% slow-moving band changes selection at 2% and not at 4%. ✅ 2%/3%/4%-behind cases through `selectCandidate`.
- Candidate generation is deterministic across 100 runs. ✅ `generateCandidates` byte-identical ×100, deterministic pipeline stages byte-identical ×100, and selection independent of input array order (10 scenarios × 8 shuffles).

**Note (2026-09-06):** the single-shot pipeline essentially never *selects* a Tier 2 candidate — a Tier 1 candidate (INCREASE_QUANTITY or a COMMITMENT_SWAP) is almost always present and always outranks a dilutive Tier 2 one (ISSUE-012 sub-issue 12e). Invariants 2/3 for the *selected/minted* Tier 2 case are covered by a deliberately Tier-2-only forced scenario instead. Hold-lifecycle concurrency safety (release-exactly-once under races) is `packages/database`/`packages/payments`' share (TICKET-108, TICKET-305, TICKET-602/604), not this pure suite's.

**Affected.** `packages/policy`

**References.** PRD §6, §7.1, §8, §21; Settled by: Q19, Q21, Q22, Q29

---

### TICKET-602 — Invariant suite: offer lifecycle and idempotency

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 1, TICKET-302

**Scope and required assertions.**
- One offer cannot create multiple orders, including under concurrency. ✅
  `packages/payments/tests/invariants-offer-lifecycle.test.ts`: N concurrent
  `reserveOrder` for one offer (2/5/20) against real Postgres leave exactly
  one committed `orders` row — every loser a clean `ORDER_ALREADY_EXISTS`
  domain result, never a thrown Postgres error — plus sequential-retry and
  per-offer-not-global-lock cases, and a raw duplicate `INSERT` proving the
  guarantee is our own unique constraint (`23505`), not a rail-supplied key.
- An expired offer cannot be consumed. ✅ Policy suite: 300 randomized
  post-expiry trials + inclusive boundary. Payments suite: past-TTL refusal
  leaves `consumed_at` null + the transactional CAS boundary (accepted at
  `expiresAt`, refused one ms later).
- A consumed offer cannot be consumed again. ✅ Payments suite:
  `it.each([2,10,25])` concurrent `acceptOffer`, each its own transaction —
  a real compare-and-set race — leaves exactly one consumption; losers all
  `OFFER_ALREADY_CONSUMED`. Policy suite: 300 randomized trials + a
  mint→accept→replay sequence.
- A basket altered between mint and accept is refused. ✅ Policy suite: 9
  single-field mutators × 40 randomized minted baskets, plus 200
  identical-reconstruction accepts and commitment-order-insensitivity.
  Payments suite: 5 mutation cases refused transactionally with the offer
  left live for a correct accept afterwards.

Additive test-only coverage beyond the four: the refusal precedence
(expiry → consumed → basket), currency mismatch, and a structural check that
the `acceptance` barrel stays a pure decision rule with no mutation path
(two callers handed the same unconsumed snapshot both "succeed" — which is
*why* the exactly-once guarantee has to be the database's).

**Note (2026-09-06):** `createOrder` (`packages/payments/src/create-order.ts`)
is **not** exercised end-to-end against the test database here — its
`offer-repository.ts` / `order-repository.ts` bind to the singleton `db`
(ISSUE-012 sub-issue 12b), a different physical database from the sibling the
shared harness uses. The payments-side suite drives the `@repo/database`
repositories `createOrder` delegates to (`reserveOrder`, `acceptOffer`)
directly against real Postgres instead — same repositories, no untestable
singleton in the way, same workaround TICKET-304/305 used. `createOrder`'s
own wrapper composition (reserve strictly before the Razorpay POST) stays
covered by `create-order.test.ts`. `reserveOrder` has no offer-expiry or
consumed guard by design — the accept step upstream is where a dead offer is
stopped, before order creation is ever reached. No production code changed.

**Affected.** `packages/policy`, `packages/payments`

**References.** PRD §10.2, §11, §21; Settled by: Q13

---

### TICKET-603 — Invariant suite: injection resistance and eligibility

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 2

**Scope and required assertions.** Split across the two `Affected` packages,
same shape as TICKET-601/602/604: a pure `packages/policy` suite
(`tests/invariants-injection-eligibility.test.ts`, 23 tests — the whole
`generateCandidates → assignTiersAndFeasibility → selectCandidate → mintOffer`
pipeline over a fixed §18.2 scenario, no DB) and a behavioural `packages/agent`
suite (`tests/invariants-injection-eligibility.test.ts`, 16 tests — the only
package that reads buyer text, so the injection payloads land here through
`runNegotiationRound` / `runDemoNegotiation` with a `ScriptedNegotiationModel`,
CONTRACTS.md §8 Seam 2). Both suites run a shared attack corpus (PRD §17
scenario 2's budget inflation plus the crude jailbreaks §17.1 says "prove
nothing").
- The LLM cannot directly set a monetary amount — type-level assertion that the
  intent has no numeric field. ✅ Policy + agent suites: `NumericKeys<NegotiationIntent>`
  resolves to `never` (agent suite's is CI-enforced — its tsconfig has no
  restrictive `include`, ISSUE-016; policy suite's is hand-checked with a
  direct `tsc --noEmit`), the intent's keys are exactly
  `candidateId`/`messageFrame`/`terminalAction`, `negotiationIntentSchema`
  (strict) rejects every numeric field name an attacker might try, and a
  minted offer's `totalMinor`/`campaignSpendMinor` is read off the engine
  candidate even when the model's intent object carries a smuggled
  `discountMinor`.
- The concession curve is byte-identical across radically different buyer
  messages, including the budget-inflation attack. ✅ Policy suite: the whole
  pipeline's serialized output (offer id + signature stripped as randomized-by-
  design) is identical across the corpus × rounds 1–3 × `tier1Refused`
  both ways, because no parameter can carry a message; `resolveConcessionFraction`
  and `generateCandidates` stay identical even when a message is smuggled past
  the type system via an `unknown[]` cast; and pretending the attack *succeeded*
  (a 10-lakh `availableCampaignBudgetMinor`) leaves every candidate basket and
  `totalMinor` unchanged — only feasibility flags move, and a Tier 2 shortfall
  over the ₹700 cap stays `DILUTION_EXCEEDS_PER_DEAL_CAP`-infeasible. Agent
  suite: the minted offer is identical whether the transcript is empty or the
  injection corpus, and a budget-inflation claim never unlocks Tier 2 (only a
  real Tier 1 refusal flips `tier1Refused`).
- Prompt injection cannot modify policy — no policy write path is reachable
  from the agent package. ✅ Agent suite: a source scan asserts no file imports
  `@repo/database` or `@repo/payments` and the only `@repo/*` dependency
  anywhere is `@repo/policy` (the lint boundary made a runtime fact);
  `RunNegotiationRoundInput` takes a `policyVersion` number, never a
  `MerchantPolicy` object; and a full `runDemoNegotiation` leaves the
  reference policy byte-identical, including when it is `Object.freeze`d.
  Policy suite: `generateCandidates` never mutates the policy it is handed and
  runs clean against a deep-frozen one; `mintOffer`'s input has no policy
  object.
- A buyer cannot self-declare eligibility — eligibility signature accepts no
  conversation input. ✅ Policy suite: `EligibilityInput`'s keys are exactly
  `session`/`policy`/`skuCatalogue` and the session slice carries only
  `originalBasket` + the merchant-set `isFlaggedAtRisk`; `checkEligibility` is
  unary; a smuggled `buyerClaimsAbandoning`/`conversation`/`message` never
  flips `NOT_AT_RISK`, a smuggled "I am not eligible" never flips
  `NEGOTIATION_OPENED`, and only the three merchant-controlled inputs move the
  answer. Agent suite: the rendered buyer prompt contains no
  eligibility/floor/budget-state/tier vocabulary, the buyer agent emits only
  `{ kind, message }`, and the round input this package hands the engine has
  no eligibility field.

No new `issue-tracker.md` entry — all four invariants already held
structurally; this ticket only adds the suite that asserts them (ISSUE-016's
policy-tests type-checking gap already tracked, and applies here).

**Affected.** `packages/policy`, `packages/agent`

**References.** PRD §17, §21; Settled by: Q6, Q24, Q31

---

### TICKET-604 — Invariant suite: payment and rail authority

**Status:** DONE · **Priority:** P0 · **Dependencies:** Phase 3, Phase 4

**Scope and required assertions.** Split across the two `Affected` packages,
same shape as TICKET-601/602: a pure `packages/policy` suite
(`tests/invariants-payment-rail.test.ts`, 20 tests — resolvers + hash chain,
no DB) and a real-Postgres `packages/payments` suite
(`tests/invariants-payment-rail.test.ts`, 14 tests — `reconcileOrder` /
`pollPendingOrders` against `getTestDb()` with a scripted `RailStateSource`,
CONTRACTS.md §8 Seam 3).

- Razorpay state is authoritative — a rail-reported failure overwrites a local
  belief of success. ✅ Payments suite: an order the rail first reported
  `AUTHORIZED` (optimistic local belief), then `FAILED`, lands the session on
  `PAYMENT_FAILED` with `PAYMENT_FAILED` (never `PAYMENT_CAPTURED`) in the
  ledger; a `localState` × rail-report sweep asserts the session always becomes
  the rail's reading, both directions. Policy suite: `resolveRailReportTransition`
  takes only the rail outcome — there is no parameter a local belief could
  arrive through — and `SETTLED`/`PAYMENT_FAILED` have no outbound transition.
- Payment divergence is handled safely: divergence event precedes correction,
  hold released once. ✅ Payments suite: a captured-amount mismatch writes
  `RAIL_STATE_DIVERGENCE` before `HOLD_RELEASED` (ledger sequence), carries both
  amounts on the divergence event, releases the Tier 2 hold exactly once across
  repeated reconciliation and when the hold was already released out-of-band,
  and one diverging order does not block a healthy order in the same poll batch.
  Policy suite: the same ordering over a hash-linked timeline built from the
  resolvers.
- Autonomous payment cannot occur when disabled — the `true` branch fails
  closed and audits. ✅ Asserted purely in the policy suite:
  `resolvePaymentInitiationTransition(true)` is a self-loop on `ACCEPTED` with
  `AUTONOMOUS_PAYMENT_NOT_AUTHORIZED` (never advances toward payment), `false`
  is the only row reaching `AWAITING_PAYMENT`, and the refusal event
  hash-chains like any other. The end-to-end throw + audit through `acceptOffer`
  is the ISSUE-013 regression in `packages/trpc/tests/negotiation-route.test.ts`
  (`packages/payments` has no autonomous-payment code to drive, so the payments
  suite does not re-exercise it — see its module doc).
- Audit events are produced correctly for every transition, and the chain
  verifies. ✅ Payments suite: after a real capture / divergence reconcile, the
  chain fetched back from Postgres (`getAuditEventsForSession` →
  `verifyChain`) is valid from genesis, a non-terminal poll adds no event, and
  tampering with a stored payment event breaks verification exactly there.
  Policy suite: capture / failure / divergence timelines each verify end to
  end, one event per transition, every reason code in the closed enum.

**Note (2026-09-06).** No production code changed — two test files only. Tier 2
is reached the same way TICKET-304/305/602 reached it (seed the session at
`AWAITING_PAYMENT` with an accepted Tier 2 offer + reserved hold and drive
`reconcileOrder`), sidestepping ISSUE-012 sub-issues 12b/12e, which are about
minting a Tier 2 offer through `createOrder` / `propose` — not relevant to the
reconciliation path this ticket tests. `packages/payments` already carries
`fileParallelism: false` (ISSUE-014); this is its fourth real-DB file.
`packages/policy/tests/` is still outside `check-types` (ISSUE-016) — the new
policy suite was hand-verified clean with a temporary `tests/` include (only
ISSUE-016's three known `contribution.test.ts` errors surfaced).

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
