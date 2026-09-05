import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      // @repo/database's env module validates DATABASE_URL eagerly at
      // import time (packages/database/env.ts). No test in this package
      // ever opens a real connection — createOrder's db-touching code path
      // (./src/offer-repository.ts) is mocked in tests that exercise
      // createOrder, and the pure-derivation tests only need the module
      // graph to import without throwing. This placeholder keeps the whole
      // suite hermetic: no real Postgres, no real network, ever.
      DATABASE_URL: "postgres://placeholder:placeholder@localhost:5432/placeholder_never_connected",
    },
  },
});
