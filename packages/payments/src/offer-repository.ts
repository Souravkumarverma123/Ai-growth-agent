import { eq } from "@repo/database";
import { db } from "@repo/database";
import { offersTable, type SelectOffer } from "@repo/database/models/offer";

/**
 * TICKET-301 (CONTRACTS.md §2, B3) — read-only lookup of the persisted offer
 * row that `createOrder` (see `../index.ts`) derives every monetary fact
 * from.
 *
 * This is deliberately NOT an addition to `packages/database/repositories/`:
 * TICKET-111 is concurrently adding an `offers.ts` repository there (with
 * transactional consume-once logic) on its own branch, and a same-file
 * collision between the two PRs is exactly what this ticket's brief asked to
 * avoid. This module only reads — it never writes, never marks an offer
 * consumed, and owns nothing TICKET-111 owns. It is fine for
 * `packages/payments` to own this one read-only query even though the
 * *table* (`offersTable`) is defined in `packages/database`.
 *
 * `createOrder` is the only public entry point in this package (B3,
 * CONTRACTS.md §2) — this function is what lets it have exactly one
 * parameter (`offerId`) while still reading amount, currency, basket, tier
 * and campaign spend from somewhere authoritative instead of from a caller.
 */
export async function getOfferById(offerId: string): Promise<SelectOffer> {
  const rows = await db.select().from(offersTable).where(eq(offersTable.id, offerId)).limit(1);
  const offer = rows[0];

  if (!offer) {
    throw new Error(`createOrder: no offer found for offerId "${offerId}"`);
  }

  return offer;
}
