import type { Basket, Candidate } from "../contracts/negotiation";
import type { SkuPolicy } from "../contracts/merchant-policy";
import type { MinorUnits } from "../contracts/money";
import type { ReasonCode } from "../contracts/reason-codes";

/**
 * TICKET-106 — floor enforcement and the defensive mint-time assertion
 * (PRD §8, §14, §17 row 9; CONTRACTS.md §6; state-machine.ts's
 * `SUB_FLOOR_CANDIDATE_DETECTED` / `FLOOR_BREACH` row).
 *
 * ============================================================================
 * "ALREADY TRUE" — THIS FILE EXTRACTS, IT DOES NOT REBUILD
 * ============================================================================
 * TICKET-103's generator (`./candidates.ts`) already made floors a
 * GENERATION CONSTRAINT rather than a post-hoc filter: every move type
 * constructs prices so a sub-floor line cannot occur, and the generator
 * additionally refused to run at all from an already-corrupted
 * `originalBasket`, plus re-asserted every constructed candidate as defense
 * in depth. That arithmetic and those assertions are moved here verbatim —
 * `assertSkuCatalogueIsSane`, `assertOriginalBasketRespectsFloors`, and the
 * per-line check `pushCandidate` used to run inline are now
 * `assertGeneratedCandidateRespectsFloors` below. `candidates.ts` imports all
 * three from this module instead of defining them; its own test suite is
 * unchanged and must stay green, because nothing about *when* or *why* these
 * checks run has changed — only *where* they live.
 *
 * ============================================================================
 * THE ONE THING TICKET-103 EXPLICITLY DEFERRED: A MINT-TIME ASSERTION
 * ============================================================================
 * `FLOOR_BREACH` (reason-codes.ts) is documented as "deliberately unreachable
 * in correct operation... if this ever fires, something is badly wrong and
 * the session halts" — a defensive assertion, not a generation-time bug
 * check. `candidates.ts`'s module doc was explicit that this belongs at mint
 * time (TICKET-106), not in the generator. `assertNoFloorBreach` below is
 * that assertion: a pure function taking the frozen `Candidate` shape (as it
 * would exist once TICKET-110's minting constructs one) plus the SKU
 * catalogue, that a future caller — eventually TICKET-110's minting path and
 * TICKET-402's transition wiring — runs immediately before a candidate
 * becomes an `Offer`. It is reachable only by a bug upstream of this file,
 * and it halts rather than continues: it THROWS a distinctive
 * {@link FloorBreachError} (never returns a tagged failure) — matching this
 * codebase's existing "throw for a should-never-happen bug, return a tagged
 * result for an expected business outcome" convention (contrast
 * `evaluatePerDealCap`/`evaluateRoundCap`, which return tagged decisions
 * because clearing or missing a cap is an ordinary business outcome, not a
 * bug). `FloorBreachError` carries `reasonCode: "FLOOR_BREACH"` so a caller
 * can map it onto state-machine.ts's `{ from: "*", event:
 * "SUB_FLOOR_CANDIDATE_DETECTED", to: "HALTED", reasonCode: "FLOOR_BREACH" }`
 * row without re-deriving the code from the error's message text.
 */

// ---------------------------------------------------------------------------
// Shared lookup
// ---------------------------------------------------------------------------

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
    throw new Error(`floor-enforcement: no SKU policy supplied for skuId "${skuId}"`);
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Catalogue sanity (moved from candidates.ts, unchanged)
// ---------------------------------------------------------------------------

/**
 * Domain invariants not enforced by the zod schema, all fatal to floor
 * reasoning if violated:
 *
 *  - a floor above list (both are independently just non-negative integers)
 *    would make every headroom calculation nonsensical — fails closed rather
 *    than silently producing a candidate priced above list "to stay above
 *    floor";
 *  - a duplicate `skuId` would make this module's `Map`-based lookups
 *    silently disagree with any raw-array scan elsewhere in the generator —
 *    one candidate build could price/floor-check off one record while
 *    everything routed through the map uses another;
 *  - a SKU from another merchant would let generation offer, price, and
 *    floor-check a basket line this policy has no authority over.
 */
