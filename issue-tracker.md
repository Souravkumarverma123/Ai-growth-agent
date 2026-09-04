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

## ISSUE-003 — TICKET-001's database test harness was never built, despite being marked DONE

Status: OPEN
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

Not yet fixed. Interim, scoped workaround given to TICKET-507 (which needs a DB test now and would otherwise be blocked): seed and verify directly against the real `dev` database via the existing `DATABASE_URL` — no separate test database needed for that one ticket, since seeding `dev` is the ticket's actual deliverable. The general fix — a shared, reusable real-Postgres test harness — is still needed before TICKET-107, which hard-requires real concurrency against a real database.

### Regression Test

None yet — the eventual fix's own regression test is the smoke test TICKET-001 originally specified.

### Related Ticket

TICKET-001 (unmet), TICKET-507 (worked around), TICKET-107 (will hit this next)

### Status History

- 2026-09-04: OPEN

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
