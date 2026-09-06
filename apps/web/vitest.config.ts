import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * TICKET-502 introduced the first component test in `apps/web`. Scope is
 * deliberately narrow: jsdom render checks of presentational components and
 * unit checks of `lib/` shaping helpers. This is NOT a fourth negotiation
 * seam (CONTRACTS.md §8) — it mocks no database, model or rail and asserts
 * only what the browser would render.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
