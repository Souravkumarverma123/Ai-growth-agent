import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // reconcile-order.test.ts and poll-pending-orders.test.ts (TICKET-304)
    // share one physical sibling test database (see @repo/database's
    // testing/db.ts) — the identical guard @repo/database and @repo/trpc
    // already carry for the same reason (ISSUE-003, ISSUE-007): Vitest runs
    // different test files in a package concurrently by default, and
    // truncateAllTables in one file can wipe rows the other is mid-way
    // through asserting.
    fileParallelism: false,
    env: {
      // @repo/database's env module validates DATABASE_URL eagerly at
      // import time (packages/database/env.ts). Every pre-TICKET-304 test in
      // this package mocks every one of its dependencies and never opens a
      // real connection, so this placeholder keeps them hermetic even if a
      // real DATABASE_URL happens to be present in the environment.
      //
      // TICKET-304's reconcile-order.test.ts / poll-pending-orders.test.ts
      // are the deliberate exception: they exercise CONTRACTS.md §8's
      // sanctioned real-Postgres seam directly (no tRPC layer sits between
      // packages/payments and packages/database here). They cannot use this
      // placeholder, so the actual value — whatever DATABASE_URL genuinely
      // resolved to when `vitest` was invoked — is preserved below under a
      // different name; those two files restore it before importing
      // @repo/database/testing/db. No other file reads this var.
      DATABASE_URL: "postgres://placeholder:placeholder@localhost:5432/placeholder_never_connected",
      REAL_DATABASE_URL: process.env.DATABASE_URL ?? "",
    },
  },
});
