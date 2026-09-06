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
    // happy-dom, not jsdom: jsdom@30 bundles undici@8, which calls a webidl
    // global (`markAsUncloneable`) absent on the Node 20.x line CI pins —
    // it fails to load before a single test runs. happy-dom has no undici
    // dependency and covers everything this suite renders.
    environment: "happy-dom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