export function assertSkuCatalogueIsSane(skuCatalogue: readonly SkuPolicy[], merchantId: string): void {
  const seenSkuIds = new Set<string>();
  for (const sku of skuCatalogue) {
    if (sku.merchantId !== merchantId) {
      throw new Error(
        `floor-enforcement: skuId "${sku.skuId}" belongs to merchantId "${sku.merchantId}", not policy merchantId "${merchantId}"`,
      );
    }
    if (seenSkuIds.has(sku.skuId)) {
      throw new Error(`floor-enforcement: skuCatalogue contains duplicate skuId "${sku.skuId}"`);
    }
    seenSkuIds.add(sku.skuId);
    if (sku.floorPriceMinor > sku.listPriceMinor) {
      throw new Error(
        `floor-enforcement: skuId "${sku.skuId}" has floorPriceMinor (${sku.floorPriceMinor}) above listPriceMinor (${sku.listPriceMinor})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Floor breach detection — the shared primitive every assertion below uses
// ---------------------------------------------------------------------------

export type FloorBreach = {
  skuId: string;
  unitPriceMinor: MinorUnits;
  floorPriceMinor: MinorUnits;
};

/**
 * Every basket line whose `unitPriceMinor` sits below its SKU's floor.
 * Empty when the basket is clean. Fails closed if a line references a SKU
 * absent from `skuCatalogue` (CONTRACTS.md §6) rather than silently skipping
 * it — an unresolvable line is exactly the kind of corrupted input this
 * module exists to refuse, not to shrug past.
 */
export function findFloorBreaches(basket: Basket, skuCatalogue: readonly SkuPolicy[]): FloorBreach[] {
  const skuPoliciesById = indexSkuPoliciesById(skuCatalogue);
  const breaches: FloorBreach[] = [];
  for (const line of basket.lines) {
    const skuPolicy = requireSkuPolicy(skuPoliciesById, line.skuId);
    if (line.unitPriceMinor < skuPolicy.floorPriceMinor) {
      breaches.push({
        skuId: line.skuId,
        unitPriceMinor: line.unitPriceMinor,
        floorPriceMinor: skuPolicy.floorPriceMinor,
      });
    }
  }
  return breaches;
}

// ---------------------------------------------------------------------------
// Generation-time assertions (moved from candidates.ts, unchanged behaviour)
// ---------------------------------------------------------------------------

/**
 * Refuses to generate from an already-corrupted session: if `originalBasket`
 * itself carries a sub-floor line, every move type that carries that line
 * forward unchanged (ADD_SKU, ADD_SLOW_MOVING_SKU, INCREASE_QUANTITY,
 * COMMITMENT_SWAP all do) would otherwise silently inherit the breach. This
 * is not the generator's own bug surface — eligibility and whatever wrote
 * `originalBasket` are upstream of it — but failing loudly here is cheap and
 * keeps "no generated candidate prices any line below its floor" true
 * unconditionally, not just for the one move type that constructs new
 * prices.
 */
export function assertOriginalBasketRespectsFloors(
  originalBasket: Basket,
  skuCatalogue: readonly SkuPolicy[],
): void {
  const [firstBreach] = findFloorBreaches(originalBasket, skuCatalogue);
  if (firstBreach) {
    throw new Error(
      `generateCandidates: originalBasket line for skuId "${firstBreach.skuId}" is already below floor (unitPriceMinor=${firstBreach.unitPriceMinor}, floorPriceMinor=${firstBreach.floorPriceMinor})`,
    );
  }
}

/**
 * Defense in depth for a single constructed candidate, run by
 * `candidates.ts`'s `pushCandidate` before accepting any candidate into the
 * result set. Unreachable given the move-type constructors in that file —
 * every one of them either carries a line forward unchanged or floors its
 * own release at that line's headroom — but kept so a future change to that
 * file fails loudly instead of silently emitting a sub-floor candidate.
 */
export function assertGeneratedCandidateRespectsFloors(
  moveType: string,
  basket: Basket,
  skuCatalogue: readonly SkuPolicy[],
): void {
  const [firstBreach] = findFloorBreaches(basket, skuCatalogue);
  if (firstBreach) {
    throw new Error(
      `generateCandidates: refusing to emit a ${moveType} candidate pricing skuId "${firstBreach.skuId}" below its floor`,
    );
  }
}

// ---------------------------------------------------------------------------
// The defensive mint-time assertion (this ticket's one new piece)
// ---------------------------------------------------------------------------

/**
 * Distinctive error type for a `FLOOR_BREACH`. Never caught and silenced —
 * PRD §17 row 9 and state-machine.ts's `SUB_FLOOR_CANDIDATE_DETECTED` row are
 * explicit that the session halts. Carrying `reasonCode` lets a caller map
 * this onto the ledger's reason code without parsing the message.
 */
export class FloorBreachError extends Error {
  readonly reasonCode: Extract<ReasonCode, "FLOOR_BREACH"> = "FLOOR_BREACH";
  readonly candidateId: string;
  readonly breaches: readonly FloorBreach[];

  constructor(candidateId: string, breaches: readonly FloorBreach[]) {
    const detail = breaches
      .map((b) => `skuId "${b.skuId}" (unitPriceMinor=${b.unitPriceMinor} < floorPriceMinor=${b.floorPriceMinor})`)
      .join("; ");
    super(`FLOOR_BREACH: candidate "${candidateId}" prices ${breaches.length} line(s) below floor: ${detail}`);
    this.name = "FloorBreachError";
    this.candidateId = candidateId;
    this.breaches = breaches;
  }
}

/**
 * The defensive assertion at mint time (TICKET-106's acceptance criterion:
 * "a defensive assertion... that halts the session with FLOOR_BREACH if a
 * sub-floor line is ever observed"). Reachable only by a bug — the generator
 * this ticket also hardens cannot construct a sub-floor candidate — so this
 * function's entire purpose is to halt loudly if one somehow reaches mint
 * time anyway, rather than to filter anything in the ordinary path.
 *
 * Deliberately takes the frozen `Candidate` shape, not `GeneratedCandidate`:
 * this runs at mint time, downstream of TICKET-104's tiering, on the object
 * that is about to become an `Offer` — the last point before a sub-floor
 * price could reach money.
 *
 * As the last line of defense, this cannot trust `skuCatalogue`'s integrity
 * any more than `candidates.ts` does: `findFloorBreaches` resolves each line
 * through a last-write-wins `Map`, so a duplicate or cross-merchant entry
 * could silently substitute a lower floor and let a genuinely sub-floor
 * candidate pass. `assertSkuCatalogueIsSane` (the same check generation-time
 * already runs) closes that gap here too, so the caller's `merchantId` is
 * required, not optional.
 */
export function assertNoFloorBreach(
  candidate: Candidate,
  skuCatalogue: readonly SkuPolicy[],
  merchantId: string,
): void {
  assertSkuCatalogueIsSane(skuCatalogue, merchantId);
  const breaches = findFloorBreaches(candidate.basket, skuCatalogue);
  if (breaches.length > 0) {
    throw new FloorBreachError(candidate.candidateId, breaches);
  }
}
