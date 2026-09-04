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
- Use `generatePath` with an area base, as the existing `negotiation` and `merchant` routes do.
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

---

## 11. Merge gate

Every PR — agent-raised or human-raised — clears three layers, in this order. A layer exists only to catch what the layer before it cannot.

### 11.1 CI (`.github/workflows/ci.yml`) — required, mechanical, non-negotiable

Runs `pnpm check-types`, `pnpm lint` (the boundary rules from §2), and `pnpm test` (every invariant suite that has landed) against a real Postgres. **This must pass before anyone — human or AI — spends time reading the diff.** A reviewer's job is never to notice the pipeline is red; GitHub should refuse the merge button first. Turn on required status checks for the `verify` job on `main` once this workflow lands.

CI proves the mechanical claims: no model SDK inside `packages/policy`, no float money, the reason-code enum unbroken, whatever invariant tests exist. It cannot prove anything semantic — that a candidate generator secretly reads conversation content, that a budget reservation is read-then-write instead of atomic, that a numeric field was smuggled into `NegotiationIntent` under a different name. That is what layers two and three are for.

### 11.2 AI review (e.g. Graphite Diamond) — first pass on everything else

A generic AI reviewer is well suited to code quality, obvious bugs, and anything statically visible in a diff — but it does not know this project's invariants unless taught them. **Feed it this file as a custom rule set** (Diamond supports plain-language custom rules from its dashboard) rather than relying on its defaults. At minimum, teach it to flag:

- Any diff touching `packages/policy/contracts/`, `packages/database/models/`, or the router signatures in `packages/trpc/server/routes/*/route.ts` — a frozen-contract change requiring explicit human sign-off (§1), never a routine approval.
- Any new field added to `NegotiationIntent` (§5.1) — it must never gain a numeric field.
- Any new import into `packages/policy` or `packages/payments` from a model SDK, or into `packages/agent` from `@repo/payments` (§2) — CI's lint step already fails these, so this is a redundant tripwire, not the primary defense.
- Any function that creates a payment-rail order taking more than one parameter (§2, B3).
- Any money field typed as a float, or a percentage stored as an integer instead of a `[0, 1]` fraction (§3).
- A state transition with no reason code, or a reason code that is not one of the 28 in `packages/policy/contracts/reason-codes.ts`.

### 11.3 Human — the residual, not the whole job

If layers one and two are wired correctly, what is left for a human is narrow: the product judgment calls neither a test nor an AI reviewer can make.

- Does the diff touch a frozen contract? If yes, this is a `NEEDS_SPEC_DECISION`-caliber change (`issue-tracker.md`), not a routine review — stop and decide deliberately, don't wave it through because the rest of the PR looks fine.
- Does every acceptance criterion in the ticket have a **behavioural** test backing it — one that asserts an outcome, not that a function was called with certain arguments (§8)?
- Is a problem the author clearly hit recorded in `issue-tracker.md`, or does the PR description suggest something was quietly patched over instead?
- Does the PR do only what its ticket says? Scope that grew mid-flight is a sign a contract was informally renegotiated in code rather than in `PRD.md`.

**"No issue found, merge it" is safe exactly when — and only when — layers one and two are both actually in place and passing.** Treat a PR with a red CI check or an un-configured AI reviewer as unreviewed, no matter how clean the diff looks.
