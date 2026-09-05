import type { Basket, BasketLine, CandidateMoveType, NegotiationSession } from "../contracts/negotiation";
import { CANDIDATE_MOVE_TYPES, MAX_CANDIDATES } from "../contracts/negotiation";
import type { CommitmentValue, MerchantPolicy, SkuPolicy } from "../contracts/merchant-policy";
import { COMMITMENT_TYPES } from "../contracts/merchant-policy";
import type { MinorUnits } from "../contracts/money";
import { computeBasketContribution } from "../economics/contribution";
import {
  assertGeneratedCandidateRespectsFloors,
  assertOriginalBasketRespectsFloors,
  assertSkuCatalogueIsSane,
} from "./floor-enforcement";
import { resolveConcessionFraction } from "./round-envelope";

/**
 * TICKET-103 — candidate generator (PRD §8; CONTRACTS.md B4).
 *
 * Produces a bounded, deterministic, capped candidate set by applying the
 * five fixed move types from PRD §8 and stopping. It never enumerates the
 * basket space.
 *
 * ============================================================================
 * BOUNDARY RULE B4 — no conversation content can reach this function
 * ============================================================================
 * The only parameter is {@link CandidateGenerationInput}: a narrow slice of
 * session state (`originalBasket`, `counterfactualContributionMinor`,
 * `roundIndex` — via `Pick<NegotiationSession, ...>` so it can never drift
 * from the frozen session shape), the merchant policy, and the SKU
 * catalogue. None of these carry free-form text. There is no parameter
 * through which a buyer or buyer-agent message could arrive, and nothing
 * below ever reads a field that isn't one of these three.
 *
 * ============================================================================
 * WHERE THIS TICKET'S OUTPUT ENDS AND TICKET-104'S BEGINS
 * ============================================================================
 * The frozen `candidateSchema` (contracts/negotiation.ts) requires `tier`,
 * `requiredCampaignSpendMinor`, `feasible` and `infeasibleReason` — none of
 * which are computable from basket-and-floor arithmetic alone (tier requires
 * knowing `tier1Refused`; feasibility requires the live, database-backed
 * campaign budget). This module returns its own intermediate type,
 * {@link GeneratedCandidate}, carrying everything that genuinely is
 * computable here — `moveType`, `basket`, `totalMinor`, `contributionMinor`,
 * `contributionDeltaMinor`, `clearsSlowMoving` — and leaves tiering and
 * feasibility marking to TICKET-104, which wraps this output into the
 * frozen `Candidate` shape.
 *
 * ============================================================================
 * THE ROUND ENVELOPE (RA-4) NOW LIVES IN TICKET-105'S OWN MODULE
 * ============================================================================
 * This generator originally computed the round envelope inline, because
 * TICKET-105 ("Concession curve and round envelope") wasn't done yet and this
 * ticket's own dependency list is only TICKET-102, so it never had to block
 * on it. RA-4 (PRD §16, §7) settles the arithmetic — `MerchantPolicy.
 * concessionCurve` applied to floor-derived headroom on the original basket —
 * and that arithmetic has since been extracted verbatim into
 * {@link resolveConcessionFraction} in `./round-envelope`, exactly the normal
 * refactor this module's doc previously said TICKET-105 landing would be.
 * This file now imports it rather than defining it; round-cap enforcement
 * (`ROUND_LIMIT_REACHED`) lives alongside it as `evaluateRoundCap`, still not
 * this generator's job (see that module's doc for why the two are separate
 * functions).
 *
 * ============================================================================
 * FLOOR SAFETY IS STRUCTURAL, NOT A POST-HOC FILTER
 * ============================================================================
 * Every move type constructs prices so a sub-floor line cannot occur:
 *  - PRICE_CONCESSION floors its own release at each line's own headroom.
 *  - ADD_SKU / ADD_SLOW_MOVING_SKU / COMMITMENT_SWAP never change a price.
 *  - INCREASE_QUANTITY never changes a unit price, only a quantity.
 * `assertOriginalBasketRespectsFloors` additionally refuses to generate at
 * all from an already-corrupted `originalBasket`, so a hypothetical upstream
 * bug can't leak a sub-floor line through the move types that merely carry
 * an original line forward unchanged. `pushCandidate` still re-asserts every
 * line of every constructed candidate before accepting it, as defense in
 * depth. Both assertions, plus the catalogue sanity check, now live in
 * TICKET-106's `./floor-enforcement` module and are imported here rather than
 * defined inline — the PRD's own defensive `FLOOR_BREACH` assertion
 * (unreachable in correct operation) belongs at mint time (also
 * `floor-enforcement.ts`, as `assertNoFloorBreach`), not here, and this
 * generator still does not rely on that later check to uphold the invariant.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Session state this ticket actually needs, expressed as a `Pick` over the
 * frozen `NegotiationSession` rather than a fresh hand-written type — this
 * ticket's signature can never silently drift from the frozen session shape,
 * and readers can see at a glance that it takes a strict subset of session
 * state, nothing more. None of the three fields can carry conversation text.
 */
