import { config } from "@repo/eslint-config/base";
import { policyEngineBoundaries } from "@repo/eslint-config/boundaries";

/**
 * CONTRACTS.md §2, boundary rule B1.
 *
 * The deterministic policy engine must not be able to call a model. This is
 * enforced here rather than by convention so that a reviewer can verify it in
 * ten seconds instead of reading the whole package.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [...config, ...policyEngineBoundaries];
