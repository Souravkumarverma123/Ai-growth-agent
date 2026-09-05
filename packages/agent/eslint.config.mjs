import { config } from "@repo/eslint-config/base";
import { agentBoundaries } from "@repo/eslint-config/boundaries";

/**
 * CONTRACTS.md §2, boundary rule B2.
 *
 * packages/agent must not import packages/payments, and must not write
 * policy or offer state directly via packages/database — its only engine
 * entry point is mintOffer. Enforced here rather than by convention so a
 * reviewer can verify it in ten seconds instead of reading the whole package.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [...config, ...agentBoundaries];
