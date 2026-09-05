import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // audit-route.test.ts and merchant-policy-approval.test.ts both hit the
    // one physical sibling test database (@repo/database/testing/db.ts) and
    // both truncate it between tests, so running them concurrently lets one
    // file's truncate wipe rows the other is mid-way through using. Same
    // fix as @repo/database/vitest.config.ts, for the same reason.
    fileParallelism: false,
  },
});
