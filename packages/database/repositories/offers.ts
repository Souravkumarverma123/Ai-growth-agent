import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { evaluateOfferAcceptance } from "@repo/policy";
import type { Basket, ReasonCode } from "@repo/policy/contracts";

import type { SelectOffer } from "../models/offer";

/**
 * TICKET-111 — offer TTL, single-use, and basket binding (PRD §10.2,
 * CONTRACTS.md §2, §8). "Three refusals that make an offer unreplayable,
 * unreassignable, and perishable."
 *
 * Same discipline as `reserveCampaignBudget` / `transitionHoldFromReserved`
 * in `campaign-holds.ts` (ISSUE-004): the mutation that actually matters —
 * setting `consumed_at` — is a single atomic conditional `UPDATE`, never a
 * separate SELECT-then-UPDATE. Two concurrent `acceptOffer` calls against the
 * same offer both issue this statement; Postgres's row-level MVCC (the same
 * EvalPlanQual mechanism `transitionHoldFromReserved`'s doc comment explains)
 * guarantees only the first to commit can match `consumed_at IS NULL` — the
 * second's `WHERE` is re-evaluated against the now-updated row and matches
 * zero rows. No row lock is needed for this guarantee, exactly as none is
 * needed there.
 *
 * The three refusals fold into that one statement's `WHERE` clause:
 *   - `consumed_at IS NULL`  — unreplayable (`OFFER_ALREADY_CONSUMED`)
 *   - `expires_at > $now`    — perishable (`OFFER_EXPIRED`)
 *   - currency/lines/commitments match — unreassignable (`BASKET_MISMATCH`)
 *
 * The basket predicate is NOT a single `basket = $acceptedBasket::jsonb`:
 * jsonb equality compares arrays element-by-element in position order, but
 * `@repo/policy`'s `evaluateOfferAcceptance` (`basketsMatch`) treats
 * `commitments` as a set — "a merchant policy's commitment list carries no
 * meaningful order of its own" — while `lines` order does matter to both
 * (mirrors the exact bundle the offer was minted for). A single jsonb
 * equality on the whole basket would silently disagree with that pure
 * function whenever `commitments` arrives in a different (but
 * set-equivalent) order: the `UPDATE` would match zero rows even though
 * `evaluateOfferAcceptance` calls it a match, and the fallback classifier
 * below would misreport a valid accept as `OFFER_ALREADY_CONSUMED` (it has
 * no other explanation for "classifier says fine, `UPDATE` still failed").
 * So `currency` and `lines` are compared as jsonb directly (order-sensitive,
 * matching `basketsMatch`), while `commitments` is compared via a sorted
 * `jsonb_agg` on both sides (order-insensitive, same as `basketsMatch`'s own
 * `.sort()`) — `COALESCE(..., '[]'::jsonb)` because `jsonb_agg` over zero
 * rows (an empty commitments array) returns SQL `NULL`, not `'[]'`, and
 * `NULL = NULL` is `NULL`, not `TRUE`.
 *
 * When the `UPDATE` matches zero rows, something in that `WHERE` failed, but
 * the statement alone doesn't say which. This module's *only* other query is
 * a plain `SELECT` of the current row, used exclusively to classify the
 * failure via `@repo/policy`'s pure `evaluateOfferAcceptance` — the same rule
 * this module's own `WHERE` clause encodes, so the two can never disagree
 * about the ordering (expiry, then already-consumed, then basket) or the
 * codes. That `SELECT` decides nothing: the `UPDATE` above already decided
 * the real outcome. If the classifier finds nothing wrong yet the `UPDATE`
 * still failed, the only explanation is a concurrent accept that won the
 * race in the gap between the two statements — reported as
 * `OFFER_ALREADY_CONSUMED`, the correct outcome for the losing side of a race
 * (see the ticket's "concurrent double-accept leaves exactly one
 * consumption").
 *
 * Deliberately generic over `NodePgDatabase` (not the real exported `db`),
 * same as every other repository function here, so this runs against
 * `getTestDb()` in tests and the real `db` in production without a fork.
 */

export type OfferAcceptanceRefusalCode = Extract<
  ReasonCode,
  "OFFER_EXPIRED" | "OFFER_ALREADY_CONSUMED" | "BASKET_MISMATCH"
