# Merchant Growth Agent

**Razorpay AI Buildathon — Track 01: AI Growth & Agentic Commerce**

> *The agent can negotiate the deal, but it cannot control the money or redefine the rules.*

An A2A (agent-to-agent) merchant growth agent that autonomously rescues high-intent checkout sessions — carts a buyer is about to abandon — by negotiating transaction-level incentives directly with the buyer's own agent, instead of falling back on a blanket discount code.

## What it solves

A merchant's only real tool for cart abandonment today is the public coupon: uniform, leaky, and claimed disproportionately by buyers who would have paid list price anyway. Handing this problem to an LLM with a "discount ceiling" doesn't fix it either — a model can be argued into things, and a range check catches none of it, because a manipulated number is still inside the range.

This project builds bounded delegation instead of unrestricted AI control. Three properties define it:

1. **Bounded delegation.** The merchant grants commercial authority in advance, as policy (floors, campaign budget, per-deal cap). The agent operates inside it without per-transaction human approval.
2. **Structural separation of reasoning from money.** A deterministic, non-AI policy engine computes every candidate deal in advance. The AI agent only ever chooses *which* engine-authored option to offer and how to phrase it — the type it emits has no numeric field, so it cannot author an amount even if manipulated.
3. **Total auditability.** Every state transition writes exactly one deterministic reason code into an append-only, hash-chained ledger, so any offer can be explained and verified after the fact.

## How it works

```
merchant policy (floors, budget, caps)
        │
        ▼
 policy engine (packages/policy) ── pure, deterministic, zero AI dependencies
        │  generates a bounded, capped set of candidate deals
        ▼
 merchant agent (packages/agent) ── an LLM chooses WHICH candidate to offer
        │  and picks a fixed message template — never invents a price or claim
        ▼
 negotiation API (packages/trpc + apps/api) ── the public, buyer-agent-facing surface
        │
        ▼
 payments (packages/payments) ── Razorpay test-mode order, buyer authorizes payment
        │
        ▼
 audit ledger (packages/database) ── append-only, hash-chained record of every decision
```

A negotiation always follows the same shape: the merchant-side engine decides *whether* a session is even eligible (cart inactivity, exit-intent, cart value — never anything the buyer claims). If eligible, the engine proposes a **Tier 1** deal that costs the merchant nothing beyond ordinary margin (a bundle, a small quantity upsell). Only if the buyer refuses that does a **Tier 2** deal become reachable — one funded from a merchant-approved campaign budget, capped per-deal and in aggregate, and released back to the pool the moment it's no longer needed.

### Worked example (also the seed/demo data)

| SKU | List | Floor | Headroom |
| --- | --- | --- | --- |
| Vitamin C Serum | ₹1,800 | ₹1,100 | ₹700 |
| Gentle Cleanser | ₹700 | ₹450 | ₹250 |
| Night Cream (slow-moving) | ₹900 | ₹520 | ₹380 |

Original cart (Serum + Cleanser) at list: ₹2,500 — counterfactual contribution ₹950.

- **Round 1 (Tier 1):** bundle in all three at ₹3,020 — contribution still exactly ₹950 (clears slow-moving stock, costs the merchant nothing). Buyer refuses — it wants to spend less, not more.
- **Round 2 (Tier 2):** ₹2,300 for the original cart — contribution ₹750, a ₹200 shortfall funded from campaign budget, exactly at the per-deal cap.
- **Round 3:** buyer holds at ₹2,200 — the required shortfall (₹300) exceeds the cap, so the agent **walks away**, with campaign budget still unused. The agent refusing a deal it could afford, because a *different* limit binds, is the clearest proof that its authority is bounded rather than assumed.

## Repository layout

| Package | Role |
| --- | --- |
| `packages/policy` | The deterministic engine: eligibility, candidate generation, tiering, concession curve, floor enforcement, offer minting. Pure — no I/O, no AI dependency (lint-enforced). |
| `packages/agent` | The merchant-side LLM: chooses among engine-authored candidates, composes buyer-facing messages from constrained templates only. |
| `packages/payments` | Razorpay test-mode order creation. Orders only — no capture/charge call exists anywhere in this package. |
| `packages/database` | Drizzle schema, migrations, and repositories — including the append-only, hash-chained audit ledger. |
| `packages/trpc` | The negotiation and merchant-console API surface (tRPC + OpenAPI). |
| `apps/api` | Express host exposing the tRPC routers and the public OpenAPI/Scalar documentation. |
| `apps/web` | The merchant console (Next.js) — policy configuration/approval, live negotiation view, audit trail. |

