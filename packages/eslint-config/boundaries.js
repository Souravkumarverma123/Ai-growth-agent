/**
 * Package boundary rules — CONTRACTS.md §2.
 *
 * These are the architectural invariants the repository enforces mechanically
 * rather than by convention, so that a reviewer can verify them in seconds and
 * a parallel agent cannot break one by accident.
 *
 * Packages applying these must lint with `--max-warnings 0`: the shared base
 * config includes eslint-plugin-only-warn, which downgrades errors to warnings.
 */

/** Anything that could put a language model on the other side of an import. */
const MODEL_SDK_PATTERNS = [
  "openai",
  "openai/*",
  "@anthropic-ai/*",
  "@google/generative-ai",
  "@google/genai",
  "@ai-sdk/*",
  "ai",
  "langchain",
  "langchain/*",
  "@langchain/*",
  "@mistralai/*",
  "cohere-ai",
  "ollama",
  "@modelcontextprotocol/*",
  "@repo/agent",
  "@repo/agent/*",
];

/**
 * B1 — the deterministic policy engine must not be able to call a model.
 *
 * The engine decides money. If it could reach a model, the central claim of the
 * product ("the agent cannot control the money") would rest on discipline
 * rather than on structure.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const policyEngineBoundaries = [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: MODEL_SDK_PATTERNS,
              message:
                "B1 (CONTRACTS.md §2): packages/policy must not import a model SDK. The engine decides money and must not be able to call a model. If a ticket seems to need this, stop and open an issue-tracker.md entry.",
            },
            {
              group: ["@repo/payments", "@repo/payments/*"],
              message:
                "B1 (CONTRACTS.md §2): the policy engine does not talk to the payment rail. Payments depend on policy, never the reverse.",
            },
          ],
        },
      ],
    },
  },
];

/**
 * B2 — the agent package has no path to money.
 *
 * Its only entry point into the engine is mintOffer. It cannot reach the
 * payment layer, and it cannot reach policy write surfaces.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const agentBoundaries = [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@repo/payments", "@repo/payments/*"],
              message:
                "B2 (CONTRACTS.md §2): packages/agent must not import the payment layer. No model-adjacent code path may reach money movement.",
            },
            {
              group: ["@repo/database", "@repo/database/*"],
              message:
                "B2 (CONTRACTS.md §2): packages/agent must not write policy or offer state directly. Its only engine entry point is mintOffer.",
            },
          ],
        },
      ],
    },
  },
];

/**
 * B3 — the payment layer is driven by offer ids, never by a model.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const paymentsBoundaries = [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: MODEL_SDK_PATTERNS,
              message:
                "B3 (CONTRACTS.md §2): packages/payments must not import a model SDK. Amounts come from the offer row, never from a model.",
            },
          ],
        },
      ],
    },
  },
];