export type CandidateGenerationSessionInput = Pick<
  NegotiationSession,
  "originalBasket" | "counterfactualContributionMinor" | "roundIndex"
>;

/**
 * The generator's entire input surface (B4). Every field here traces back to
 * merchant policy or merchant-controlled session state — never to a buyer or
 * buyer-agent message.
 */
export type CandidateGenerationInput = {
  session: CandidateGenerationSessionInput;
  policy: MerchantPolicy;
  /** The full catalogue, not just what's already in the basket, so ADD_SKU
   *  and ADD_SLOW_MOVING_SKU can search beyond the cart. */
  skuCatalogue: readonly SkuPolicy[];
};

/**
 * This ticket's own intermediate type — everything genuinely computable from
 * basket-and-floor arithmetic alone. Deliberately does not carry `tier`,
 * `requiredCampaignSpendMinor`, `feasible` or `infeasibleReason`: those are
 * TICKET-104's job (see the module doc above).
 */
export type GeneratedCandidate = {
  moveType: CandidateMoveType;
  basket: Basket;
  /** Sum of unit price × quantity across every line. Never includes a
   *  commitment's value — commitments are a separate, non-priced field. */
  totalMinor: MinorUnits;
  /** Headroom above floor for this basket, via `computeBasketContribution` —
   *  reused, not reimplemented. */
  contributionMinor: MinorUnits;
  /** contributionMinor − session.counterfactualContributionMinor. Negative
   *  means dilutive; this is the raw material TICKET-104 tiers from. */
  contributionDeltaMinor: MinorUnits;
  /** True when this candidate's basket carries strictly more of some
   *  slow-moving SKU than the original basket did — whether newly added or
   *  quantity-increased. Feeds PRD §6.6's 3% slow-moving tolerance band
   *  (TICKET-109), not decided here. */
  clearsSlowMoving: boolean;
};

/**
 * The counts a future caller needs to log `CANDIDATES_EVALUATED` (PRD §8,
 * §14). `evaluatedCount` and `byMoveType` are exact facts about what this
 * call produced. `selfFundingCount` — candidates whose contributionDelta is
 * already ≥ 0 — is the raw material for what TICKET-104 will call "Tier 1
 * feasible"; it is named without the word "tier" deliberately, since tier
 * assignment itself is not this ticket's job.
 */
export type CandidateGenerationCounts = {
  evaluatedCount: number;
  selfFundingCount: number;
  byMoveType: Readonly<Record<CandidateMoveType, number>>;
};

export type CandidateGenerationResult = {
  candidates: readonly GeneratedCandidate[];
  counts: CandidateGenerationCounts;
};

// ---------------------------------------------------------------------------
// Fixed per-move-type slot budget (PRD §8's table). PRICE_CONCESSION always
// contributes exactly 1 (there is only ever one "original cart at the max
// concession" candidate, so it needs no named constant or loop). The rest
// sum with it to MAX_CANDIDATES (1 + 3 + 3 + 2 + 3 = 12) by construction;
// the final result is still sliced to MAX_CANDIDATES as defense in depth,
// not because this sum can drift.
// ---------------------------------------------------------------------------

