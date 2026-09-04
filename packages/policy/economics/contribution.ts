import type { Basket } from "../contracts/negotiation";
import type { CommitmentValue, SkuPolicy } from "../contracts/merchant-policy";
import type { MinorUnits } from "../contracts/money";

/**
 * TICKET-102 — basket contribution calculator (PRD §6.1–6.3, §18.2).
 *
 *   contribution = Σ((line_price − line_floor) × qty) + Σ(commitment_values)
 *
 * "Contribution" means headroom above floor, never gross margin: floors
 * replace COGS, so this module never computes, and never claims to compute,
 * margin (PRD §6.1).
 *
 * Evaluation is always basket-level (PRD §6.3), never per line — trading a
 * concession on one SKU for the addition of another is only representable
 * at basket level. Accordingly, every entry point here takes a whole
 * `Basket`; there is deliberately no exported function that scores a single
 * line, so per-line evaluation is not just discouraged but impossible to
 * reach through this module's surface.
 *
 * Pure arithmetic only: every input is already an integer in minor units
 * (see `contracts/money.ts`), and only `+`, `-`, `*` are ever used below —
 * never `/` — so no float can enter the calculation. The contracts require
 * an integer but not a *safe* one, so every raw operand — not just every
 * computed step — is checked against `Number.MAX_SAFE_INTEGER` and throws
 * rather than silently rounding. Checking results alone would let a
 * contract-valid unsafe operand (e.g. `unitPriceMinor` at `2^53`) slip
 * through whenever it happens to combine into a safe-looking result; no
 * rounding is ever returned, even if a step is unrepresentable.
 */

/**
 * A basket carries `skuId`s but not floor prices, and commitment *types* but
 * not their rupee values — both live in merchant policy, not on the basket.
 * This indexes the SKU policy list once per call for O(1) per-line lookups.
 */
function indexSkuPoliciesById(skuPolicies: readonly SkuPolicy[]): Map<string, SkuPolicy> {
  const bySkuId = new Map<string, SkuPolicy>();
  for (const policy of skuPolicies) {
    bySkuId.set(policy.skuId, policy);
  }
  return bySkuId;
}

/** Same idea as {@link indexSkuPoliciesById}, for commitment values. */
function indexCommitmentValuesByType(
  allowedCommitments: readonly CommitmentValue[],
): Map<string, MinorUnits> {
  const byType = new Map<string, MinorUnits>();
  for (const commitment of allowedCommitments) {
    byType.set(commitment.commitmentType, commitment.valueMinor);
  }
  return byType;
}

/**
 * Fails closed on precision loss (PRD §6.3, CONTRACTS.md §6): `MinorUnits` is
 * a plain `number`, and the money/quantity contracts only require an integer
 * — not a *safe* integer — so a contract-valid basket can carry values whose
 * product exceeds `Number.MAX_SAFE_INTEGER`. Left unchecked, that would
 * silently round instead of throwing, which is indistinguishable from a
 * correct result and breaks this module's "no rounding is ever required"
 * guarantee. Every arithmetic step below is checked against that boundary
 * instead of assuming it from contract validity alone.
 */
function requireSafeInteger(value: number, description: string): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `computeBasketContribution: ${description} is not a safe integer (${value}); precision would be lost`,
    );
  }
  return value;
}

/**
 * The contribution of a basket: headroom above floor on every line, plus the
 * value of every merchant-valued commitment attached to it.
 *
 *   Σ((line_price − line_floor) × qty) + Σ(commitment_values)
 *
 * `skuPolicies` supplies each line's floor price and `allowedCommitments`
 * supplies each commitment's rupee value — both come from merchant policy,
 * since a `Basket` on its own carries neither (CONTRACTS.md §5, PRD §5.2,
 * §5.3). Callers always pass the whole basket; there is no per-line variant
 * (PRD §6.3) — a candidate that adds a SKU or swaps a commitment is scored
 * as one unit, exactly as the negotiation treats it.
 *
 * Fails closed (CONTRACTS.md §6): throws if the basket references a SKU or
 * a commitment type absent from the supplied policy data, rather than
 * silently treating it as zero and under-counting contribution. Also throws
 * if the same commitment type appears more than once — `commitments` is a
 * plain array with no schema-level uniqueness constraint, and silently
 * summing a repeated type would overstate contribution instead.
 */
