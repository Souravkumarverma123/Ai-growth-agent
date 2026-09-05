import { config } from "@repo/eslint-config/base";

/**
 * TICKET-204 — no lint config existed for this package before this ticket
 * (`pnpm --filter @repo/trpc lint` had no script to run). Added so this
 * package matches the other workspace packages
 * (`packages/{policy,agent,payments}/eslint.config.mjs`) rather than being
 * silently skipped by `turbo run lint`.
 *
 * No boundary rules from `@repo/eslint-config/boundaries` apply here:
 * `packages/trpc` is the transport layer, and CONTRACTS.md §2's B1/B2/B3
 * rules are specifically about `packages/policy`, `packages/agent` and
 * `packages/payments` not reaching things they must not — a router calling
 * into all three (policy, agent, payments, database) to orchestrate a
 * request is exactly its job, not a boundary violation.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default config;
