import type { Basket, Offer, SkuPolicy } from "@repo/policy/contracts";

import { composeOfferMessage } from "./merchant-model";
import type { MessageFrame } from "@repo/policy/contracts";

/**
 * TICKET-204 — every function here builds a piece of the buyer-facing
 * response shape frozen by TICKET-006 (`negotiation/route.ts`'s
 * `publicBasketLineSchema` / `publicOfferSchema`).
 *
 * ============================================================================
 * THE ONE RULE THAT MATTERS MOST IN THIS FILE (CONTRACTS.md §9)
 * ============================================================================
 * "Nothing on this response surface may ever serialize a floor price, an
 * available campaign budget figure, a per-deal cap, or a concession-curve
 * value." Every mapper below reads from `Offer`/`Basket`/`SkuPolicy` and
 * writes only fields the frozen output schemas actually declare — never a
 * `...spread` of an internal object, precisely because a spread is exactly
 * how a field like `floorPriceMinor` (present on `SkuPolicy`, never on the
 * public basket line schema) would leak silently the moment someone adds a
 * new internal field upstream. See `packages/trpc/tests/response-shape.
 * test.ts` for the behavioural proof this file is honoring that rule, over a
 * range of fixtures — not just this file's own good intentions.
 */

export type PublicBasketLine = {
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
};

function requireSkuPolicy(skuById: Map<string, SkuPolicy>, skuId: string): SkuPolicy {
  const skuPolicy = skuById.get(skuId);
  if (!skuPolicy) {
    throw new Error(`toPublicBasketLines: no SKU policy supplied for skuId "${skuId}"`);
  }
  return skuPolicy;
}

export function toPublicBasketLines(basket: Basket, skuCatalogue: readonly SkuPolicy[]): PublicBasketLine[] {
  const skuById = new Map(skuCatalogue.map((sku) => [sku.skuId, sku] as const));
  return basket.lines.map((line) => {
    const skuPolicy = requireSkuPolicy(skuById, line.skuId);
    return {
      sku: skuPolicy.sku,
      name: skuPolicy.name,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    };
  });
}

export type PublicOffer = {
  offerId: string;
  lines: PublicBasketLine[];
  commitments: string[];
  totalMinor: number;
  currency: "INR";
  expiresAt: string;
  message: string;
};

/**
 * Builds the buyer-visible offer view. Deliberately field-by-field (never
 * `...offer`): `offer` (the frozen `Offer` type,
 * `packages/policy/contracts/negotiation.ts`) carries `tier`,
 * `campaignSpendMinor`, `policyVersion`, `reasonCode`, `candidateId`, and
 * `engineSignature` — every one of them merchant-side or engine-internal,
 * none of them in `publicOfferSchema`, and none of them ever written below.
 */
export function toPublicOffer(
  offer: Offer,
  skuCatalogue: readonly SkuPolicy[],
  messageFrame: MessageFrame,
): PublicOffer {
  return {
    offerId: offer.offerId,
    lines: toPublicBasketLines(offer.basket, skuCatalogue),
    commitments: [...offer.basket.commitments],
    totalMinor: offer.totalMinor,
    currency: "INR",
    expiresAt: offer.expiresAt.toISOString(),
    message: composeOfferMessage(messageFrame),
  };
}