export function computeBasketContribution(
  basket: Basket,
  skuPolicies: readonly SkuPolicy[],
  allowedCommitments: readonly CommitmentValue[],
): MinorUnits {
  const skuPoliciesById = indexSkuPoliciesById(skuPolicies);
  const commitmentValuesByType = indexCommitmentValuesByType(allowedCommitments);

  let contributionMinor = 0;

  for (const line of basket.lines) {
    const skuPolicy = skuPoliciesById.get(line.skuId);
    if (!skuPolicy) {
      throw new Error(
        `computeBasketContribution: no SKU policy supplied for skuId "${line.skuId}"`,
      );
    }
    requireSafeInteger(line.unitPriceMinor, `unitPriceMinor for skuId "${line.skuId}"`);
    requireSafeInteger(skuPolicy.floorPriceMinor, `floorPriceMinor for skuId "${line.skuId}"`);
    requireSafeInteger(line.quantity, `quantity for skuId "${line.skuId}"`);

    const headroomMinor = requireSafeInteger(
      line.unitPriceMinor - skuPolicy.floorPriceMinor,
      `headroom for skuId "${line.skuId}"`,
    );
    const lineContributionMinor = requireSafeInteger(
      headroomMinor * line.quantity,
      `line contribution for skuId "${line.skuId}"`,
    );
    contributionMinor = requireSafeInteger(
      contributionMinor + lineContributionMinor,
      "running contribution total",
    );
  }

  const seenCommitmentTypes = new Set<string>();
  for (const commitmentType of basket.commitments) {
    if (seenCommitmentTypes.has(commitmentType)) {
      throw new Error(
        `computeBasketContribution: commitment "${commitmentType}" appears more than once on the basket`,
      );
    }
    seenCommitmentTypes.add(commitmentType);

    const valueMinor = commitmentValuesByType.get(commitmentType);
    if (valueMinor === undefined) {
      throw new Error(
        `computeBasketContribution: no value supplied for commitment "${commitmentType}"`,
      );
    }
    requireSafeInteger(valueMinor, `commitment value for "${commitmentType}"`);
    contributionMinor = requireSafeInteger(
      contributionMinor + valueMinor,
      `running contribution total after commitment "${commitmentType}"`,
    );
  }

  return contributionMinor;
}

/**
 * The counterfactual (PRD §6.2): the original cart, with every line
 * re-priced at that SKU's list price and no commitments attached, because
 * at list nothing has been negotiated yet.
 *
 * This is the figure every proposed basket is judged against for the whole
 * session — never ₹0, never a probability-weighted estimate (PRD §6.2) —
 * and is exactly what `NegotiationSession.counterfactualContributionMinor`
 * holds, computed once at session open.
 *
 * Lines are re-priced from `skuPolicies` rather than trusting
 * `originalBasket`'s own `unitPriceMinor`, so the result is correct even if
 * the stored cart was captured at some price other than the SKU's current
 * list price. Any commitments already present on `originalBasket` are
 * ignored for the same reason: the counterfactual is what the cart is worth
 * with nothing negotiated, regardless of what the stored basket carries.
 */
export function computeCounterfactualContribution(
  originalBasket: Basket,
  skuPolicies: readonly SkuPolicy[],
): MinorUnits {
  const skuPoliciesById = indexSkuPoliciesById(skuPolicies);

  const atListBasket: Basket = {
    ...originalBasket,
    lines: originalBasket.lines.map((line) => {
      const skuPolicy = skuPoliciesById.get(line.skuId);
      if (!skuPolicy) {
        throw new Error(
          `computeCounterfactualContribution: no SKU policy supplied for skuId "${line.skuId}"`,
        );
      }
      return { ...line, unitPriceMinor: skuPolicy.listPriceMinor };
    }),
    commitments: [],
  };

  return computeBasketContribution(atListBasket, skuPolicies, []);
}