Governance docs at the repo root are part of the project, not incidental: **`PRD.md`** (product requirements and the invariants above), **`CONTRACTS.md`** (frozen types and boundary rules every package is built against), **`Tickets.md`** (implementation plan and status), and **`issue-tracker.md`** (every bug and open architectural question found during implementation, with its resolution or reasoning).

## Non-negotiable invariants

These hold regardless of any feature built on top of them (full list in `PRD.md` §21):

- The LLM cannot directly control money, and no model-generated string ever becomes a monetary amount.
- Merchant policy is deterministic and enforced entirely outside the LLM.
- Tier 2 requires an explicit Tier 1 refusal and a re-check of continued eligibility.
- Campaign budget reservations are atomic, capped, and have a real lifecycle (reserved → committed/released).
- One offer mints exactly one order; offers are single-use and expire.
- Payment state comes from the payment rail, never from an agent's claim — autonomous payment execution is disabled and unimplemented in this MVP.
- Every decision fails closed at a financial or security boundary, and is recorded with a deterministic reason code in an append-only ledger.

## Getting started

Requires Node ≥18, pnpm, and a local Postgres (a `docker-compose.yml` is included).

```bash
pnpm install
docker compose up -d
```

Create a `.env` at the repo root:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev
OFFER_SIGNING_SECRET=some-local-dev-secret     # signs every minted offer
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx           # Razorpay test-mode credentials
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

`pnpm dev` runs through Turbo in strict env mode, so a root-`.env` value only
reaches a task if it's listed in `turbo.json`'s `globalPassThroughEnv` (these
four are). Add any new required env var there too, or it silently won't be
visible under `pnpm dev`.

Then:

```bash
pnpm db:migrate     # apply schema migrations
pnpm --filter @repo/database db:seed   # load the demo catalogue above
pnpm dev            # apps/api + apps/web
```

Nothing in the MVP opens a negotiation session from a UI (a real checkout
system flags a cart `AT_RISK` and hands the buyer agent its id). To exercise
the `apps/web` console end to end locally, create one by hand:

```bash
pnpm --filter @repo/database db:seed-session   # prints a session id + the console URLs
```

Open the buyer console it prints, send a message, then **Decline & continue**
each offer — after round 3 the next proposal hits the round cap, the session
ends `WALKED_AWAY`, and the walk-away card appears on that session's audit
trail. (`db:seed-session` needs `DATABASE_URL` in the environment, same as
`db:seed`; it never touches an existing session, so run it again for a fresh
one.)

```bash
pnpm check-types     # across every package
pnpm lint            # includes the CONTRACTS.md boundary rules (e.g. the policy
                      # engine importing no model SDK fails the build, not a reviewer)
pnpm test            # includes the real-Postgres integration suites — this repo's
                      # convention is to never mock the database (see CONTRACTS.md §8)
```

### Public API surfaces

`apps/api` (default `http://localhost:8000`) exposes the same buyer-facing
negotiation procedures three ways:

| Path | For |
| --- | --- |
| `/docs` | Scalar reference for the OpenAPI document (`/openapi.json`) — the human-readable API docs, part of the submission. |
| `/api/negotiation/*` | REST/OpenAPI surface — `open`, `propose`, `respond`, `accept`, `session/{id}`. |
| `/trpc/*` | tRPC surface for typed TypeScript clients. |
| `/mcp` | **Model Context Protocol** endpoint (stateless Streamable HTTP). A third-party buyer agent that speaks MCP can negotiate end to end with no bespoke integration — the five negotiation calls are exposed as MCP tools. Thin adapter over the procedures above; leaks no floor, budget, cap, or curve. |

## Status

30 of 46 planned tickets are done — the deterministic policy engine, the audit ledger, and the negotiation API are fully built and tested; remaining work is concentrated in the buyer-facing agent harness, the payment-reconciliation loop, and the merchant console UI. See `Tickets.md` for the ticket-by-ticket breakdown.
