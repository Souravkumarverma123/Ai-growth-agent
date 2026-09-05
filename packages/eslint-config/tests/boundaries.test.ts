import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { config as baseConfig } from "../base.js";
import {
  agentBoundaries,
  orderCreationBoundaries,
  policyEngineBoundaries,
} from "../boundaries.js";

/**
 * TICKET-605 — proves the boundary rules in ../boundaries.js actually fire.
 *
 * A rule that is wired into a package's eslint.config.mjs but never
 * exercised against a real violation is a rule nobody has verified works —
 * it could reference a typo'd option name and silently no-op forever. These
 * tests run the real ESLint flat-config engine (the same one CI runs via
 * `pnpm lint`) against small fixture files under tests/fixtures/, each one
 * standing in for a file inside the package the rule protects, since none of
 * packages/policy, packages/agent or (not yet built) packages/payments
 * contain a deliberate violation of their own.
 *
 * Every rule gets a positive fixture (must report a matching message) and a
 * negative fixture (compliant code the rule must not flag).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);

async function lintFixture(overrideConfig: Linter.Config[], fixtureName: string) {
  const eslint = new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig,
  });
  const [result] = await eslint.lintFiles([fixture(fixtureName)]);
  if (!result) {
    throw new Error(`ESLint returned no result for fixture ${fixtureName}`);
  }
  return result;
}

// eslint-plugin-only-warn (pulled in by ../base.js) patches the Linter
// prototype on import so every "error" severity (2) is reported as "warn"
// (1) instead — see packages/eslint-config/boundaries.js's file header and
// node_modules/eslint-plugin-only-warn's README. That is intentional
// production behaviour (CI's --max-warnings 0 is what turns it back into a
// failure), so these tests assert on message content/ruleId rather than on
// severity or errorCount/warningCount.
function messagesFor(result: ESLint.LintResult, ruleId: string) {
  return result.messages.filter((message) => message.ruleId === ruleId);
}

describe("B1 — packages/policy must not reach a model or the payment rail", () => {
  const overrideConfig = [...baseConfig, ...policyEngineBoundaries];

  it("fires on a model SDK import", async () => {
    const result = await lintFixture(overrideConfig, "policy-model-sdk-violation.ts");
    const hits = messagesFor(result, "no-restricted-imports");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.message.includes("B1") && m.message.includes("model SDK"))).toBe(
      true,
    );
  });

  it("fires on a @repo/payments import", async () => {
    const result = await lintFixture(overrideConfig, "policy-payments-import-violation.ts");
    const hits = messagesFor(result, "no-restricted-imports");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.message.includes("B1") && m.message.includes("payment rail"))).toBe(
      true,
    );
  });

  it("does not flag compliant code", async () => {
    const result = await lintFixture(overrideConfig, "policy-ok.ts");
    expect(messagesFor(result, "no-restricted-imports")).toHaveLength(0);
  });
});

describe("B2 — packages/agent must not reach payments or write policy state", () => {
  const overrideConfig = [...baseConfig, ...agentBoundaries];

  it("fires on a @repo/payments import", async () => {
    const result = await lintFixture(overrideConfig, "agent-payments-import-violation.ts");
    const hits = messagesFor(result, "no-restricted-imports");
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.some((m) => m.message.includes("B2") && m.message.includes("payment layer")),
    ).toBe(true);
  });

  it("fires on a @repo/database import", async () => {
    const result = await lintFixture(overrideConfig, "agent-database-import-violation.ts");
    const hits = messagesFor(result, "no-restricted-imports");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.message.includes("B2") && m.message.includes("mintOffer"))).toBe(
      true,
    );
  });

  it("does not flag compliant code", async () => {
    const result = await lintFixture(overrideConfig, "agent-ok.ts");
    expect(messagesFor(result, "no-restricted-imports")).toHaveLength(0);
  });
});

describe("B3 — no order-creation function accepts an amount parameter", () => {
  const overrideConfig = [...baseConfig, ...orderCreationBoundaries];

  it("fires on a function declaration named createOrder", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-violation.ts");
    const hits = messagesFor(result, "no-restricted-syntax");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.message.includes("B3"))).toBe(true);
  });

  it("fires on an arrow function assigned to a name matching create*order", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-violation-arrow.ts");
    expect(messagesFor(result, "no-restricted-syntax").length).toBeGreaterThan(0);
  });

  it("fires on a class method named createOrder", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-violation-method.ts");
    expect(messagesFor(result, "no-restricted-syntax").length).toBeGreaterThan(0);
  });

  it("fires on a typed, destructured input object carrying an amount property", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-violation-destructured.ts");
    const hits = messagesFor(result, "no-restricted-syntax");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((m) => m.message.includes("B3"))).toBe(true);
  });

  it("does not flag createOrder(offerId) taking a single id argument", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-ok.ts");
    expect(messagesFor(result, "no-restricted-syntax")).toHaveLength(0);
  });

  it("does not flag a destructured input object with no amount property", async () => {
    const result = await lintFixture(overrideConfig, "order-creation-ok-destructured.ts");
    expect(messagesFor(result, "no-restricted-syntax")).toHaveLength(0);
  });

  it("does not flag an unrelated function that happens to take an amount parameter", async () => {
    const result = await lintFixture(
      overrideConfig,
      "order-creation-ok-unrelated-amount-param.ts",
    );
    expect(messagesFor(result, "no-restricted-syntax")).toHaveLength(0);
  });
});