const ADD_SKU_SLOTS = 3;
const ADD_SLOW_MOVING_SKU_SLOTS = 3;
const INCREASE_QUANTITY_SLOTS = 2;
const COMMITMENT_SWAP_SLOTS = 3;

// ---------------------------------------------------------------------------
// Small internal helpers — fail closed on precision loss and inconsistent
// policy data, same discipline as economics/contribution.ts.
// ---------------------------------------------------------------------------

function requireSafeInteger(value: number, description: string): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`generateCandidates: ${description} is not a safe integer (${value})`);
  }
  return value;
}

function indexSkuPoliciesById(skuCatalogue: readonly SkuPolicy[]): Map<string, SkuPolicy> {
  const bySkuId = new Map<string, SkuPolicy>();
  for (const sku of skuCatalogue) {
    bySkuId.set(sku.skuId, sku);
  }
  return bySkuId;
}

function requireSkuPolicy(bySkuId: Map<string, SkuPolicy>, skuId: string): SkuPolicy {
  const policy = bySkuId.get(skuId);
  if (!policy) {
    throw new Error(`generateCandidates: no SKU policy supplied for skuId "${skuId}"`);
  }
  return policy;
}

function basketTotalMinor(basket: Basket): MinorUnits {
  let total = 0;
  for (const line of basket.lines) {
    const lineTotal = requireSafeInteger(
      line.unitPriceMinor * line.quantity,
      `line total for skuId "${line.skuId}"`,
    );
    total = requireSafeInteger(total + lineTotal, "basket total");
  }
  return total;
}

/**
 * True when `candidateBasket` carries strictly more of some slow-moving SKU
 * than `originalBasket` did — covers a newly added slow mover and a
 * quantity increase applied to an already slow-moving line alike, with one
 * rule instead of one per move type.
 */
function totalQuantityBySkuId(basket: Basket): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of basket.lines) {
    totals.set(line.skuId, (totals.get(line.skuId) ?? 0) + line.quantity);
  }
  return totals;
}

