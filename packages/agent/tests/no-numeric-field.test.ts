import { describe, expect, it } from "vitest";
import type { NegotiationIntent } from "@repo/policy";
import type { NegotiationModel } from "../model";

/**
 * TICKET-201 acceptance criterion: "The intent type has no numeric field.
 * Adding one is a review-blocking change."
 *
 * This is a *type-level* proof, not a runtime property test: the assertions
 * below are checked by `pnpm --filter @repo/agent check-types` (this
 * package's `tsconfig.json` has no restrictive `include`, so `tests/` is
 * part of the compiled program). If a numeric field is ever added anywhere
 * along this chain, `check-types` fails to compile — the build breaks at the
 * moment the invariant is broken, the same guarantee
 * `packages/policy/contracts/intent.ts` already gives its own frozen type.
 *
 * The `it` blocks exist so the proof also shows up as a named, passing
 * assertion in `pnpm test` output, not only as a silent compiler pass.
 */

// ---------------------------------------------------------------------------
// 1. Prove NegotiationModel.nextIntent's resolved return type IS the frozen
//    @repo/policy NegotiationIntent — not a structurally similar type this
//    package redefined on its own.
// ---------------------------------------------------------------------------
type DecideResult = Awaited<ReturnType<NegotiationModel["nextIntent"]>>;

type AssertExactMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _nextIntentReturnsFrozenIntentType: AssertExactMatch<DecideResult, NegotiationIntent> = true;

// ---------------------------------------------------------------------------
// 2. Reuse the exact NumericKeys proof technique the frozen contract itself
//    uses (packages/policy/contracts/intent.ts), applied to the type as seen
//    through this package's own interface — proving the invariant survives
//    the trip through NegotiationModel, not merely inside packages/policy.
// ---------------------------------------------------------------------------
type NumericKeys<T> = {
  [K in keyof T]-?: number extends T[K] ? K : never;
}[keyof T];

type AssertNoNumericFields = [NumericKeys<DecideResult>] extends [never] ? true : never;

const _decideResultHasNoNumericField: AssertNoNumericFields = true;

describe("NegotiationModel's output surface has no numeric field", () => {
  it("resolves to the frozen NegotiationIntent type, unmodified", () => {
    expect(_nextIntentReturnsFrozenIntentType).toBe(true);
  });

  it("contains no numeric field — adding one fails `pnpm check-types`", () => {
    expect(_decideResultHasNoNumericField).toBe(true);
  });
});
