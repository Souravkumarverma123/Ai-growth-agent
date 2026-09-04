# Frozen Contracts

**Status: FROZEN as of Phase 0.**

These are the shared technical rules and interfaces every agent working on this repository must follow. They exist so that several agents can build in parallel without colliding, and so that the product's invariants survive contact with fast code.

> **Do not casually change anything in this document.**
> If a ticket seems to require a change here, that is a signal to stop, not to edit. Open an entry in `issue-tracker.md` with status `NEEDS_SPEC_DECISION` and wait for the lead. A contract changed quietly at hour 20 breaks three other agents' work silently.

Reading order for a new agent: `PRD.md` (what and why) → this file (how) → `Tickets.md` (your task) → `issue-tracker.md` (known problems).

---

## 1. Change control

| Change | Allowed? |
| --- | --- |
| Adding a field to a frozen table or zod schema | **No** — needs lead approval |
| Adding a member to `ReasonCode` | **No** — the enum is closed at 28. Wanting a 29th means a behaviour was added that nobody designed |
| Adding a state or transition to the session machine | **No** — needs lead approval |
| Changing a package boundary rule | **No** — never |
| Adding a numeric field to `NegotiationIntent` | **No** — this is the central invariant |
| Adding an internal helper, a private function, a test | Yes |
| Implementing a stubbed procedure body | Yes — that is the job |
| Renaming an exported symbol from a frozen module | **No** |

---

## 2. Package boundaries

```
packages/policy      deterministic engine   — no AI, no HTTP, no Razorpay
packages/agent       model orchestration    — no money, no policy writes
packages/payments    Razorpay + rail state  — no model, no policy writes
packages/database    Drizzle schema/client  — no business logic
packages/trpc        transport only         — no business logic
```

### Hard rules, lint-enforced

| Rule | Statement |
| --- | --- |
| **B1** | `packages/policy` imports **no model SDK**. Not `@anthropic-ai/*`, not `openai`, not any LLM client. A reviewer must be able to verify the engine cannot call a model. |
| **B2** | `packages/agent` imports **no** `packages/payments`, and none of policy's write surface. Its only engine entry point is `mintOffer`. |
| **B3** | **No function that creates an order accepts an amount parameter.** `createOrder(offerId)` — one argument. Amounts are read from the offer row. |
| **B4** | Candidate generation accepts **no conversation content**. Its parameters are session state and policy. There is no parameter through which buyer text could arrive. |

If you find yourself needing to violate one of these to finish a ticket, the ticket is wrong. Stop and record it.

---

## 3. Money

- **Every monetary value is an integer in minor units (paise).** No floats, no decimals, no strings, anywhere — database, zod, tRPC, UI props.
- Type alias: `MinorUnits = number`. Use it. It documents intent at every call site.
- Currency is an explicit field, hardcoded `"INR"` for the MVP. Never assume it.
- Formatting to rupees happens **only** at the React render boundary. Never in the engine, never in an API response.
- Percentages (the concession curve, the 3% tolerance) are `number` fractions in `[0, 1]`, never integers-as-percent. `0.03`, not `3`.

---

## 4. Naming

| Layer | Convention | Example |
| --- | --- | --- |
| Postgres columns | `snake_case` | `campaign_spend_minor` |
| TypeScript properties | `camelCase` | `campaignSpendMinor` |
| Enum members | `SCREAMING_SNAKE` | `TIER1_REFUSED_BY_BUYER` |
| Drizzle tables | `<name>Table` | `offersTable` |
| Inferred row types | `Select<Name>` / `Insert<Name>` | `SelectOffer` |
| Zod schemas | `<thing>Schema` | `negotiationIntentSchema` |
| Money fields | always suffixed `Minor` | `totalMinor` |

Follow the existing repo style: Drizzle tables in `packages/database/models/`, re-exported from `schema.ts`; tRPC routes in `packages/trpc/server/routes/<area>/route.ts` using `generatePath` and a `TAGS` constant.

---