>;

export type AcceptOfferParams = {
  offerId: string;
  /** The basket the buyer is attempting to accept right now. */
  acceptedBasket: Basket;
  /**
   * The instant this accept attempt happens. Optional — defaults to
   * `new Date()` — but callers that need determinism (tests exercising the
   * TTL boundary) supply it explicitly, the same discipline `mintOffer`
   * (`packages/policy/minting/mint.ts`) uses for its own `now` parameter.
   */
  now?: Date;
};

export type AcceptOfferResult =
  | { accepted: true; offer: SelectOffer }
  | { accepted: false; reasonCode: OfferAcceptanceRefusalCode };

/** Raw column set shared by the CAS `UPDATE ... RETURNING` and the fallback `SELECT`. */
const OFFER_COLUMNS = sql`
  id,
  session_id,
  candidate_ref,
  round_index,
  basket,
  total_minor,
  currency,
  tier,
  campaign_spend_minor,
  policy_version,
  status,
  reason_code,
  expires_at,
  consumed_at,
  engine_signature,
  created_at
`;

/**
 * `NodePgDatabase#execute` (unlike a plain `pg.Pool` query, and unlike
 * drizzle's own query builder) hands back timestamp columns as raw Postgres
 * text — e.g. `"2026-01-01 00:10:00.000123"` — not parsed `Date` objects,
 * verified directly against this repo's own test database. `basket` (jsonb)
 * comes back already parsed as a plain object, so only the three timestamp
 * columns need the explicit conversion below.
 *
 * `offers.expires_at` / `consumed_at` / `created_at` are all Postgres
 * `timestamp` (no time zone) columns (frozen schema, `models/offer.ts`), so
 * that raw text carries no zone marker at all — confirmed empirically: it is
 * a space-separated `"YYYY-MM-DD HH:MM:SS[.ffffff]"`, never a `Z` or a `+HH`
 * suffix. Handing that string straight to `new Date(...)` is genuinely
 * dangerous: with no zone marker, JS parses it in the *host process's local*
 * time zone rather than UTC (verified: `new Date("2026-09-05
 * 12:49:32")` on a host set to IST silently comes out ~5.5 hours off from
 * the UTC instant every write in this codebase actually intends). Every
 * timestamp in this system is written and reasoned about as a UTC instant —
 * `mintOffer` and this ticket's own pure `evaluateOfferAcceptance` both take
 * `now: Date` and never touch a local clock — so `toDate` below normalizes
 * the raw text into ISO-8601 and appends `Z` before parsing, forcing the
 * UTC interpretation regardless of the host's own time zone.
 */
type OfferRow = {
  id: string;
  session_id: string;
  candidate_ref: string;
  round_index: number;
  basket: Basket;
  total_minor: number;
  currency: string;
  tier: number;
  campaign_spend_minor: number;
  policy_version: number;
  status: SelectOffer["status"];
  reason_code: SelectOffer["reasonCode"];
  expires_at: string;
  consumed_at: string | null;
  engine_signature: string;
  created_at: string | null;
};

function toDate(value: string): Date;
function toDate(value: string | null): Date | null;
function toDate(value: string | null): Date | null {
  if (value === null) return null;
  // See the module doc above `OfferRow`: raw Postgres `timestamp` text has
  // no zone marker, so force the UTC interpretation this codebase always
  // intends rather than letting `Date` fall back to the host's local zone.
  const hasZoneMarker = /[Zz]|[+-]\d\d(:\d\d)?$/.test(value);
  const isoLike = value.replace(" ", "T");
  return new Date(hasZoneMarker ? isoLike : `${isoLike}Z`);
}

function toSelectOffer(row: OfferRow): SelectOffer {
  return {
    id: row.id,
    sessionId: row.session_id,
    candidateRef: row.candidate_ref,
    roundIndex: row.round_index,
    basket: row.basket,
    totalMinor: row.total_minor,
    currency: row.currency,
    tier: row.tier,
    campaignSpendMinor: row.campaign_spend_minor,
    policyVersion: row.policy_version,
    status: row.status,
    reasonCode: row.reason_code,
    expiresAt: toDate(row.expires_at),
    consumedAt: toDate(row.consumed_at),
    engineSignature: row.engine_signature,
    createdAt: toDate(row.created_at),
  };
}

