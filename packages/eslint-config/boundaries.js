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
 * Defense-in-depth mirror of B1 for the payment layer: no model SDK on this
 * side of the boundary either.
 *
 * NOTE: this is not itself one of CONTRACTS.md §2's four numbered hard rules
 * (B1-B4) — it predates the actual B3 (see `orderCreationBoundaries` below,
 * which is CONTRACTS.md's real B3: "no order-creation function accepts an
 * amount parameter"). Its own inline messages used to say "B3", which
 * collided with the real B3's label; logged as ISSUE-008 and fixed here by
 * dropping the incorrect citation rather than reusing a rule number this
 * rule was never actually assigned in CONTRACTS.md.
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
                "CONTRACTS.md §2: packages/payments must not import a model SDK. Amounts come from the offer row, never from a model.",
            },
          ],
        },
      ],
    },
  },
];

/**
 * B3 — no order-creation function accepts an amount parameter.
 *
 * `createOrder(offerId)` — one argument. The payment rail's order-creation
 * call derives its amount from the already-signed, already-persisted Offer
 * row (see `Offer.totalMinor` in packages/policy/contracts/negotiation.ts) —
 * never from a caller. If a caller (a model, an agent, anything) could pass
 * an amount, the product's central claim ("the agent cannot control the
 * money") would rest on discipline rather than on structure.
 *
 * There is no packages/payments yet — grep confirms no order-creation
 * function exists anywhere in this repo today (TICKET-605) — so there is no
 * real target to apply this to. This rule exists so that whichever ticket
 * builds packages/payments is protected the moment it imports
 * `@repo/eslint-config/boundaries` the same way packages/policy and
 * packages/agent already do. It is proven against fixtures in
 * `tests/order-creation.test.ts` rather than against production code.
 *
 * Deliberately narrow, because a false positive on unrelated code is worse
 * than missing a real future violation:
 *  - Only fires on a function/method/arrow whose NAME matches
 *    /create.*order/i (e.g. createOrder, createRazorpayOrder) — not on every
 *    function that happens to take an amount-shaped parameter.
 *  - Only fires when a PARAMETER's name matches /amount/i or /totalminor/i
 *    (amountMinor, totalAmountMinor, totalMinor, orderAmount, ...).
 *  - Matches a plain or default-valued `Identifier` parameter. A destructured
 *    parameter (`{ amountMinor }: CreateOrderInput`) is NOT currently caught
 *    — documented rather than silently accepted. If packages/payments ends
 *    up destructuring its input object, tighten this rule instead of relying
 *    on review to catch the gap.
 *
 * @type {import("eslint").Linter.Config[]}
 */
const ORDER_CREATE_FN_NAME = "/create.*order/i";
const AMOUNT_PARAM_NAME = "/amount|totalminor/i";

const ORDER_CREATION_MESSAGE =
  "B3 (CONTRACTS.md §2): no order-creation function may accept an amount parameter. createOrder(offerId) — one argument. Amounts are read from the already-persisted Offer row, never from a caller.";

const orderCreationFunctionShapes = [
  // function createOrder(offerId, amountMinor) {}
  `FunctionDeclaration[id.name=${ORDER_CREATE_FN_NAME}]`,
  // const createOrder = (offerId, amountMinor) => {}
  `VariableDeclarator[id.name=${ORDER_CREATE_FN_NAME}] > ArrowFunctionExpression`,
  // const createOrder = function (offerId, amountMinor) {}
  `VariableDeclarator[id.name=${ORDER_CREATE_FN_NAME}] > FunctionExpression`,
];

const orderCreationSelectors = [
  ...orderCreationFunctionShapes.flatMap((fn) => [
    `${fn} > Identifier.params[name=${AMOUNT_PARAM_NAME}]`,
    `${fn} > AssignmentPattern.params[left.name=${AMOUNT_PARAM_NAME}]`,
  ]),
  // class OrderService { createOrder(offerId, amountMinor) {} }
  `MethodDefinition[key.name=${ORDER_CREATE_FN_NAME}] Identifier.params[name=${AMOUNT_PARAM_NAME}]`,
  `MethodDefinition[key.name=${ORDER_CREATE_FN_NAME}] AssignmentPattern.params[left.name=${AMOUNT_PARAM_NAME}]`,
  // const service = { createOrder(offerId, amountMinor) {} }
  `Property[key.name=${ORDER_CREATE_FN_NAME}][value.type="FunctionExpression"] Identifier.params[name=${AMOUNT_PARAM_NAME}]`,
  `Property[key.name=${ORDER_CREATE_FN_NAME}][value.type="FunctionExpression"] AssignmentPattern.params[left.name=${AMOUNT_PARAM_NAME}]`,
];

/** @type {import("eslint").Linter.Config[]} */
export const orderCreationBoundaries = [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...orderCreationSelectors.map((selector) => ({
          selector,
          message: ORDER_CREATION_MESSAGE,
        })),
      ],
    },
  },
];