## 5. The types that matter most

### 5.1 `NegotiationIntent` — the model's entire output surface

```ts
type NegotiationIntent = {
  candidateId: string;
  messageFrame: MessageFrame;
  terminalAction?: "WALK_AWAY";
};
```

**There is no numeric field, and none may be added.** This is the load-bearing invariant of the whole product: no string produced by a model ever becomes a monetary amount. If a ticket seems to need one, it does not — the number it wants already exists on the candidate the model selected.

### 5.2 `ReasonCode` — closed, 28 members

Defined once in `packages/policy`. Every ledger event carries exactly one. The model can never author one. See `PRD.md` §14 for the full list and the review that produced it.

### 5.3 Session state

Twelve states, six of them terminal (`SETTLED`, `PAYMENT_FAILED`, `EXPIRED`, `WALKED_AWAY`, `DECLINED`, `HALTED`). Transitions are the table in `PRD.md` §15 and nothing else.

---

## 6. Failing closed

At every financial or security boundary, the failure mode is **refuse and audit**, never continue.

- Never `catch` and return a default at a money boundary.
- Never silently no-op. An unsupported path throws with its reason code — see the `autonomous_payment_execution` `true` branch, which exists precisely so that it can refuse loudly.
- Never widen a type to make an error go away.
- A guard that cannot currently be reached still gets written (`FLOOR_BREACH`), because the point is what happens if a future bug reaches it.

---

## 7. Ledger rules

- The ledger is **append-only**. No update function, no delete function, exists or may be written.
- Every state transition writes **exactly one** event with **exactly one** reason code.
- `reasonCode` is the **justification** — deterministic, authoritative, consulted by decision paths.
- `modelExplanation` is the **explanation** — a short final rationale of one or two sentences, non-authoritative, in its own nullable column, never read by any decision path.
- **Never store chain-of-thought,** intermediate deliberation, or reasoning traces (RA-5).
- Hash chain: each event carries `prevHash` and `eventHash`. The chain is self-anchored; this limitation is stated openly in `PRD.md` §13.3 and must not be overstated in code comments, UI copy, or the demo.

---

## 8. Testing

Tests assert **external behaviour**, never internal structure.

- Good: *"a Tier 2 offer cannot be minted before a Tier 1 refusal is logged."*
- Bad: *"the tiering function was called with these arguments."* — describes today's implementation and will be deleted tomorrow.

### Seams — there are three, and no more should be introduced

| Seam | What it isolates |
| --- | --- |
| **tRPC caller against a real Postgres** | The primary seam. Eligibility → generation → economics → tiering → holds → minting → audit, with no mocking. |
| **`NegotiationModel`** | The model. Tests inject a scripted implementation, which is faithful by construction because the intent carries no numbers. |
| **`RailStateSource`** | Razorpay. Tests force captured / failed / divergent deterministically. |

`packages/policy` is pure and needs no seam — call it directly. Invariant tests live there and run in milliseconds.

**Do not mock the database.** Use the real one; docker-compose provides it.

---

## 9. tRPC and OpenAPI

- Every procedure carries `.meta({ openapi: { method, path, tags } })` so it appears in the public OpenAPI document and Scalar reference. The public surface is a deliverable, not a side effect.
- Input and output schemas are always explicit zod. No inferred outputs.
- Use `generatePath` with an area base, as the existing `auth` route does.
- **Nothing on the buyer-facing surface may serialize a floor price, an available budget figure, a per-deal cap, or a concession-curve value.** An agent that negotiates a hundred times must learn nothing it could not learn in one.

---

## 10. Definition of done for a ticket

1. Acceptance criteria in `Tickets.md` are all met.
2. `pnpm check-types` passes.
3. `pnpm lint` passes, including the boundary rules.
4. `pnpm test` passes, and the ticket's required tests exist and are behavioural.
5. No frozen contract was changed.
6. Any problem found on the way is recorded in `issue-tracker.md`, not silently fixed.
7. Ticket status updated in `Tickets.md`.