/**
 * Attempts to consume `offerId` on behalf of `acceptedBasket`. Succeeds
 * exactly once per offer, ever — see module doc for the atomic `WHERE`
 * clause and why the classification `SELECT` below never participates in
 * the actual decision.
 */
export async function acceptOffer(
  database: NodePgDatabase,
  params: AcceptOfferParams,
): Promise<AcceptOfferResult> {
  const { offerId, acceptedBasket } = params;
  const now = params.now ?? new Date();
  const acceptedLinesJson = JSON.stringify(acceptedBasket.lines);
  const acceptedCommitmentsJson = JSON.stringify(acceptedBasket.commitments);
  // `offers.expires_at` / `consumed_at` are `timestamp` (no zone) columns.
  // Drizzle's own column mapping for that type (`pg-core/columns/timestamp.ts`,
  // `mapToDriverValue`) always sends `value.toISOString()` — never a raw
  // `Date` object — precisely because handing a raw `Date` to `pg` for a
  // parameter compared/assigned against a zone-less column is NOT
  // guaranteed UTC-consistent (verified directly against this repo's own
  // test database: it round-trips through the *host process's* local time
  // zone instead). Every raw-SQL use of `now` below follows that same
  // `toISOString()` discipline so this module's timestamps are exactly as
  // UTC-safe as one written through the query builder.
  const nowIso = now.toISOString();

  return database.transaction(async (tx): Promise<AcceptOfferResult> => {
    // The single atomic compare-and-set. Only a caller whose accept lands
    // while the offer is still unconsumed, unexpired, and basket-exact can
    // ever see a row come back here.
    const updateResult = await tx.execute<OfferRow>(sql`
      UPDATE offers
      SET consumed_at = ${nowIso}
      WHERE id = ${offerId}
        AND consumed_at IS NULL
        AND expires_at > ${nowIso}
        AND basket->>'currency' = ${acceptedBasket.currency}
        AND basket->'lines' = ${acceptedLinesJson}::jsonb
        AND COALESCE(
              (SELECT jsonb_agg(c ORDER BY c) FROM jsonb_array_elements_text(basket->'commitments') AS c),
              '[]'::jsonb
            ) = COALESCE(
              (SELECT jsonb_agg(c ORDER BY c) FROM jsonb_array_elements_text(${acceptedCommitmentsJson}::jsonb) AS c),
              '[]'::jsonb
            )
      RETURNING ${OFFER_COLUMNS}
    `);

    const updatedRow = updateResult.rows[0];
    if (updatedRow) {
      return { accepted: true, offer: toSelectOffer(updatedRow) };
    }

    // The CAS above matched nothing. This SELECT is read-only diagnosis, not
    // part of the enforcement: it only decides which of the three refusal
    // codes to report, using the exact same rule `@repo/policy` exposes.
    const lookupResult = await tx.execute<OfferRow>(sql`
      SELECT ${OFFER_COLUMNS} FROM offers WHERE id = ${offerId}
    `);

    const currentRow = lookupResult.rows[0];
    if (!currentRow) {
      // No reason code in the closed 28-member enum covers "no such offer" —
      // same fail-closed-with-a-throw discipline as mintOffer's forged/
      // out-of-set candidateId case (packages/policy/minting/mint.ts).
      throw new Error(`acceptOffer: no offer with id "${offerId}"`);
    }

    const evaluation = evaluateOfferAcceptance({
      offer: {
        expiresAt: toDate(currentRow.expires_at),
        consumedAt: toDate(currentRow.consumed_at),
        basket: currentRow.basket,
      },
      acceptedBasket,
      now,
    });

    if (evaluation.accepted) {
      // The classifier sees nothing wrong, yet the CAS still matched zero
      // rows — the only way that happens is a concurrent accept that won
      // the race in the gap between the two statements above: consumed_at
      // moved from null to non-null right underneath this one.
      return { accepted: false, reasonCode: "OFFER_ALREADY_CONSUMED" };
    }

    return { accepted: false, reasonCode: evaluation.reasonCode };
  });
}