function introducesSlowMovingInventory(
  candidateBasket: Basket,
  originalBasket: Basket,
  skuPoliciesById: Map<string, SkuPolicy>,
): boolean {
  const originalQuantityBySkuId = totalQuantityBySkuId(originalBasket);
  const candidateQuantityBySkuId = totalQuantityBySkuId(candidateBasket);
  for (const [skuId, candidateQuantity] of candidateQuantityBySkuId) {
    const skuPolicy = requireSkuPolicy(skuPoliciesById, skuId);
    if (!skuPolicy.slowMoving) continue;
    const originalQuantity = originalQuantityBySkuId.get(skuId) ?? 0;
    if (candidateQuantity > originalQuantity) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic descending rank by per-unit headroom (list − floor), ties
 * broken on `sku` (the human-readable catalogue code) ascending — already
 * available, already deterministic, and independent of catalogue array
 * order or object-key iteration order.
 */
function selectAddableSkus(eligible: readonly SkuPolicy[], limit: number): SkuPolicy[] {
  return [...eligible]
    .sort((a, b) => {
      const contributionA = a.listPriceMinor - a.floorPriceMinor;
      const contributionB = b.listPriceMinor - b.floorPriceMinor;
      if (contributionA !== contributionB) return contributionB - contributionA;
      return a.sku.localeCompare(b.sku);
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Move type 1 — PRICE_CONCESSION (PRD §8, slot 1)
// ---------------------------------------------------------------------------

/**
 * Original cart at the maximum concession permitted this round (PRD §8).
 * Non-negotiable lines are carried forward completely unchanged — they may
 * sit in the candidate but never carry a concession (PRD §5.2, §8).
 * Negotiable lines are re-priced from the catalogue's own list price (not
 * from whatever price `originalBasket` happened to carry), matching how
 * `computeCounterfactualContribution` re-prices rather than trusts the
 * stored basket. The release is computed per unit and floored down, so it
 * can never exceed that line's own per-unit headroom — a sub-floor price is
 * unreachable by construction, not filtered after the fact.
 */
function buildPriceConcessionCandidate(
  originalBasket: Basket,
  skuPoliciesById: Map<string, SkuPolicy>,
  concessionFraction: number,
): Basket {
  const lines: BasketLine[] = originalBasket.lines.map((line) => {
    const skuPolicy = requireSkuPolicy(skuPoliciesById, line.skuId);
    if (!skuPolicy.negotiable) {
      return { ...line };
    }
    const perUnitHeadroom = requireSafeInteger(
      skuPolicy.listPriceMinor - skuPolicy.floorPriceMinor,
      `per-unit headroom for skuId "${line.skuId}"`,
    );
    // Clamp defends the "never below floor" invariant even against
    // floating-point fuzz in `perUnitHeadroom * concessionFraction`, not
    // just against the mathematical fraction range.
    const perUnitRelease = Math.min(
      Math.max(Math.floor(perUnitHeadroom * concessionFraction), 0),
      perUnitHeadroom,
    );
    const newUnitPrice = requireSafeInteger(
      skuPolicy.listPriceMinor - perUnitRelease,
      `concession unit price for skuId "${line.skuId}"`,
    );
    return { ...line, unitPriceMinor: newUnitPrice };
  });
  return { ...originalBasket, lines };
}

// ---------------------------------------------------------------------------
// Move types 2-3 — ADD_SKU / ADD_SLOW_MOVING_SKU (PRD §8, slots 2-7)
// ---------------------------------------------------------------------------

/** Catalogue SKUs sharing an affinity group with something already in the
 *  cart, excluding anything already in the cart and anything with no group
 *  (a null group never matches another null group — that would make every
 *  ungrouped SKU spuriously "related"). */
function findAffinityAddCandidates(
  originalBasket: Basket,
  skuCatalogue: readonly SkuPolicy[],
  skuPoliciesById: Map<string, SkuPolicy>,
): SkuPolicy[] {
  const basketSkuIds = new Set(originalBasket.lines.map((line) => line.skuId));
  const affinityGroups = new Set<string>();
  for (const skuId of basketSkuIds) {
    const group = requireSkuPolicy(skuPoliciesById, skuId).affinityGroup;
    if (group !== null) affinityGroups.add(group);
  }
  if (affinityGroups.size === 0) return [];
  return skuCatalogue.filter(
    (sku) =>
      !basketSkuIds.has(sku.skuId) && sku.affinityGroup !== null && affinityGroups.has(sku.affinityGroup),
  );
}

/** Catalogue SKUs flagged slow-moving, excluding anything already in the
 *  cart. No affinity-group constraint — PRD §8 states none for this move. */
function findSlowMovingAddCandidates(originalBasket: Basket, skuCatalogue: readonly SkuPolicy[]): SkuPolicy[] {
  const basketSkuIds = new Set(originalBasket.lines.map((line) => line.skuId));
  return skuCatalogue.filter((sku) => sku.slowMoving && !basketSkuIds.has(sku.skuId));
}

/** Adds one unit of `skuToAdd` at its list price. Growing the basket, not
 *  discounting the addition, is the lever (PRD §3) — so this never prices
 *  the new line below list, let alone below floor. */
function buildAddSkuCandidateBasket(originalBasket: Basket, skuToAdd: SkuPolicy): Basket {
  return {
    ...originalBasket,
    lines: [
      ...originalBasket.lines,
      { skuId: skuToAdd.skuId, quantity: 1, unitPriceMinor: skuToAdd.listPriceMinor },
    ],
  };
}

// ---------------------------------------------------------------------------
// Move type 4 — INCREASE_QUANTITY (PRD §8, slots 8-9)
// ---------------------------------------------------------------------------

/** The basket's own highest-contribution line, ties broken on `skuId`
 *  ascending (stable, deterministic, needs nothing beyond what's already on
 *  the line). `originalBasket.lines` is non-empty by schema
 *  (`basketSchema.lines.min(1)`), so this always finds one. */
function findHighestContributionLine(
  originalBasket: Basket,
  skuPoliciesById: Map<string, SkuPolicy>,
): BasketLine {
  let best: { line: BasketLine; contribution: MinorUnits } | undefined;
  for (const line of originalBasket.lines) {
    const skuPolicy = requireSkuPolicy(skuPoliciesById, line.skuId);
    const contribution = (line.unitPriceMinor - skuPolicy.floorPriceMinor) * line.quantity;
    if (
      best === undefined ||
      contribution > best.contribution ||
      (contribution === best.contribution && line.skuId.localeCompare(best.line.skuId) < 0)
    ) {
      best = { line, contribution };
    }
  }
  if (best === undefined) {
    throw new Error("generateCandidates: originalBasket has no lines");
  }
  return best.line;
}

/** Increases the target line's quantity by `additionalQuantity`, at its
 *  existing unit price — a quantity change never touches a unit price, so
 *  it cannot introduce a sub-floor line.
 *
 *  Matches `targetLine` by identity, not by `skuId`: the basket schema
 *  doesn't forbid two lines sharing a `skuId` (e.g. added at different
 *  prices), and matching by `skuId` would bump every such line instead of
 *  just the one selected. */
function buildIncreaseQuantityCandidateBasket(
  originalBasket: Basket,
  targetLine: BasketLine,
  additionalQuantity: number,
): Basket {
  return {
    ...originalBasket,
    lines: originalBasket.lines.map((line) =>
      line === targetLine ? { ...line, quantity: line.quantity + additionalQuantity } : { ...line },
    ),
  };
}

// ---------------------------------------------------------------------------
// Move type 5 — COMMITMENT_SWAP (PRD §8, slots 10-12)
// ---------------------------------------------------------------------------

/** Commitments the policy allows and the basket doesn't already carry, in
 *  the frozen `COMMITMENT_TYPES` enum order — deterministic regardless of
 *  `allowedCommitments`' own array order. */
function findAddableCommitments(
  originalBasket: Basket,
  allowedCommitments: readonly CommitmentValue[],
): CommitmentValue[] {
  const existing = new Set(originalBasket.commitments);
  const valueByType = new Map(allowedCommitments.map((c) => [c.commitmentType, c] as const));
  const result: CommitmentValue[] = [];
  for (const commitmentType of COMMITMENT_TYPES) {
    if (existing.has(commitmentType)) continue;
    const value = valueByType.get(commitmentType);
    if (value) result.push(value);
  }
  return result;
}

/** Adds one commitment to the basket's commitment set. Never touches a
 *  price, so it cannot introduce a sub-floor line. */
function buildCommitmentSwapCandidateBasket(originalBasket: Basket, commitment: CommitmentValue): Basket {
  return {
    ...originalBasket,
    commitments: [...originalBasket.commitments, commitment.commitmentType],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generates the bounded, deterministic, capped candidate set (PRD §8).
 *
 * Same input always produces the identical set in the identical order:
 * every ranking below is a total order (numeric compare with a documented
 * string tie-break), there is no `Math.random()`, no `Date.now()`, and no
 * reliance on object-key or catalogue array iteration order — every
 * grouping here uses a `Map`/`Set` only to look values up, never to decide
 * output order.
 */
export function generateCandidates(input: CandidateGenerationInput): CandidateGenerationResult {
  const { session, policy, skuCatalogue } = input;
  const { originalBasket, counterfactualContributionMinor, roundIndex } = session;

  assertSkuCatalogueIsSane(skuCatalogue, policy.merchantId);
  const skuPoliciesById = indexSkuPoliciesById(skuCatalogue);
  assertOriginalBasketRespectsFloors(originalBasket, skuCatalogue);

  const candidates: GeneratedCandidate[] = [];

  const pushCandidate = (moveType: CandidateMoveType, basket: Basket): void => {
    // Unreachable given the move-type constructors above; kept as defense in
    // depth so a future change to this file fails loudly instead of silently
    // emitting a sub-floor candidate. Extracted to TICKET-106's
    // floor-enforcement module — see this file's module doc.
    assertGeneratedCandidateRespectsFloors(moveType, basket, skuCatalogue);

    const contributionMinor = computeBasketContribution(basket, skuCatalogue, policy.allowedCommitments);
    const contributionDeltaMinor = requireSafeInteger(
      contributionMinor - counterfactualContributionMinor,
      "contributionDeltaMinor",
    );

    candidates.push({
      moveType,
      basket,
      totalMinor: basketTotalMinor(basket),
      contributionMinor,
      contributionDeltaMinor,
      clearsSlowMoving: introducesSlowMovingInventory(basket, originalBasket, skuPoliciesById),
    });
  };

  // 1. PRICE_CONCESSION.
  const concessionFraction = resolveConcessionFraction(policy.concessionCurve, roundIndex);
  pushCandidate(
    "PRICE_CONCESSION",
    buildPriceConcessionCandidate(originalBasket, skuPoliciesById, concessionFraction),
  );

  // 2-4. ADD_SKU.
  const affinityAddable = selectAddableSkus(
    findAffinityAddCandidates(originalBasket, skuCatalogue, skuPoliciesById),
    ADD_SKU_SLOTS,
  );
  for (const sku of affinityAddable) {
    pushCandidate("ADD_SKU", buildAddSkuCandidateBasket(originalBasket, sku));
  }

  // 5-7. ADD_SLOW_MOVING_SKU.
  const slowMovingAddable = selectAddableSkus(
    findSlowMovingAddCandidates(originalBasket, skuCatalogue),
    ADD_SLOW_MOVING_SKU_SLOTS,
  );
  for (const sku of slowMovingAddable) {
    pushCandidate("ADD_SLOW_MOVING_SKU", buildAddSkuCandidateBasket(originalBasket, sku));
  }

  // 8-9. INCREASE_QUANTITY, applied to the same highest-contribution line at
  // +1 and +2 units.
  const topLine = findHighestContributionLine(originalBasket, skuPoliciesById);
  for (let additionalQuantity = 1; additionalQuantity <= INCREASE_QUANTITY_SLOTS; additionalQuantity += 1) {
    pushCandidate(
      "INCREASE_QUANTITY",
      buildIncreaseQuantityCandidateBasket(originalBasket, topLine, additionalQuantity),
    );
  }

  // 10-12. COMMITMENT_SWAP.
  const addableCommitments = findAddableCommitments(originalBasket, policy.allowedCommitments).slice(
    0,
    COMMITMENT_SWAP_SLOTS,
  );
  for (const commitment of addableCommitments) {
    pushCandidate("COMMITMENT_SWAP", buildCommitmentSwapCandidateBasket(originalBasket, commitment));
  }

  // Hard cap — defense in depth. The per-move-type slot budget above already
  // sums to exactly MAX_CANDIDATES, so this is provably a no-op today, but
  // the acceptance criterion is "never returns more than 12," not "the slot
  // budget happens to sum to 12," so the cap is enforced here directly too.
  const cappedCandidates = candidates.slice(0, MAX_CANDIDATES);

  const byMoveType = Object.fromEntries(CANDIDATE_MOVE_TYPES.map((type) => [type, 0])) as Record<
    CandidateMoveType,
    number
  >;
  let selfFundingCount = 0;
  for (const candidate of cappedCandidates) {
    byMoveType[candidate.moveType] += 1;
    if (candidate.contributionDeltaMinor >= 0) selfFundingCount += 1;
  }

  return {
    candidates: cappedCandidates,
    counts: {
      evaluatedCount: cappedCandidates.length,
      selfFundingCount,
      byMoveType,
    },
  };
}
