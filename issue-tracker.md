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

## ISSUE-005 — Dev-mode CORS (`origin: "*"`) rejects every credentialed client-side tRPC call from `apps/web`

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
