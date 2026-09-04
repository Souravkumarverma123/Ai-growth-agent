import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // All test files share one physical sibling database (see testing/db.ts),
    // so truncateAllTables in one file can wipe rows another file is mid-way
    // through asserting. Serialize file execution to keep the harness safe
    // as more suites adopt it.
    fileParallelism: false,
  },
});
